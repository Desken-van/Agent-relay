/**
 * Settings-bound ownership boundary for the LOCAL-A provider.
 *
 * One service lives for the application lifetime. Provider selection and
 * retention are synchronous, while lifecycle concurrency remains delegated to
 * the retained LOCAL-A provider so its transition and cleanup rules are kept.
 */

import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  LOCAL_INFERENCE_PROTOCOL,
  parseLocalInferenceConfig,
  type LocalInferenceCapabilities,
  type LocalInferenceConfig,
  type LocalInferenceOutcome,
  type LocalInferenceRequest,
  type LocalInferenceSettings,
  type LocalInferenceState
} from '../../shared/domain/local-inference';
import type {
  IdGenerator,
  LocalInferenceLifecycleService,
  LocalInferenceProvider,
  SettingsRepository
} from '../ports';

export const LOCAL_INFERENCE_PROVIDER_ID = 'local-llama-cpp';

/** Bounded and safe; never a path, never provider-side detail. */
const LOCAL_INFERENCE_DISABLED_REASON = 'Local inference is disabled in Settings.';

/** Trusted application policy; none of these fields is operator-configurable. */
export const LOCAL_INFERENCE_APPLICATION_LIMITS = {
  maxPromptBytes: 1 * 1024 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  maxCompletionBytes: 1 * 1024 * 1024,
  maxProcessOutputBytes: 512 * 1024
} as const;

/** Build and re-parse the complete LOCAL-A configuration before adapter use. */
export function assembleLocalInferenceConfig(
  settings: LocalInferenceSettings
): LocalInferenceConfig {
  return parseLocalInferenceConfig({
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    providerId: LOCAL_INFERENCE_PROVIDER_ID,
    executable: settings.executable,
    model: settings.model,
    fixedArguments: settings.fixedArguments,
    port: settings.port,
    contextLimitTokens: settings.contextLimitTokens,
    // The request contract's rule — a request may only lower this, never
    // raise it — is preserved by the adapter; this is only ever the ceiling.
    maxOutputTokens: Math.min(settings.requestDefaults.maxOutputTokens, settings.contextLimitTokens),
    defaultChatTemplateParameters: settings.requestDefaults.chatTemplateParameters,
    maxPromptBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxPromptBytes,
    maxRequestBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxRequestBytes,
    maxResponseBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxResponseBytes,
    maxCompletionBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxCompletionBytes,
    maxProcessOutputBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxProcessOutputBytes,
    startupTimeoutMs: settings.startupTimeoutMs,
    healthTimeoutMs: settings.healthTimeoutMs,
    inferenceTimeoutMs: settings.inferenceTimeoutMs,
    shutdownTimeoutMs: settings.shutdownTimeoutMs
  });
}

export type LocalInferenceProviderFactory = (
  config: LocalInferenceConfig
) => LocalInferenceProvider;

export interface LocalInferenceServiceOptions {
  readonly settings: SettingsRepository;
  readonly createProvider: LocalInferenceProviderFactory;
  /** Generates the request id for a manual test inference. Never reused. */
  readonly ids: IdGenerator;
}

export class LocalInferenceService implements LocalInferenceLifecycleService {
  private provider: LocalInferenceProvider | null = null;
  private boundSettings: string | null = null;

  constructor(private readonly options: LocalInferenceServiceOptions) {}

  /** Cheap and passive: no provider construction, discovery or HTTP. */
  state(): LocalInferenceState {
    if (this.provider !== null) return this.provider.state();
    return this.options.settings.get().localInference.enabled
      ? { kind: 'stopped' }
      : { kind: 'unavailable', reason: LOCAL_INFERENCE_DISABLED_REASON };
  }

  capabilities(): Promise<LocalInferenceCapabilities> {
    if (this.isDisabledAndUnbound()) return Promise.resolve(this.disabledCapabilities());
    return this.bindProvider().capabilities();
  }

