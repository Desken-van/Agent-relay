/**
 * Safety rules for text a PROVIDER supplies and Agent Relay then stores.
 *
 * Everything an external reviewer sends is data from outside this application:
 * it is written to SQLite, shown to an operator, and read back long after the
 * process that received it has gone. Three properties have to hold before any
 * of that, and none of them follows from the field merely being a string.
 *
 * Length, because a schema bound is not a storage bound and an identity is not
 * prose. Control characters, because a stored string is later rendered, and an
 * escape sequence in a "server version" is not a version. Credential shapes,
 * because a field that may only ever hold a REFERENCE to a secret has to be
 * able to refuse the secret itself.
 *
 * The credential half delegates to {@link containsSecretShape} rather than
 * restating its patterns, so this check cannot drift from the redactor it is
 * supposed to agree with.
 */

import { containsSecretShape } from './redact';

/**
 * How long a provider's own identity string may be.
 *
 * An MCP server names and versions itself. Neither is prose, and a kilobyte of
 * "version" is a payload rather than a mistake.
 */
export const PROVIDER_IDENTITY_LIMIT = 200;

/** Why a provider-supplied string may not be stored. */
export type UnsafeProviderTextReason =
  | 'longer than the limit allows'
  | 'carrying control characters'
  | 'credential-shaped';

/**
 * An identity is a name or a version: no control character belongs in one, and
 * that includes a newline.
 */
// eslint-disable-next-line no-control-regex
const IDENTITY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Prose may wrap and indent, so tab, line feed and carriage return are allowed
 * and the rest of the C0/C1 ranges are not: an ANSI escape stored today is an
 * ANSI escape rendered tomorrow.
 */
// eslint-disable-next-line no-control-regex
const PROSE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Why this identity string cannot be stored, or `null` when it can.
 *
 * Answers with a REASON and never with the offending value: a caller puts the
 * reason into a message it stores, and echoing the value would defeat the very
 * credential check that produced it.
 */
export function unsafeProviderIdentity(
  value: string,
  maxLength: number = PROVIDER_IDENTITY_LIMIT
): UnsafeProviderTextReason | null {
  if (value.length > maxLength) return 'longer than the limit allows';
  if (IDENTITY_CONTROL.test(value)) return 'carrying control characters';
  if (containsSecretShape(value)) return 'credential-shaped';

  return null;
}

/** The same question asked of provider prose, which may legitimately wrap. */
export function unsafeProviderProse(
  value: string,
  maxLength: number
): UnsafeProviderTextReason | null {
  if (value.length > maxLength) return 'longer than the limit allows';
  if (PROSE_CONTROL.test(value)) return 'carrying control characters';
  if (containsSecretShape(value)) return 'credential-shaped';

  return null;
}
