/**
 * Credential redaction.
 *
 * Agent Relay shells out to `gh`, `git`, `codex` and `claude`, and it stores
 * their output in SQLite and shows it in the UI. Those tools are careful, but
 * "careful" is not "guaranteed" — a stray `GITHUB_TOKEN=…` in an error message
 * would otherwise be persisted forever.
 *
 * Everything that is about to be logged, persisted, or shown to the user goes
 * through {@link redactSecrets} first. It is intentionally aggressive: a false
 * positive costs a few unreadable characters, a false negative costs a token.
 */

const PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly label: string }> = [
  // GitHub tokens: ghp_ (classic PAT), gho_ (OAuth), ghu_/ghs_ (app), ghr_ (refresh),
  // and the fine-grained github_pat_ prefix.
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, label: 'github-token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'github-token' },
  // OpenAI / Anthropic style keys.
  { re: /\bsk-[A-Za-z0-9._-]{16,}\b/g, label: 'api-key' },
  { re: /\bsk-ant-[A-Za-z0-9._-]{16,}\b/g, label: 'api-key' },
  // JSON Web Tokens (Codex/ChatGPT session material).
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: 'jwt' },
  // Authorization headers.
  { re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, label: 'authorization' },
  // Credentials embedded in a URL: https://user:pass@host
  { re: /(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, label: 'url-credentials' }
];

/**
 * Environment variable names whose *values* must never be echoed. Matched
 * case-insensitively against `NAME=value` and `NAME: value` shapes.
 */
const SENSITIVE_ENV_NAMES =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|SESSION_KEY)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

export const REDACTION_PLACEHOLDER = '[redacted]';

export function redactSecrets(input: string): string {
  if (input.length === 0) return input;

  let output = input;

  for (const { re } of PATTERNS) {
    // `re` is global; reset lastIndex so repeated calls stay deterministic.
    re.lastIndex = 0;
    output = output.replace(re, (match) =>
      match.startsWith('http') ? match.replace(/(\bhttps?:\/\/).*@/i, `$1${REDACTION_PLACEHOLDER}@`) : REDACTION_PLACEHOLDER
    );
  }

  SENSITIVE_ENV_NAMES.lastIndex = 0;
  output = output.replace(SENSITIVE_ENV_NAMES, (_match, name: string) => `${name}=${REDACTION_PLACEHOLDER}`);

  return output;
}

/** Redact and clamp a string to `maxLength`, noting how much was dropped. */
export function redactAndTruncate(input: string, maxLength: number): string {
  const redacted = redactSecrets(input);
  if (redacted.length <= maxLength) return redacted;
  const dropped = redacted.length - maxLength;
  return `${redacted.slice(0, maxLength)}\n…[truncated ${dropped} characters]`;
}

/**
 * Build a child-process environment with credential-bearing variables removed,
 * except those the target tool legitimately needs.
 *
 * The point is *compartmentalisation*, not blanket removal. `gh` may well be
 * authenticated through `GH_TOKEN`, and Claude Code through `ANTHROPIC_API_KEY`
 * — stripping those would break the tool rather than secure it. What must not
 * happen is `git` inheriting `GH_TOKEN`, or Codex inheriting Anthropic's key:
 * every extra process that can see a secret is another process that can print
 * it into a log we then persist.
 *
 * So each adapter declares the credential variables *it* owns, and everything
 * else token-shaped is dropped.
 */
export function scrubEnvironment(
  env: NodeJS.ProcessEnv,
  passthroughNames: readonly string[] = []
): NodeJS.ProcessEnv {
  const unsafe = /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY)/i;
  const allowed = new Set(passthroughNames.map((name) => name.toUpperCase()));

  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (unsafe.test(key) && !allowed.has(key.toUpperCase())) continue;
    result[key] = value;
  }
  return result;
}
