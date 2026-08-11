/**
 * The sanitizer gate.
 *
 * Promotion crosses a privacy boundary, and it is the one operation in KNS that
 * cannot be undone by deleting a file: once content is in a shared repository's
 * history, it is out. So this gate is a hard failure rather than a warning, it has no
 * override flag, and a detector that throws blocks the promotion just as surely as one
 * that matches.
 *
 * Secrets block. Personal data is redacted and flagged for a human, because redaction
 * can change meaning and a person should see what was changed before it ships.
 *
 * The detectors are patterns, so they are not complete. The human gate and the
 * pull-request review are the compensating controls, and every miss found in practice
 * becomes a permanent case in the adversarial corpus.
 *
 * @module
 */

/** What a finding means for the promotion. */
export type Severity = 'secret' | 'pii';

/** One detection. */
export interface Finding {
  /** Detector that fired. */
  rule: string;
  /** Whether this blocks or merely redacts. */
  severity: Severity;
  /** 1-based line the match started on. */
  line: number;
  /** A safe description of what matched. Never the secret itself. */
  preview: string;
}

/** Outcome of sanitising a document. */
export interface SanitizeResult {
  /** True when the document must not be promoted as it stands. */
  blocked: boolean;
  /** Every detection, in document order. */
  findings: Finding[];
  /** Text with personal data redacted. Empty when blocked. */
  redacted: string;
}

/** Options for a sanitiser run. */
export interface SanitizeOptions {
  /** Additional terms that must never be promoted, e.g. confidential vocabulary. */
  blocklist?: readonly string[];
  /** Person names to redact, typically drawn from local people pages. */
  names?: readonly string[];
}

/** A pattern-based detector. */
interface Detector {
  rule: string;
  severity: Severity;
  pattern: RegExp;
}

/**
 * Values that are documented placeholders rather than live credentials.
 *
 * Anchored on purpose. An unanchored test — "does this contain the word example" —
 * lets any secret through by having the word somewhere in it, which is both an
 * accidental foot-gun and a trivial deliberate bypass. A placeholder must *be* the
 * value, not merely mention one.
 */
const PLACEHOLDER_VALUE =
  /^(?:<[^>]*>|\$\{[^}]*\}|your[_-][A-Za-z0-9_-]*|x{4,}|changeme|placeholder|redacted|example[A-Za-z0-9_-]*|dummy|fake)$/i;

/**
 * Report whether a matched value is a documented placeholder.
 *
 * @param value - The matched text.
 * @returns True when it is a placeholder rather than a credential.
 */
export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  // Vendors document example credentials with an EXAMPLE suffix, e.g. AWS.
  return PLACEHOLDER_VALUE.test(trimmed) || /EXAMPLE$/.test(trimmed);
}

/** Shapes that look high-entropy but carry no secret. */
const BENIGN_HIGH_ENTROPY = [
  /^[0-9a-f]{7,8}$/i, // short git sha
  /^[0-9a-f]{40}$/i, // sha-1
  /^[0-9a-f]{64}$/i, // sha-256
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
];

