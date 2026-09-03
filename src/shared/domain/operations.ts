/**
 * Operational targets — the Operations workflow's registry.
 *
 * A *target* is something Agent Relay may be pointed at to **look** at. It is
 * deliberately not a deployment, a connection string, or a credential: it names
 * an environment, says which kind of adapter can read it, and carries the small
 * amount of configuration that adapter needs. Nothing here can mutate anything,
 * and nothing here holds a secret.
 *
 * Three rules do most of the work:
 *
 *  1. **`adapterType` is an enum, never a string.** The registry picks the
 *     implementation from a fixed table keyed by that enum, so no stored value,
 *     no IPC payload and no model output can ever name a module, a path or a
 *     command to load.
 *  2. **Configuration is versioned and validated per adapter.** An unknown
 *     version or an unknown adapter type is a validation failure, not a
 *     best-effort read: a row written by a newer build must fail closed rather
 *     than be half-understood by an older one.
 *  3. **Credentials are references, never values.** `credentialRef` names an
 *     entry in something else's store. A value that merely *looks* like a
 *     secret is refused outright, so a paste of the real thing cannot be
 *     persisted by accident.
 */

import { z } from 'zod';
import { containsSecretShape } from '../util/redact';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                                */
/* -------------------------------------------------------------------------- */

export const OPERATION_ENVIRONMENTS = ['local', 'staging', 'production'] as const;
export type OperationEnvironment = (typeof OPERATION_ENVIRONMENTS)[number];

/**
 * Adapter kinds this build can read.
 *
 * Phase 7C-A ships exactly one. Adding another means adding a member here *and*
 * a config schema for it *and* an entry in the main process's adapter table —
 * three deliberate edits, none of which can be performed by data.
 */
export const OPERATION_ADAPTER_TYPES = ['local_sqlite'] as const;
export type OperationAdapterType = (typeof OPERATION_ADAPTER_TYPES)[number];

/** The only config shape version this build writes, and the only one it reads. */
export const OPERATION_CONFIG_VERSION = 1;

export const OPERATION_TARGET_NAME_MAX = 120;
export const CREDENTIAL_REF_MAX = 128;
export const DATABASE_PATH_MAX = 4096;

/* -------------------------------------------------------------------------- */
/* Primitive validation                                                        */
/* -------------------------------------------------------------------------- */

/** Any C0/C1 control character, including NUL. */
export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Absolute-path recognition without `node:path`.
 *
 * This module is imported by the renderer, which may not touch Node built-ins,
 * so the rules are spelled out rather than delegated. All three forms a desktop
 * user can legitimately produce are accepted, and nothing else is:
 *
 *  * `C:\dir\file` — a drive-letter path;
 *  * `\\server\share\file` — a UNC path;
 *  * `/dir/file` — a POSIX path.
 */
export function isAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value) || value.startsWith('/');
}

/**
 * Collapse separators and drop a trailing one, without resolving anything.
 *
 * Deliberately *not* a resolver: `.` and `..` are rejected outright below rather
 * than collapsed here, because "normalise then trust" is how a path that looked
 * settled turns out to point somewhere else. A UNC prefix keeps its two leading
 * separators; everything else is squeezed to one.
 */
export function normalizeTargetPath(value: string): string {
  const unc = /^[\\/]{2}/.test(value);
  const body = value.replace(/[\\/]+/g, (match, offset: number) =>
    unc && offset === 0 ? value.slice(0, 2) : match[0] ?? '/'
  );

  // A root (`C:\`, `/`, `\\server\share`) keeps its trailing separator; nothing
  // else does, so two spellings of one directory cannot both be stored.
  if (/^[A-Za-z]:[\\/]$/.test(body) || body === '/' ) return body;
  return body.replace(/[\\/]+$/, '');
}

function pathSegments(value: string): string[] {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/**
 * An absolute, normalised filesystem path with nothing surprising in it.
 *
 * Relative segments are refused rather than resolved. A target is registered
 * once and read many times, possibly long afterwards; a stored `..` would make
 * what it points at depend on where the process happened to be standing.
 */
export const absoluteDatabasePathSchema = z
  .string()
  .min(1, 'A database path is required.')
  .max(DATABASE_PATH_MAX, `A database path may be at most ${DATABASE_PATH_MAX} characters.`)
  // Checked before normalisation: a control character must not be able to hide
  // behind a separator rewrite.
  .refine((value) => !hasControlCharacter(value), 'A database path may not contain control characters.')
  .refine((value) => isAbsolutePathLike(value), 'A database path must be absolute.')
  .refine(
    (value) => !pathSegments(value).some((segment) => segment === '.' || segment === '..'),
    'A database path may not contain "." or ".." segments.'
  )
  .transform(normalizeTargetPath);

export const operationTargetNameSchema = z
  .string()
  .min(1, 'A name is required.')
  .max(OPERATION_TARGET_NAME_MAX, `A name may be at most ${OPERATION_TARGET_NAME_MAX} characters.`)
  .refine((value) => !hasControlCharacter(value), 'A name may not contain control characters.')
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, 'A name is required.');

/**
 * A pointer into somebody else's credential store — never the credential.
 *
 * The character class alone rules out URLs, `NAME=value` pairs and anything with
 * whitespace. On top of that, a value that matches one of the shapes the
 * redactor knows about is refused, so pasting a real token here fails loudly
 * instead of persisting it under a field that claims to be harmless.
 */
