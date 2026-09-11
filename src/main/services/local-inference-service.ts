/**
 * Settings-bound ownership boundary for the LOCAL-A provider.
 *
 * One service lives for the application lifetime. Provider selection and
 * retention are synchronous, while lifecycle concurrency remains delegated to
 * the retained LOCAL-A provider so its transition and cleanup rules are kept.
 */

import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  parseLocalInferenceConfig,
  type LocalInferenceCapabilities,
  type LocalInferenceConfig,
  type LocalInferenceSettings,
  type LocalInferenceState
} from '../../shared/domain/local-inference';
import type {
  LocalInferenceLifecycleService,
  LocalInferenceProvider,
  SettingsRepository
} from '../ports';

export const LOCAL_INFERENCE_PROVIDER_ID = 'local-llama-cpp';

/** Trusted application policy; none of these fields is operator-configurable. */
export const LOCAL_INFERENCE_APPLICATION_LIMITS = {
  maxOutputTokens: 4096,
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
    maxOutputTokens: Math.min(
      LOCAL_INFERENCE_APPLICATION_LIMITS.maxOutputTokens,
      settings.contextLimitTokens
    ),
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
}

export class LocalInferenceService implements LocalInferenceLifecycleService {
  private provider: LocalInferenceProvider | null = null;
  private boundSettings: string | null = null;

  constructor(private readonly options: LocalInferenceServiceOptions) {}

  /** Cheap and passive: no provider construction, discovery or HTTP. */
  state(): LocalInferenceState {
    return this.provider?.state() ?? { kind: 'stopped' };
  }

  capabilities(): Promise<LocalInferenceCapabilities> {
    return this.bindProvider().capabilities();
  }

  start(): Promise<LocalInferenceState> {
    return this.bindProvider().start();
  }

  health(): Promise<LocalInferenceState> {
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