/** Secret detectors. Any match blocks the promotion. */
const SECRET_DETECTORS: Detector[] = [
  { rule: 'aws-access-key-id', severity: 'secret', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA)[0-9A-Z]{16}\b/g },
  { rule: 'github-token', severity: 'secret', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { rule: 'slack-token', severity: 'secret', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: 'google-api-key', severity: 'secret', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: 'stripe-key', severity: 'secret', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { rule: 'private-key-block', severity: 'secret', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: 'json-web-token', severity: 'secret', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    rule: 'bearer-token',
    severity: 'secret',
    pattern: /\b(?:bearer|authorization:\s*bearer)\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi,
  },
  {
    rule: 'credential-assignment',
    severity: 'secret',
    pattern:
      /\b(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[=:]\s*["']?([^\s"']{8,})["']?/gi,
  },
];

/** Personal-data detectors. Matches are redacted and flagged. */
const PII_DETECTORS: Detector[] = [
  { rule: 'email', severity: 'pii', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    rule: 'phone',
    severity: 'pii',
    pattern: /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
  },
  {
    rule: 'postal-address',
    severity: 'pii',
    pattern: /\b\d{1,5}\s+[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr)\b\.?/g,
  },
];

/**
 * Shannon entropy of a string, in bits per character.
 *
 * @param value - Candidate token.
 * @returns Entropy in bits per character.
 */
export function entropy(value: string): number {
  if (value.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);

  let total = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    total -= probability * Math.log2(probability);
  }
  return total;
}

/**
 * Decide whether a token looks like an unrecognised credential.
 *
 * Deliberately narrow. A detector that fires on every git SHA would be turned off
 * within a day, and a sanitiser nobody trusts is worse than none.
 *
 * @param token - Candidate token.
 * @returns True when the token is long, dense, and not a known benign shape.
 */
export function looksLikeSecret(token: string): boolean {
  if (token.length < 32) return false;
  if (isPlaceholder(token)) return false;
  if (BENIGN_HIGH_ENTROPY.some((pattern) => pattern.test(token))) return false;

  const classes =
    (/[a-z]/.test(token) ? 1 : 0) +
    (/[A-Z]/.test(token) ? 1 : 0) +
    (/[0-9]/.test(token) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(token) ? 1 : 0);
  if (classes < 3) return false;

  return entropy(token) >= 4;
}

/** Line number of an offset within a text. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index && position < text.length; position += 1) {
    if (text[position] === '\n') line += 1;
  }
  return line;
}

/** A preview that identifies the match without reproducing it. */
function previewOf(match: string, severity: Severity): string {
  if (severity === 'pii') return `${match.slice(0, 3)}…${match.slice(-2)} (${match.length} chars)`;
  return `${match.length} characters starting "${match.slice(0, 4)}"`;
}

/**
 * Scan and sanitise a document.
 *
 * @param text - Document text, frontmatter included.
 * @param options - Extra blocklist terms and person names.
 * @returns Findings, the blocked verdict, and the redacted text.
 */
export function sanitize(text: string, options: SanitizeOptions = {}): SanitizeResult {
  const findings: Finding[] = [];

  try {
    for (const detector of [...SECRET_DETECTORS, ...PII_DETECTORS]) {
      for (const match of text.matchAll(detector.pattern)) {
        const value = match[0];
        // For an assignment the capture is the credential itself; for everything else
        // the whole match is. Only the credential is tested for placeholder-ness.
        const credential = match[1] ?? value;
        if (detector.severity === 'secret' && isPlaceholder(credential)) continue;

        findings.push({
          rule: detector.rule,
          severity: detector.severity,
          line: lineOf(text, match.index),
          preview: previewOf(value, detector.severity),
        });
      }
    }

    for (const token of text.match(/[A-Za-z0-9+/=_-]{32,}/g) ?? []) {
      if (!looksLikeSecret(token)) continue;
      findings.push({
        rule: 'high-entropy-token',
        severity: 'secret',
        line: lineOf(text, text.indexOf(token)),
        preview: previewOf(token, 'secret'),
      });
    }

    for (const term of options.blocklist ?? []) {
      if (term.trim() === '') continue;
      const index = text.toLowerCase().indexOf(term.toLowerCase());
      if (index === -1) continue;
      findings.push({
        rule: 'blocklisted-term',
        severity: 'secret',
        line: lineOf(text, index),
        preview: `blocklisted term "${term}"`,
      });
    }

    let redacted = text;
    for (const name of options.names ?? []) {
      if (name.trim() === '') continue;
      const index = redacted.toLowerCase().indexOf(name.toLowerCase());
      if (index === -1) continue;
      findings.push({
        rule: 'person-name',
        severity: 'pii',
        line: lineOf(redacted, index),
        preview: `name "${name}"`,
      });
      redacted = redacted.split(name).join('[redacted:person-name]');
    }

    const blocked = findings.some((finding) => finding.severity === 'secret');
    if (blocked) {
      // Nothing to hand back: a blocked document is not promotable in any form, and
      // returning a partly-cleaned copy would invite someone to ship it anyway.
      return { blocked: true, findings, redacted: '' };
    }

    for (const detector of PII_DETECTORS) {
      redacted = redacted.replace(detector.pattern, `[redacted:${detector.rule}]`);
    }

    return { blocked: false, findings, redacted };
  } catch (error) {
    // Fail closed. A detector that crashed has told us nothing about the content, and
    // "we could not check" must never read as "it is clean".
    return {
      blocked: true,
      findings: [
        {
          rule: 'sanitizer-error',
          severity: 'secret',
          line: 1,
          preview: `sanitizer failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      redacted: '',
    };
  }
}

/**
 * Summarise findings for a human.
 *
 * @param result - Sanitiser outcome.
 * @returns One line per finding, plus a verdict.
 */
export function formatFindings(result: SanitizeResult): string {
  if (result.findings.length === 0) return 'sanitizer: clean';

  const lines = result.findings.map(
    (finding) => `  line ${finding.line} [${finding.severity}/${finding.rule}] ${finding.preview}`,
  );
  lines.unshift(result.blocked ? 'sanitizer: BLOCKED' : 'sanitizer: redacted');
  return lines.join('\n');
}
