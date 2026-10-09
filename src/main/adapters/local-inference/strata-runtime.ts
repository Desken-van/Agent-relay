/**
 * What is particular to a Strata runtime (https://github.com/Niko1221/Strata) behind the local-inference
 * adapter: how it is launched, what its model config must say before it is, and what its health answer must
 * say before it counts as ready. Everything else — one supervised process tree, one bounded request per
 * inference, terminal states only on confirmed termination — is the adapter's, unchanged.
 *
 * Three facts about Strata decide the checks here, each measured on the pinned revision (STRATA-1):
 *
 *  * Its server answers `/health` with `"status": "ok"` before the model is usable (`"loaded": false` while
 *    it loads, after an idle unload, or with lazy loading). An answer is ready only with `loaded: true`, the
 *    configured model name and at least the configured context. Lazy loading and idle unloading are refused
 *    outright: Agent Relay owns when the runtime runs.
 *  * Its model config can make it an agent host (`mcp_servers` / `mcpServers` / `mcp`: MCP tools offered to
 *    requests), a network server (`host`, `api_key`) or a command runner (`before_load`: a command its server
 *    runs, through a shell when it is a string, every time it loads the engine again — after an idle unload
 *    and after the engine died). Agent Relay sends no tools, does every file change itself and runs no
 *    command outside its own tools; such a config is refused, never adapted.
 *  * Its `json_schema` response format is a prompt plus a check after generation that extracts the first
 *    JSON object from the text — prose, a fence or a second object are dropped silently. Agent Relay's own
 *    parser requires the whole completion to be exactly one action, so the adapter does not ask Strata for a
 *    response format: the model's raw text reaches that parser unchanged. What that format adds that does
 *    matter is a system message stating the output format: without one, the Coder model answered a real
 *    Ornith prompt with a sentence of prose instead of an action on every attempt (STRATA-1 control run,
 *    five of five); with the short one below and no response format, it answered with exactly one action on
 *    every turn. So that message is sent, and the strict check stays Agent Relay's.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  LOCAL_INFERENCE_HOST,
  type LocalInferenceConfig,
  type LocalInferenceMessage,
  type LocalInferenceRequest
} from '../../../shared/domain/local-inference';

/**
 * The system message an Ornith request to a Strata model starts with: the output format, in fixed words,
 * nothing about the task. It is part of the prompt (and counted as such); the protocol itself is unchanged.
 */
export const STRATA_ORNITH_FORMAT_MESSAGE: LocalInferenceMessage = Object.freeze({
  role: 'system',
  content:
    'OUTPUT FORMAT REQUIREMENT: Reply with exactly one JSON object: one Ornith action from the protocol below. ' +
    'No Markdown, code fences, commentary or any text before or after the JSON object.'
});

/**
 * A request's stable-prefix hint as Strata's `strata_prefix`: the engine pins a checkpoint where the prefix ends.
 *
 * Strata keeps checkpoints at the start of an assistant turn, at the end of a long system prompt and every 16K
 * tokens — none inside the one user message an Ornith turn sends, so without a mark every turn read its whole
 * prompt again (`cache_n: 0` on every turn measured, STRATA-1), most of a turn's time. Marked, a later turn
 * reads only what follows the repeated specification and protocol. The text sent is unchanged. (Not with
 * `strata_checkpoint: false`, although no Ornith turn is ever continued: the engine then ignores the pin.)
 *
 * `wireMessages` are the messages as sent, `offset` how many of them the adapter put in front of the request's
 * own. Strata counts characters in code points; the hint counts UTF-16 code units.
 */
export function strataPrefixFields(
  stablePrefix: LocalInferenceRequest['stablePrefix'],
  wireMessages: readonly LocalInferenceMessage[],
  offset: number
): { strata_prefix: { message: number; chars: number } } | Record<string, never> {
  if (stablePrefix === undefined) return {};
  const message = stablePrefix.message + offset;
  const content = wireMessages[message]?.content;
  if (content === undefined) return {};
  const chars = Array.from(content.slice(0, stablePrefix.chars)).length;
  return chars > 0 ? { strata_prefix: { message, chars } } : {};
}

/** A model config is a few hundred bytes; anything this large is not one. */
const STRATA_CONFIG_MAX_BYTES = 64 * 1024;

/** Keys of a Strata model config that turn its server into something Agent Relay does not run. */
const REFUSED_CONFIG_KEYS: readonly { readonly key: string; readonly reason: string }[] = [
  { key: 'mcp_servers', reason: 'it offers MCP tools to the model' },
  { key: 'mcpServers', reason: 'it offers MCP tools to the model' },
  { key: 'mcp', reason: 'it offers MCP tools to the model' },
  { key: 'api_key', reason: 'it requires an API key' },
  { key: 'lazy_load', reason: 'it loads the model lazily' },
  { key: 'idle_unload_s', reason: 'it unloads the model when idle' },
  { key: 'before_load', reason: 'it runs a command before the model loads' }
];

