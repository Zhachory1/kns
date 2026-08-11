/**
 * Demand-signal opt-in.
 *
 * The feature ships off, and turning it on is a separate, explicit act that also
 * generates the machine-local secret behind the pseudonymous reporter id. Storing the
 * opt-in in its own file rather than in the main settings keeps "is anything being
 * counted about me" a single question with a single answer.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** File name of the opt-in inside the KNS home directory. */
export const SIGNAL_FILE = 'signal.json';

/** Demand-signal state for this machine. */
export interface SignalSettings {
  /** True when retrievals are counted locally. */
  enabled: boolean;
  /** Machine-local secret behind the reporter id. Never leaves the machine. */
  secret: string;
}

/**
 * Read the opt-in.
 *
 * A missing or unreadable file means disabled. Failing closed here is the right
 * default: the failure mode of guessing wrong is counting something nobody agreed to.
 *
 * @param home - KNS home directory.
 * @returns The current state.
 */
export async function loadSignalSettings(home: string): Promise<SignalSettings> {
  try {
    const parsed = JSON.parse(await readFile(path.join(home, SIGNAL_FILE), 'utf8')) as Partial<SignalSettings>;
    return {
      enabled: parsed.enabled === true,
      secret: typeof parsed.secret === 'string' ? parsed.secret : '',
    };
  } catch {
    return { enabled: false, secret: '' };
  }
}

/**
 * Turn demand signals on or off.
 *
 * @param home - KNS home directory.
 * @param enabled - Desired state.
 * @returns The stored state, including a freshly generated secret on first enable.
 */
export async function setSignalEnabled(home: string, enabled: boolean): Promise<SignalSettings> {
  const current = await loadSignalSettings(home);
  const settings: SignalSettings = {
    enabled,
    secret: current.secret === '' ? randomBytes(32).toString('hex') : current.secret,
  };

  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, SIGNAL_FILE), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}
