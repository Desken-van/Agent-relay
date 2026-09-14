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
import { AgentRelayError } from '../../shared/domain/errors';
import type {
  IdGenerator,
  LocalInferenceLifecycleService,
  LocalInferenceProvider,
  OrnithHealthyLease,
  OrnithInferenceLeaseService,
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

export class LocalInferenceService implements LocalInferenceLifecycleService, OrnithInferenceLeaseService {
  private provider: LocalInferenceProvider | null = null;
  private boundSettings: string | null = null;
  /**
   * The one outstanding Ornith execution lease, if any.
   *
   * A private token rather than a boolean: `release()` clears the lease only
   * when it still identifies the holder that created it, so a stale/duplicate
   * release call (e.g. from a `finally` block firing after a already-released
   * lease) cannot clear a DIFFERENT run's later lease.
   */
  private ornithLeaseToken: symbol | null = null;
  private ornithLeaseOwner: OrnithHealthyLease | null = null;
  private ornithLeaseProvider: LocalInferenceProvider | null = null;
  private ornithLeaseSettings: string | null = null;
  /** Fired by `stop()` when it stops a runtime an Ornith lease is holding. */
  private readonly ornithStopHandlers = new Set<() => void>();

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

    // Independently callable, so this may stop a runtime an Ornith run's
    // lease is currently using. Notify before anything else: the run's own
    // AbortSignal is what unwinds its loop, releases the lease and reconciles
    // task state, and it must start unwinding immediately rather than only
    // discovering the runtime is gone on its next `inferForOrnith` call.
    if (this.ornithLeaseToken !== null) {
      const handlers = [...this.ornithStopHandlers];
      this.ornithStopHandlers.clear();
      for (const handler of handlers) {
        try {
          handler();
        } catch {
          // A misbehaving handler must never prevent Stop from proceeding.
        }
      }
    }

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
    if (this.ornithLeaseToken !== null) {
      return Promise.resolve({
        kind: 'failed',
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId: this.options.ids.next(),
        reason: 'The local runtime is busy with an Ornith implementation run.',
        dispatchOutcome: 'not_dispatched'
      });
    }
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

  /* ------------------------------------------------------------------ */
  /* Ornith: internal, non-IPC lease surface                             */
  /* ------------------------------------------------------------------ */

  async acquireOrnithLease(signal?: AbortSignal): Promise<OrnithHealthyLease> {
    if (this.ornithLeaseToken !== null) {
      throw new AgentRelayError(
        'BUSY',
        'Another Ornith run is already using the local runtime.',
        { remediation: 'Wait for the other run to finish, or stop it, then try again.' }
      );
    }
    const token = Symbol('ornith-lease');
    this.ornithLeaseToken = token;
    const release = (): void => {
      if (this.ornithLeaseToken === token) {
        this.ornithLeaseToken = null;
        this.ornithLeaseOwner = null;
        this.ornithLeaseProvider = null;
        this.ornithLeaseSettings = null;
        this.ornithStopHandlers.clear();
      }
    };

    try {
      // Deliberately reads `this.provider` directly rather than calling
      // `bindProvider()`: binding would construct a fresh provider instance
      // when none is retained, which is exactly the "quietly start something"
      // behaviour Ornith must never trigger. No retained provider means no
      // run, full stop.
      const provider = this.provider;
      if (provider === null || provider.state().kind !== 'healthy') {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'The local runtime is not Healthy.',
          {
            remediation:
              'Start the local runtime in Settings → Local inference and confirm it is Healthy.'
          }
        );
      }

      const checked = await provider.health(signal);
      if (checked.kind !== 'healthy' || this.provider !== provider) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'The local runtime health check did not confirm it is Healthy.',
          { remediation: 'Check the runtime state in Settings → Local inference.' }
        );
      }

      const currentSettings = JSON.stringify(this.options.settings.get().localInference);
      if (this.boundSettings !== currentSettings) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'The retained local runtime does not match the saved local-inference configuration.',
          { remediation: 'Stop the runtime, review Settings, then start it manually again.' }
        );
      }
      const config = this.assembledConfig();
      const lease: OrnithHealthyLease = {
        runtimeInstanceId: checked.runtimeInstanceId,
        providerId: config.providerId,
        modelId: config.model.id,
        contextLimitTokens: config.contextLimitTokens,
        maxOutputTokens: config.maxOutputTokens,
        release,
        onIndependentStop: (handler) => {
          // A lease already released must not accumulate handlers nobody
          // will ever clear.
          if (this.ornithLeaseToken === token) this.ornithStopHandlers.add(handler);
        }
      };
      this.ornithLeaseOwner = lease;
      this.ornithLeaseProvider = provider;
      this.ornithLeaseSettings = currentSettings;
      return lease;
    } catch (error) {
      release();
      throw error;
    }
  }

  async recheckOrnithLease(lease: OrnithHealthyLease, signal?: AbortSignal): Promise<boolean> {
    if (this.ornithLeaseToken === null || this.ornithLeaseOwner !== lease) return false;
    const provider = this.provider;
    if (provider === null || provider !== this.ornithLeaseProvider) return false;
    const state = provider.state();
    if (state.kind !== 'healthy' || state.runtimeInstanceId !== lease.runtimeInstanceId) return false;
    const settingsFingerprint = JSON.stringify(this.options.settings.get().localInference);
    if (settingsFingerprint !== this.ornithLeaseSettings || settingsFingerprint !== this.boundSettings) return false;
    const config = this.assembledConfig();
    if (
      config.providerId !== lease.providerId ||
      config.model.id !== lease.modelId ||
      config.contextLimitTokens !== lease.contextLimitTokens ||
      config.maxOutputTokens !== lease.maxOutputTokens
    ) return false;

    const checked = await provider.health(signal);
    return (
      checked.kind === 'healthy' &&
      checked.runtimeInstanceId === lease.runtimeInstanceId &&
      this.provider === provider
    );
  }

  async inferForOrnith(
    lease: OrnithHealthyLease,
    request: LocalInferenceRequest,
    signal?: AbortSignal
  ): Promise<LocalInferenceOutcome> {
    const failed = (
      reason: string,
      dispatchOutcome: 'not_dispatched' | 'unknown' = 'not_dispatched'
    ): LocalInferenceOutcome => ({
      kind: 'failed',
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId: request.requestId,
      reason,
      dispatchOutcome
    });

    if (this.ornithLeaseToken === null || this.ornithLeaseOwner !== lease) {
      return failed('No Ornith lease is currently held.');
    }
    const provider = this.provider;
    if (provider === null || provider !== this.ornithLeaseProvider) {
      return failed('The local runtime is no longer retained.');
    }
    const settingsFingerprint = JSON.stringify(this.options.settings.get().localInference);
    if (settingsFingerprint !== this.ornithLeaseSettings || settingsFingerprint !== this.boundSettings) {
      return failed('The saved local-inference configuration changed during this run.');
    }
    const config = this.assembledConfig();
    if (
      config.providerId !== lease.providerId ||
      config.model.id !== lease.modelId ||
      config.contextLimitTokens !== lease.contextLimitTokens ||
      config.maxOutputTokens !== lease.maxOutputTokens
    ) {
      return failed('The configured local-inference provider or model changed during this run.');
    }
    const state = provider.state();
    if (state.kind !== 'healthy' || state.runtimeInstanceId !== lease.runtimeInstanceId) {
      return failed('The local runtime is not Healthy.');
    }

    // The one and only dispatch for this turn. Never retried by this method
    // regardless of outcome — a caller that wants another turn builds another
    // request and calls this again, subject to the same lease and identity
    // checks every time.
    const outcome = await provider.infer(request, signal);
    const afterSettings = JSON.stringify(this.options.settings.get().localInference);
    const afterConfig = this.assembledConfig();
    const afterState = provider.state();
    if (
      this.ornithLeaseOwner !== lease ||
      this.provider !== provider ||
      this.ornithLeaseProvider !== provider ||
      afterSettings !== this.ornithLeaseSettings ||
      afterSettings !== this.boundSettings ||
      afterConfig.providerId !== lease.providerId ||
      afterConfig.model.id !== lease.modelId ||
      afterConfig.contextLimitTokens !== lease.contextLimitTokens ||
      afterConfig.maxOutputTokens !== lease.maxOutputTokens ||
      afterState.kind !== 'healthy' ||
      afterState.runtimeInstanceId !== lease.runtimeInstanceId
    ) {
      // Dispatch already occurred. `unknown` is deliberately conservative:
      // the completion is discarded, and the caller must not issue another
      // inference or execute the returned action.
      return failed('The retained runtime or saved configuration changed during inference.', 'unknown');
    }
    return outcome;
  }

  /** The complete configuration this connection would currently bind, read fresh every time. */
  private assembledConfig(): LocalInferenceConfig {
    return assembleLocalInferenceConfig(this.options.settings.get().localInference);
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
