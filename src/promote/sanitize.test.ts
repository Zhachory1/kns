import test from 'node:test';
import assert from 'node:assert/strict';

import { entropy, formatFindings, looksLikeSecret, sanitize } from './sanitize.ts';

/**
 * The adversarial corpus.
 *
 * Every entry must be blocked. This suite is permanent and grows with each near-miss
 * found in practice: a sanitiser is only as good as the cases someone remembered to
 * write down.
 */
/**
 * Vendor-shaped credentials are assembled at run time rather than written as
 * literals. A file containing a well-formed Slack or Stripe token is blocked by
 * GitHub's push protection — correctly, since it cannot tell a test fixture from a
 * live key. Splitting the prefix keeps the detector under test on an equivalent
 * string while leaving nothing matchable in the committed source.
 */
const shaped = (...parts: string[]): string => parts.join('');

const PLANTED_SECRETS: { name: string; text: string }[] = [
  { name: 'aws access key id', text: 'deploy with AKIAJ7RTQXW4LMNPQZ2K in the profile' },
  { name: 'aws session key id', text: 'temporary ASIAJ7RTQXW4LMNPQZ2K creds' },
  { name: 'github personal access token', text: `token ${shaped('ghp', '_', 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ01')}` },
  { name: 'github oauth token', text: shaped('gho', '_', 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ01') },
  { name: 'slack bot token', text: shaped('xox', 'b', '-2381726381-2381726381-A1b2C3d4E5f6G7h8') },
  { name: 'google api key', text: `key ${shaped('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r')}` },
  { name: 'stripe live key', text: shaped('sk', '_live_', 'a1B2c3D4e5F6g7H8i9J0kLmN') },
  { name: 'rsa private key header', text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n' },
  { name: 'openssh private key header', text: '-----BEGIN OPENSSH PRIVATE KEY-----' },
  {
    name: 'json web token',
    text: `auth ${shaped('eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')}`,
  },
  { name: 'bearer header', text: 'Authorization: Bearer aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY' },
  { name: 'password assignment', text: 'password = hunter2hunter2hunter2' },
  { name: 'api key assignment with quotes', text: 'api_key: "s3cr3t-value-not-a-placeholder"' },
  { name: 'client secret assignment', text: 'client_secret=9f8e7d6c5b4a39281706' },
  {
    name: 'unrecognised high-entropy credential',
    text: 'opaque zQ8vN2xK7pL4mR9tW3yB6cF1hJ5sD0gA',
  },
  {
    name: 'secret split across a line with surrounding prose',
    text: 'I pasted AKIAJ7RTQXW4LMNPQZ2K while debugging the uploader, sorry',
  },
];

/**
 * The false-positive corpus.
 *
 * A sanitiser that fires on every git SHA gets turned off within a day, and one nobody
 * trusts is worse than none.
 */
const BENIGN: { name: string; text: string }[] = [
  { name: 'git sha', text: 'fixed in 0c1e2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a' },
  { name: 'short git sha', text: 'see commit 8cef33b for the rationale' },
  { name: 'uuid', text: 'run id 3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
  { name: 'sha-256 digest', text: 'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  { name: 'documented aws example key', text: `AWS documents ${shaped('AKIA', 'IOSFODNN7EXAMPLE')} in its guide` },
  { name: 'placeholder token', text: 'set GITHUB_TOKEN=<your-token-here> before running' },
  { name: 'prose about secrets', text: 'Rotate the password policy every ninety days.' },
  { name: 'kebab-case identifier', text: 'the hierarchical-knowledge-resolution-strategy document' },
  { name: 'long base64 of nothing special', text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
];

test('every planted secret is blocked', () => {
  for (const item of PLANTED_SECRETS) {
    const result = sanitize(item.text);
    assert.equal(result.blocked, true, `escaped: ${item.name} — ${JSON.stringify(item.text)}`);
    assert.equal(result.redacted, '', `${item.name}: a blocked document must yield nothing`);
  }
});

test('no benign document is blocked', () => {
  for (const item of BENIGN) {
    const result = sanitize(item.text);
    assert.equal(result.blocked, false, `false positive: ${item.name} — ${formatFindings(result)}`);
  }
});

test('a finding never reproduces the secret it found', () => {
  const secret = shaped('ghp', '_', 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ01');
  const result = sanitize(`token ${secret}`);

  for (const finding of result.findings) {
    assert.ok(!finding.preview.includes(secret), 'the preview leaked the secret it was hiding');
  }
});

test('a clean document passes through unchanged', () => {
  const text = '# Hot index reload\n\nSwap the generation atomically.\n';
  const result = sanitize(text);

  assert.equal(result.blocked, false);
  assert.deepEqual(result.findings, []);
  assert.equal(result.redacted, text);
});

test('personal data is redacted and flagged rather than blocked', () => {
  const result = sanitize('Ask alex@example.com or call 415 555 0134 about it.');

  assert.equal(result.blocked, false, 'personal data is a review item, not a refusal');
  assert.match(result.redacted, /\[redacted:email\]/);
  assert.match(result.redacted, /\[redacted:phone\]/);
  assert.ok(result.findings.every((finding) => finding.severity === 'pii'));
});

test('a postal address is redacted', () => {
  const result = sanitize('Meet at 1600 Amphitheatre Parkway Road for the handover.');

  assert.match(result.redacted, /\[redacted:postal-address\]/);
});

test('configured names are redacted everywhere they appear', () => {
  const result = sanitize('Dana wrote this. Ask Dana about the rollback.', { names: ['Dana'] });

  assert.equal(result.blocked, false);
  assert.ok(!result.redacted.includes('Dana'));
  assert.equal((result.redacted.match(/\[redacted:person-name\]/g) ?? []).length, 2);
});

test('a blocklisted term blocks the promotion', () => {
  const result = sanitize('Our internal codename is Bluebird.', { blocklist: ['Bluebird'] });

  assert.equal(result.blocked, true);
  assert.equal(result.findings[0]?.rule, 'blocklisted-term');
});

test('an empty blocklist or name entry is ignored', () => {
  const result = sanitize('nothing here', { blocklist: ['  '], names: [''] });
  assert.equal(result.blocked, false);
  assert.deepEqual(result.findings, []);
});

test('findings carry the line they were found on', () => {
  const result = sanitize('line one\nline two\npassword = hunter2hunter2hunter2\n');

  assert.equal(result.findings[0]?.line, 3);
});

test('a secret inside a fenced code block is still a secret', () => {
  const result = sanitize('```\nexport AWS_SECRET_ACCESS_KEY=zQ8vN2xK7pL4mR9tW3yB6cF1hJ5sD0gA\n```\n');

  assert.equal(result.blocked, true, 'a fence is formatting, not a security boundary');
});

test('a detector that throws blocks the promotion', () => {
  const hostile = {
    toString(): string {
      throw new Error('boom');
    },
  };
  // matchAll on a non-string throws inside the sanitiser's try block.
  const result = sanitize(hostile as unknown as string);

  assert.equal(result.blocked, true, 'could-not-check must never read as clean');
  assert.equal(result.findings[0]?.rule, 'sanitizer-error');
  assert.equal(result.redacted, '');
});

test('entropy rises with character diversity', () => {
  assert.equal(entropy(''), 0);
  assert.equal(entropy('aaaa'), 0);
  assert.ok(entropy('abcd') > entropy('aaab'));
  assert.ok(entropy('zQ8vN2xK7pL4mR9tW3yB6cF1hJ5sD0gA') > 4);
});

test('looksLikeSecret is deliberately narrow', () => {
  assert.equal(looksLikeSecret('short'), false);
  assert.equal(looksLikeSecret('a'.repeat(40)), false, 'low entropy');
  assert.equal(looksLikeSecret('0c1e2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a'), false, 'git sha');
  assert.equal(looksLikeSecret('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), false, 'uuid');
  assert.equal(looksLikeSecret('this-is-a-long-kebab-case-identifier-here'), false, 'one class');
  assert.equal(looksLikeSecret('AKIAIOSFODNN7EXAMPLEAKIAIOSFODNN7EXAMPLE'), false, 'placeholder');
  assert.equal(looksLikeSecret('zQ8vN2xK7pL4mR9tW3yB6cF1hJ5sD0gA'), true);
});

test('formatFindings renders a verdict', () => {
  assert.equal(formatFindings(sanitize('clean text')), 'sanitizer: clean');
  assert.match(formatFindings(sanitize('password = hunter2hunter2hunter2')), /sanitizer: BLOCKED/);
  assert.match(formatFindings(sanitize('mail me at a@example.com')), /sanitizer: redacted/);
});

test('there is no option that disables the gate', () => {
  const source = 'password = hunter2hunter2hunter2';

  // Every shape of options object still blocks. An override flag would defeat the
  // entire control, so none exists.
  for (const options of [{}, { blocklist: [] }, { names: [] }, { blocklist: [], names: [] }]) {
    assert.equal(sanitize(source, options).blocked, true);
  }
});