  start(): Promise<LocalInferenceState> {
    if (this.isDisabledAndUnbound()) {
      return Promise.resolve({ kind: 'unavailable', reason: LOCAL_INFERENCE_DISABLED_REASON });
    }
    return this.bindProvider().start();
  }

  health(): Promise<LocalInferenceState> {
    if (this.isDisabledAndUnbound()) {
      return Promise.resolve({ kind: 'unavailable', reason: LOCAL_INFERENCE_DISABLED_REASON });
    }
    return this.bindProvider().health();
  }

  stop(): Promise<LocalInferenceState> {
    const provider = this.provider;
    if (provider === null) return Promise.resolve({ kind: 'stopped' });

    // Delegate immediately. LOCAL-A owns cancellation, concurrent/idempotent
    // stop joining, and transition validation for this exact provider.
    return provider.stop().then((stopped) => {
      // Exact confirmation is the only evidence that releases an owning
      // provider. The identity guard prevents an older completion from
      // clearing a provider selected by a later operation.
      if (stopped.kind === 'stopped' && this.provider === provider) {
        this.provider = null;
        this.boundSettings = null;
      }
      return stopped;
    });
  }

  /**
   * One manual smoke-test completion.
   *
   * Accepts only prompt text at this application boundary. Builds exactly one
   * version-1 request — a generated request id and one `{role: 'user',
   * content: prompt}` message, with no request-level token or template
   * override — and delegates it exactly once to the retained provider. The
   * saved `requestDefaults` already assembled into the bound configuration
   * remain the only source of those limits.
   *
   * Disabled and unbound short-circuits before a provider is constructed or a
   * request id is generated, exactly like every other lifecycle method here.
   * An enabled, bound provider still enforces its own Healthy-only transition
   * and returns a structured failure for every other state.
   */
  runTestInference(prompt: string): Promise<LocalInferenceOutcome> {
    if (this.isDisabledAndUnbound()) {
      return Promise.resolve({
        kind: 'failed',
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId: this.options.ids.next(),
        reason: LOCAL_INFERENCE_DISABLED_REASON,
        dispatchOutcome: 'not_dispatched'
      });
    }

    const request: LocalInferenceRequest = {
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId: this.options.ids.next(),
      messages: [{ role: 'user', content: prompt }]
    };
    return this.bindProvider().infer(request);
  }

  /** No provider is retained, and Settings currently forbid constructing one. */
  private isDisabledAndUnbound(): boolean {
    return this.provider === null && !this.options.settings.get().localInference.enabled;
  }

  private disabledCapabilities(): LocalInferenceCapabilities {
    const settings = this.options.settings.get().localInference;
    return {
      protocol: LOCAL_INFERENCE_PROTOCOL,
      contractVersion: LOCAL_INFERENCE_CONTRACT_VERSION,
      providerId: LOCAL_INFERENCE_PROVIDER_ID,
      modelId: settings.model.id,
      available: false,
      unavailableReason: LOCAL_INFERENCE_DISABLED_REASON,
      executableSource: null,
      runtimeVersion: null,
      supportsChatCompletions: true,
      supportsStreaming: false,
      supportsUsageWhenReported: true,
      supportsChatTemplateParameters: true,
      inferenceVerified: false
    };
  }

  private bindProvider(): LocalInferenceProvider {
    const current = this.options.settings.get().localInference;
    const fingerprint = JSON.stringify(current);

    if (this.provider !== null && this.boundSettings !== fingerprint) {
      const state = this.provider.state();
      // A never-started provider has no process handle to preserve. Every
      // active or terminal failure state remains pinned until stop confirms it.
      if (state.kind === 'stopped' || state.kind === 'unavailable') {
        this.provider = null;
        this.boundSettings = null;
      }
    }

    if (this.provider === null) {
      const config = assembleLocalInferenceConfig(current);
      this.provider = this.options.createProvider(config);
      this.boundSettings = fingerprint;
    }
    return this.provider;
  }

}
