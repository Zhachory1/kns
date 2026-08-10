/**
 * Error vocabulary and envelope construction.
 *
 * Callers branch on {@link ErrorCode}, never on message text. Codes are stable;
 * messages are for humans and may change freely.
 *
 * @module
 */

import { SCHEMA_VERSION } from '../version.ts';
import type { ErrorEnvelope, OkEnvelope } from './types.ts';

/** Every error code KNS can emit. */
export const ERROR_CODES = [
  'invalid_request',
  'registry_invalid',
  'zone_unavailable',
  'zone_timeout',
  'sanitizer_blocked',
  'internal',
] as const;

/** A stable, machine-readable error code. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes for which retrying the identical request could plausibly succeed.
 *
 * A zone that was slow or not running may be fine on the next call. A rejected
 * request or a blocked promotion will not change on its own.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['zone_unavailable', 'zone_timeout']);

/**
 * Narrow an arbitrary value to an {@link ErrorCode}.
 *
 * @param value - Candidate value.
 * @returns True when the value is a known error code.
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Report whether a code is worth retrying.
 *
 * @param code - Error code to classify.
 * @returns True when an identical retry could succeed.
 */
export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** An error carrying a stable code and, where useful, a suggested next step. */
export class KnsError extends Error {
  /** Stable error code. */
  readonly code: ErrorCode;

  /** Suggested next action for the caller, or null when there is nothing useful. */
  readonly nextStep: string | null;

  /**
   * @param code - Stable error code.
   * @param message - Human-readable description.
   * @param nextStep - Suggested next action, when there is a useful one.
   */
  constructor(code: ErrorCode, message: string, nextStep: string | null = null) {
    super(message);
    this.name = 'KnsError';
    this.code = code;
    this.nextStep = nextStep;
  }

  /** Whether retrying the identical request could succeed. */
  get retryable(): boolean {
    return isRetryable(this.code);
  }
}

/**
 * Wrap a payload in a success envelope.
 *
 * @param result - Payload to return to the caller.
 * @returns A versioned success envelope.
 */
export function ok<T>(result: T): OkEnvelope<T> {
  return { schemaVersion: SCHEMA_VERSION, ok: true, result };
}

/**
 * Convert any thrown value into a failure envelope.
 *
 * Unknown throwables become `internal` rather than leaking a stack trace or an
 * arbitrary shape onto the wire, which keeps error handling total.
 *
 * @param error - Value that was thrown.
 * @returns A versioned failure envelope.
 */
export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof KnsError) {
    return {
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        nextStep: error.nextStep,
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: { code: 'internal', message, retryable: false, nextStep: null },
  };
}