export const credentialRefSchema = z
  .string()
  .min(1, 'A credential reference may not be empty.')
  .max(CREDENTIAL_REF_MAX, `A credential reference may be at most ${CREDENTIAL_REF_MAX} characters.`)
  // Path-shaped references are normal — `vault:secret/data/reporting` — so the
  // separator is allowed. What is not: `@`, whitespace, `=`, `?` and `#`, which
  // is what a URL with embedded credentials, a `NAME=value` pair or a query
  // string would need.
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    'A credential reference may only contain letters, digits, dot, underscore, colon, slash and hyphen.'
  )
  .refine(
    (value) => !containsSecretShape(value),
    'This looks like a credential value. Store the secret in your own credential manager and put only its identifier here.'
  );

/* -------------------------------------------------------------------------- */
/* Adapter configuration                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Configuration for the local SQLite adapter.
 *
 * One field. There is no host, no port, no user, no password and no connection
 * string, and there is nowhere for one to be added without changing this schema
 * — which is the point: a shape that cannot express a credential cannot leak
 * one.
 */
export const localSqliteConfigSchema = z
  .object({
    version: z.literal(OPERATION_CONFIG_VERSION),
    adapterType: z.literal('local_sqlite'),
    databasePath: absoluteDatabasePathSchema
  })
  .strict();

export type LocalSqliteConfig = z.infer<typeof localSqliteConfigSchema>;

/**
 * Every adapter's configuration, discriminated by `adapterType`.
 *
 * A row whose `adapterType` or `version` this build does not know fails to
 * parse. That is the intended behaviour for a downgrade: refusing to read is
 * safe, guessing is not.
 */
export const operationTargetConfigSchema = z.discriminatedUnion('adapterType', [
  localSqliteConfigSchema
]);

export type OperationTargetConfig = z.infer<typeof operationTargetConfigSchema>;

/**
 * Serialise a config to its one canonical spelling.
 *
 * Keys are emitted in a fixed order so the same configuration always produces
 * the same bytes: two rows that differ only in key order would otherwise defeat
 * a uniqueness constraint and make a diff of the audit trail unreadable.
 */
export function canonicalConfigJson(config: OperationTargetConfig): string {
  switch (config.adapterType) {
    case 'local_sqlite':
      return JSON.stringify({
        version: config.version,
        adapterType: config.adapterType,
        databasePath: config.databasePath
      });
  }
}

/** Parse stored config JSON, failing closed on anything unrecognised. */
export function parseTargetConfig(json: string): OperationTargetConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The stored target configuration is not valid JSON.');
  }
  return operationTargetConfigSchema.parse(parsed);
}

/* -------------------------------------------------------------------------- */
/* The target itself                                                           */
/* -------------------------------------------------------------------------- */

export interface OperationTarget {
  readonly id: string;
  readonly name: string;
  readonly environment: OperationEnvironment;
  readonly adapterType: OperationAdapterType;
  readonly config: OperationTargetConfig;
  /** An identifier in an external credential store, or null. Never a secret. */
  readonly credentialRef: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Adapters that authenticate through nothing but filesystem permissions.
 *
 * A local SQLite file is opened by path; there is no account to name, so a
 * `credentialRef` on such a target could only be noise — or a secret somebody
 * pasted because the field existed.
 */
const CREDENTIAL_FREE_ADAPTERS: readonly OperationAdapterType[] = ['local_sqlite'];

export function adapterAcceptsCredentialRef(adapterType: OperationAdapterType): boolean {
  return !CREDENTIAL_FREE_ADAPTERS.includes(adapterType);
}

/**
 * A target as the caller proposes it.
 *
 * `environment` is required and is never inferred. A name containing "prod", or
 * a path under a directory called `production`, says nothing reliable about what
 * a database actually is; making the operator state it means the answer is a
 * decision on record rather than a guess this code made.
 */
export const newOperationTargetSchema = z
  .object({
    name: operationTargetNameSchema,
    environment: z.enum(OPERATION_ENVIRONMENTS),
    config: operationTargetConfigSchema,
    credentialRef: credentialRefSchema.nullable().optional(),
    enabled: z.boolean().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.credentialRef != null && !adapterAcceptsCredentialRef(value.config.adapterType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentialRef'],
        message: `A ${value.config.adapterType} target is opened by path and accepts no credential reference.`
      });
    }
  });

export type NewOperationTargetInput = z.infer<typeof newOperationTargetSchema>;

/**
 * The fields a registered target will accept a change to.
 *
 * `id` is absent on purpose, and so is `adapterType` — both are identity. A
 * diagnostic run refers to a target by id, so letting either move would make an
 * old audit row describe something that no longer exists. Re-pointing a target
 * at a different kind of system is a new target, not an edit.
 */
export const operationTargetPatchSchema = z
  .object({
    name: operationTargetNameSchema.optional(),
    environment: z.enum(OPERATION_ENVIRONMENTS).optional(),
    config: operationTargetConfigSchema.optional(),
    credentialRef: credentialRefSchema.nullable().optional(),
    enabled: z.boolean().optional()
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'An update must change at least one field.'
  );

export type OperationTargetPatch = z.infer<typeof operationTargetPatchSchema>;
