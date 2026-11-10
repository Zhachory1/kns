/**
 * Publishing a draft, and undoing one.
 *
 * Publishing opens a pull request. It never pushes to a zone's default branch and
 * never force-pushes, so review and audit come from the repository rather than from
 * code this project would otherwise have to write — and a promotion can always be
 * undone by reverting a commit that a human approved.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { KnsError } from '../core/errors.ts';
import { parseDocument, renderDocument } from './frontmatter.ts';
import { formatFindings, sanitize } from './sanitize.ts';
import { safeTargetPath } from './draft.ts';

/** Result of running a command. */
export interface ExecResult {
  /** Exit status. */
  code: number;
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
}

/** Runs an external command. Injected so tests never reach the network. */
export type Exec = (command: string, args: readonly string[], cwd: string) => Promise<ExecResult>;

/** Branch names a promotion must never push to. */
export const PROTECTED_BRANCHES = ['main', 'master', 'trunk', 'develop', 'HEAD'];

/** Inputs for publishing. */
export interface PublishInput {
  /** Absolute root of the target zone's checkout. */
  zoneRoot: string;
  /** Document identifier within the zone. */
  documentId: string;
  /** Zone name, used in the branch name and the pull-request body. */
  zoneName: string;
  /** Who is promoting. */
  promotedBy: string;
  /** Reference time, used for the branch name. */
  now: Date;
  /** Command runner. */
  exec: Exec;
  /** Set true to remove the document instead of adding it. */
  remove?: boolean;
}

/** What publishing produced. */
export interface PublishResult {
  /** Branch that was created. */
  branch: string;
  /** Pull-request URL, when `gh` reported one. */
  url: string | null;
  /** Commands that were run, for the audit trail and for tests. */
  commands: string[];
}

/**
 * Run a real command.
 *
 * @param command - Executable name.
 * @param args - Arguments.
 * @param cwd - Working directory.
 * @returns The exit status and output.
 */
export const realExec: Exec = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, [...args], { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });

/**
 * Refuse a branch name that would write to a protected branch.
 *
 * @param branch - Branch a push would target.
 * @throws {KnsError} When the branch is protected.
 */
export function assertPublishableBranch(branch: string): void {
  if (PROTECTED_BRANCHES.includes(branch.trim())) {
    throw new KnsError(
      'invalid_request',
      `refusing to push to protected branch "${branch}"`,
      'promotion always goes through a pull request',
    );
  }
}

/**
 * Build the branch name for a promotion.
 *
 * @param documentId - Document being promoted.
 * @param now - Reference time.
 * @returns A branch name safe for git.
 */
export function branchNameFor(documentId: string, now: Date): string {
  const slug = documentId
    .replace(/\.md$/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return `kns/promote-${slug}-${now.toISOString().slice(0, 10)}`;
}

/** Run a command and fail loudly when it does not succeed. */
async function must(
  exec: Exec,
  command: string,
  args: readonly string[],
  cwd: string,
  commands: string[],
): Promise<ExecResult> {
  commands.push(`${command} ${args.join(' ')}`);
  const result = await exec(command, args, cwd);
  if (result.code !== 0) {
    throw new KnsError(
      'internal',
      `${command} ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      command === 'gh' ? 'check that gh is installed and authenticated' : null,
    );
  }
  return result;
}

/**
 * Publish a drafted document as a pull request.
 *
 * The sanitizer runs again immediately before the commit. The draft may have been
 * edited by hand since it was written, and the check that matters is the one against
 * the bytes actually being committed.
 *
 * @param input - Publish inputs.
 * @returns The branch and pull-request URL.
 * @throws {KnsError} With `sanitizer_blocked` when the staged content fails the gate.
 */
export async function publish(input: PublishInput): Promise<PublishResult> {
  const commands: string[] = [];
  const file = safeTargetPath(input.zoneRoot, input.documentId);
  const remove = input.remove === true;

  if (!remove) {
    const contents = await readFile(file, 'utf8');
    const verdict = sanitize(contents);
    if (verdict.blocked) {
      throw new KnsError(
        'sanitizer_blocked',
        `refusing to publish ${input.documentId}\n${formatFindings(verdict)}`,
        'the draft was edited after it was created; remove the secret and redraft',
      );
    }
  }

  const branch = branchNameFor(input.documentId, input.now);
  assertPublishableBranch(branch);

  await must(input.exec, 'git', ['checkout', '-b', branch], input.zoneRoot, commands);

  if (remove) {
    await must(input.exec, 'git', ['rm', '--', input.documentId], input.zoneRoot, commands);
  } else {
    // Stage by path. `git add -A` would sweep in anything else sitting in the zone
    // checkout, which is exactly the accident a promotion must not have.
    await must(input.exec, 'git', ['add', '--', input.documentId], input.zoneRoot, commands);
  }

  const subject = remove
    ? `chore(kns): demote ${input.documentId}`
    : `docs(kns): promote ${input.documentId} to ${input.zoneName}`;
  const body = remove
    ? `Removed by ${input.promotedBy} via kns promote revoke.`
    : `Promoted by ${input.promotedBy} via kns promote publish.\n\nProvenance is in the document frontmatter.`;

  await must(input.exec, 'git', ['commit', '-m', subject, '-m', body], input.zoneRoot, commands);
  await must(input.exec, 'git', ['push', '--set-upstream', 'origin', branch], input.zoneRoot, commands);

  const created = await must(
    input.exec,
    'gh',
    ['pr', 'create', '--title', subject, '--body', body, '--head', branch],
    input.zoneRoot,
    commands,
  );

  const url = /https?:\/\/\S+/.exec(created.stdout)?.[0] ?? null;
  return { branch, url, commands };
}

/**
 * Record on the origin document that it has been promoted.
 *
 * Written only after the pull request exists. A pointer to a promotion that never
 * happened is worse than no pointer, because it tells the author the knowledge is
 * shared when it is not.
 *
 * @param corpusRoot - Private corpus root.
 * @param documentId - Origin document.
 * @param target - Namespace path the document was promoted to.
 */
export async function writeOriginPointer(
  corpusRoot: string,
  documentId: string,
  target: string,
): Promise<void> {
  const file = safeTargetPath(corpusRoot, documentId);
  const parsed = parseDocument(await readFile(file, 'utf8'));

  const fields = { ...parsed.fields, promoted_to: target };
  await writeFile(file, renderDocument(fields, parsed.body), 'utf8');
}

/**
 * Remove the promotion pointer from an origin document.
 *
 * @param corpusRoot - Private corpus root.
 * @param documentId - Origin document.
 * @returns True when a pointer was present and removed.
 */
export async function clearOriginPointer(corpusRoot: string, documentId: string): Promise<boolean> {
  const file = safeTargetPath(corpusRoot, documentId);
  const parsed = parseDocument(await readFile(file, 'utf8'));

  if (parsed.fields['promoted_to'] === undefined) return false;

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.fields)) {
    if (key !== 'promoted_to') fields[key] = value;
  }
  await writeFile(file, renderDocument(fields, parsed.body), 'utf8');
  return true;
}

/**
 * Report the path of a document inside a zone, for messages.
 *
 * @param zoneNamespace - Namespace of the target zone.
 * @param documentId - Document identifier.
 * @returns A namespace-qualified path.
 */
export function qualifiedPath(zoneNamespace: string, documentId: string): string {
  return path.posix.join(zoneNamespace, documentId);
}