/** What the adapter uses from a Strata model config, after it was checked. */
export interface StrataEngineConfig {
  /** The engine binary its server starts; probed with `--version` like llama-server is. */
  readonly engine: string;
  /** The model name the server reports in `/health` and `/v1/models`. */
  readonly modelName: string;
  /** The engine's `--max-context`. */
  readonly maxContext: number;
}

export type StrataConfigRead =
  | { readonly ok: true; readonly config: StrataEngineConfig }
  | { readonly ok: false; readonly reason: string };

/**
 * Read and check the model config named by `config.strata.engineConfig`. Bounded, synchronous, read-only;
 * a refusal names what is wrong in fixed words, never a path or a value from the file.
 */
export function readStrataEngineConfig(config: LocalInferenceConfig): StrataConfigRead {
  const path = config.strata?.engineConfig;
  if (path === undefined) return { ok: false, reason: 'No Strata model config is configured.' };
  let text: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return { ok: false, reason: 'The configured Strata model config is not a file.' };
    if (stats.size > STRATA_CONFIG_MAX_BYTES) return { ok: false, reason: 'The configured Strata model config is too large to be one.' };
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'The configured Strata model config is not present.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'The configured Strata model config is not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'The configured Strata model config is not a JSON object.' };
  }
  const record = parsed as Record<string, unknown>;
  for (const { key, reason } of REFUSED_CONFIG_KEYS) {
    const value = record[key];
    const present = value !== undefined && value !== null && value !== false && value !== '' && value !== 0 &&
      !(typeof value === 'object' && Object.keys(value as object).length === 0);
    if (present) return { ok: false, reason: `The Strata model config is refused: ${reason} ("${key}").` };
  }
  if (record.host !== undefined && record.host !== null && record.host !== LOCAL_INFERENCE_HOST) {
    return { ok: false, reason: `The Strata model config is refused: it listens beyond ${LOCAL_INFERENCE_HOST} ("host").` };
  }
  const engine = record.exe;
  if (typeof engine !== 'string' || engine.length === 0 || !isAbsolute(engine)) {
    return { ok: false, reason: 'The Strata model config does not name its engine by an absolute path ("exe").' };
  }
  const modelName = record.model_name;
  if (typeof modelName !== 'string' || modelName.length === 0) {
    return { ok: false, reason: 'The Strata model config does not name its model ("model_name").' };
  }
  const args = record.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return { ok: false, reason: 'The Strata model config has no engine arguments ("args").' };
  }
  const at = args.indexOf('--max-context');
  const maxContext = at >= 0 ? Number(args[at + 1]) : Number.NaN;
  if (!Number.isInteger(maxContext) || maxContext <= 0) {
    return { ok: false, reason: 'The Strata model config does not set the engine context ("--max-context").' };
  }
  if (config.model.source.kind !== 'runtime_id' || modelName !== config.model.source.runtimeModelId) {
    return { ok: false, reason: 'The Strata model config names a different model than this profile.' };
  }
  if (maxContext < config.contextLimitTokens) {
    return {
      ok: false,
      reason: `The Strata engine context (${maxContext} tokens) is smaller than this profile's context limit (${config.contextLimitTokens}).`
    };
  }
  return { ok: true, config: { engine, modelName, maxContext } };
}

/**
 * The server's argv after the interpreter: its own script, the real engine, the model config, and the host
 * and port Agent Relay owns. No shell, no request text; the config's own arguments are its business.
 */
export function strataRuntimeArgv(config: LocalInferenceConfig): string[] {
  const strata = config.strata;
  if (strata === undefined) throw new Error('strataRuntimeArgv needs a Strata configuration.');
  return [
    strata.serverScript,
    '--engine',
    'strata',
    '--config',
    strata.engineConfig,
    '--host',
    LOCAL_INFERENCE_HOST,
    '--port',
    String(config.port)
  ];
}

export type StrataHealthVerdict =
  | { readonly kind: 'ok' }
  /** Not ready yet (still loading). Retryable while starting. */
  | { readonly kind: 'not_ready'; readonly reason: string }
  /** Answered, but as something else than this profile's runtime. Not retryable. */
  | { readonly kind: 'malformed'; readonly reason: string };

/** What a Strata `/health` body must say before the runtime counts as ready. */
export function judgeStrataHealth(record: Record<string, unknown>, config: LocalInferenceConfig): StrataHealthVerdict {
  if (record.status !== 'ok') return { kind: 'not_ready', reason: 'The runtime is not reporting status "ok".' };
  if (record.service !== undefined && record.service !== 'strata') {
    return { kind: 'malformed', reason: 'The runtime on the configured port is not a Strata server.' };
  }
  if (record.loaded !== true) return { kind: 'not_ready', reason: 'The Strata server is up, but its model is not loaded.' };
  if (config.model.source.kind !== 'runtime_id' || record.model !== config.model.source.runtimeModelId) {
    return { kind: 'malformed', reason: 'The Strata server reports a different model than this profile.' };
  }
  const maxContext = record.max_context;
  if (typeof maxContext !== 'number' || !Number.isInteger(maxContext) || maxContext < config.contextLimitTokens) {
    return { kind: 'malformed', reason: 'The Strata server reports less context than this profile needs.' };
  }
  return { kind: 'ok' };
}
