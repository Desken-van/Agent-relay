/**
 * Settings-bound ownership boundary for the LOCAL-A provider.
 *
 * One service lives for the application lifetime. Provider selection and
 * retention are synchronous, while lifecycle concurrency remains delegated to
 * the retained LOCAL-A provider so its transition and cleanup rules are kept.
 *
 * At most one llama.cpp process is ever retained at a time — `LOCAL_INFERENCE_TRANSITIONS`'s own
 * comment says why ("a second start would silently abandon the first") — but Settings may now hold
 * several named profiles. `activeProfileId` is which one the retained process IS or would next be
 * bound to; it lives here, in volatile runtime state, never in durable Settings, because it describes
 * this process's own retained runtime, not an operator preference to persist across restarts.
 */

import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  LOCAL_INFERENCE_LIMITS,
  LOCAL_INFERENCE_PROTOCOL,
  parseLocalInferenceConfig,
  summarizeLocalInferenceProfiles,
  type LocalInferenceCapabilities,
  type LocalInferenceConfig,
  type LocalInferenceOutcome,
  type LocalInferenceProfile,
  type LocalInferenceProfileSummary,
  type LocalInferenceRequest,
  type LocalInferenceState
} from '../../shared/domain/local-inference';
import { AgentRelayError } from '../../shared/domain/errors';
import type {
  IdGenerator,
  LocalInferenceLifecycleService,
  LocalInferenceProvider,
  LocalInferenceQuitOutcome,
  LocalInferenceReleaseOutcome,
  LocalInferenceRuntimeRelease,
  OrnithHealthyLease,
  OrnithInferenceLeaseService,
  SettingsRepository
} from '../ports';
import { localInferenceProfileFingerprint } from './local-inference-profile-fingerprint';

export const LOCAL_INFERENCE_PROVIDER_ID = 'local-llama-cpp';

/** Bounded and safe; never a path, never provider-side detail. */
const LOCAL_INFERENCE_DISABLED_REASON = 'Local inference is disabled in Settings.';
const NO_ACTIVE_PROFILE_REASON = 'No local-model profile is selected. Choose one in Settings → Local inference.';
/** Beyond the active profile's own shutdown budget: how much longer `releaseForVerification` waits for the stop to confirm. */
const LOCAL_RUNTIME_RELEASE_GRACE_MS = 5_000;

type Settled<T> = { readonly kind: 'settled'; readonly value: T } | { readonly kind: 'expired' } | { readonly kind: 'aborted' } | { readonly kind: 'failed' };

/**
 * Await `work` for at most `ceilingMs`, or until `signal` aborts. The work itself is not cancelled — a
 * provider stop is the adapter's to finish, with its own bounds — but nothing here waits for it past the
 * ceiling, and the timer and listener are removed whichever way it ends.
 */
function settleWithin<T>(work: Promise<T>, ceilingMs: number, signal?: AbortSignal): Promise<Settled<T>> {
  if (signal?.aborted === true) return Promise.resolve({ kind: 'aborted' });
  return new Promise<Settled<T>>((resolve) => {
    let done = false;
    const finish = (outcome: Settled<T>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: 'aborted' });
    const timer = setTimeout(() => finish({ kind: 'expired' }), Math.max(1, ceilingMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish({ kind: 'settled', value }),
      () => finish({ kind: 'failed' })
    );
  });
}

/** Trusted application policy; none of these fields is operator-configurable. */
export const LOCAL_INFERENCE_APPLICATION_LIMITS = {
  maxPromptBytes: 1 * 1024 * 1024,
  maxRequestBytes: 2 * 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  maxCompletionBytes: 1 * 1024 * 1024,
  maxProcessOutputBytes: 512 * 1024
} as const;

/** Build and re-parse the complete LOCAL-A configuration for one profile before adapter use. */
export function assembleLocalInferenceConfig(profile: LocalInferenceProfile): LocalInferenceConfig {
  return parseLocalInferenceConfig({
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    providerId: LOCAL_INFERENCE_PROVIDER_ID,
    executable: profile.executable,
    model: profile.model,
    fixedArguments: profile.fixedArguments,
    port: profile.port,
    contextLimitTokens: profile.contextLimitTokens,
    // The request contract's rule — a request may only lower this, never
    // raise it — is preserved by the adapter; this is only ever the ceiling.
    maxOutputTokens: Math.min(profile.requestDefaults.maxOutputTokens, profile.contextLimitTokens),
    defaultChatTemplateParameters: profile.requestDefaults.chatTemplateParameters,
    maxPromptBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxPromptBytes,
    maxRequestBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxRequestBytes,
    maxResponseBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxResponseBytes,
    maxCompletionBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxCompletionBytes,
    maxProcessOutputBytes: LOCAL_INFERENCE_APPLICATION_LIMITS.maxProcessOutputBytes,
    startupTimeoutMs: profile.startupTimeoutMs,
    healthTimeoutMs: profile.healthTimeoutMs,
    inferenceTimeoutMs: profile.inferenceTimeoutMs,
    shutdownTimeoutMs: profile.shutdownTimeoutMs
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

export class LocalInferenceService
  implements LocalInferenceLifecycleService, OrnithInferenceLeaseService, LocalInferenceRuntimeRelease
{
  private provider: LocalInferenceProvider | null = null;
  private boundProfileFingerprint: string | null = null;
  /** Which profile the retained (or about-to-be-retained) runtime is bound to. Volatile, never persisted. */
  private selectedProfileId: string | null = null;
  /** The one quit-time stop, shared by every call to `stopForQuit`. */
  private quitStop: Promise<LocalInferenceQuitOutcome> | null = null;
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
  private ornithLeaseProfileFingerprint: string | null = null;
  /** Fired by `stop()` when it stops a runtime an Ornith lease is holding. */
  private readonly ornithStopHandlers = new Set<() => void>();
  /**
   * Set only by `releaseForVerification` after it confirmed the stop and no operator action intervened,
   * cleared by any operator Start or Stop, a profile switch, or the one `acquireOrnithLease` that starts
   * the runtime back. While set (and while the active profile still is that profile, enabled and
   * unedited — checked on every read), `state()` reports the stopped runtime as released.
   */
  private releasedForVerification: { readonly profileId: string; readonly fingerprint: string; readonly profileRevision: number } | null = null;
  /**
   * Bumped by every operator lifecycle action (Start, Stop, profile switch). `releaseForVerification`
   * reads it before its stop and sets its mark only if it is unchanged after: an operator Stop that
   * joined the same in-flight provider stop, or a Start that superseded it, leaves no mark behind.
   */
  private lifecycleGeneration = 0;

  constructor(private readonly options: LocalInferenceServiceOptions) {}

  activeProfileId(): string | null {
    return this.selectedProfileId;
  }

  listProfiles(): readonly LocalInferenceProfileSummary[] {
    return summarizeLocalInferenceProfiles(this.options.settings.get().localInference, this.selectedProfileId, this.state().kind);
  }

  selectActiveProfile(profileId: string): void {
    if (this.provider !== null) {
      const kind = this.provider.state().kind;
      if (kind === 'starting' || kind === 'healthy' || kind === 'inferring' || kind === 'stopping') {
        throw new AgentRelayError(
          'BUSY',
          'The local runtime is active. Stop it before switching profiles.',
          { remediation: 'Stop the current runtime in Settings → Local inference, then select the other profile.' }
        );
      }
    }
    const exists = this.options.settings.get().localInference.profiles.some((profile) => profile.id === profileId);
    if (!exists) {
      throw new AgentRelayError('NOT_FOUND', `No local-model profile with id ${profileId}.`);
    }
    this.selectedProfileId = profileId;
    this.releasedForVerification = null;
    this.lifecycleGeneration += 1;
    // A terminal provider bound to the PREVIOUS profile has nothing left to preserve; the next bind
    // constructs fresh against whichever profile is now selected. An active provider was already refused
    // above, so this can only ever discard a stopped/failed/cancelled/timed-out one.
    this.provider = null;
    this.boundProfileFingerprint = null;
  }

  /** Cheap and passive: no provider construction, discovery or HTTP. */
  state(): LocalInferenceState {
    if (this.provider !== null) return this.markReleased(this.provider.state());
    const reason = this.unavailableReason();
    return reason === null ? this.markReleased({ kind: 'stopped' }) : { kind: 'unavailable', reason };
  }
  /**
   * A stopped state carries the release mark only while `releaseForVerification` is what stopped it AND
   * the active profile is still that profile, enabled and unedited: a mark the lease would refuse to
   * start back is cleared here, on read, so the renderer never offers a round that cannot start.
   */
  private markReleased(state: LocalInferenceState): LocalInferenceState {
    const mark = this.releasedForVerification;
    if (state.kind !== 'stopped' || mark === null) return state;
    if (!this.markMatchesActiveProfile(mark)) {
      this.releasedForVerification = null;
      return state;
    }
    return { kind: 'stopped', releasedForVerification: true };
  }
  private markMatchesActiveProfile(mark: { readonly profileId: string; readonly fingerprint: string; readonly profileRevision: number }): boolean {
    const profile = this.activeProfile();
    // `enabled` is deliberately outside the fingerprint (see `localInferenceProfileFingerprint`), so a
    // disabled profile has to be refused here by name: the lease would refuse it, so the mark must too.
    return this.options.settings.localInferenceRevision() === mark.profileRevision &&
      profile !== null && profile.id === mark.profileId && profile.enabled &&
      localInferenceProfileFingerprint(profile) === mark.fingerprint;
  }
  /* ------------------------------------------------------------------ */
  /* Relay's own verification: release (LocalInferenceRuntimeRelease)    */
  /* ------------------------------------------------------------------ */
  async releaseForVerification(signal?: AbortSignal): Promise<LocalInferenceReleaseOutcome> {
    if (signal?.aborted === true) return { kind: 'unavailable', reason: 'The release was cancelled before it began.' };
    if (this.ornithLeaseToken !== null) return { kind: 'in_use' };
    const reason = this.isDisabledAndUnbound();
    if (reason !== null) return { kind: 'unavailable', reason };
    const provider = this.provider;
    if (provider === null) return { kind: 'not_running' };
    const state = provider.state();
    switch (state.kind) {
      case 'healthy':
        break;
      case 'starting':
      case 'stopping':
      case 'inferring':
        // A startup the operator just asked for, a stop already under way, or an inference outside a
        // lease: none of them is ours to cut short.
        return { kind: 'unavailable', reason: `The local runtime is ${state.kind}.` };
      default:
        return { kind: 'not_running' };
    }
    const profile = this.activeProfile();
    const profileId = this.selectedProfileId;
    const fingerprint = this.boundProfileFingerprint;
    if (profile === null || profileId === null || fingerprint === null) {
      return { kind: 'unavailable', reason: 'The retained local runtime’s profile is no longer configured.' };
    }
    const generation = this.lifecycleGeneration;
    const profileRevision = this.options.settings.localInferenceRevision();
    // No await between the lease check above and this stop: a lease acquired from here on meets a runtime
    // already stopping and fails its own health check, instead of being cut off mid-round. The stop is the
    // provider's own (already bounded by the profile's shutdown budget inside the adapter); this wait adds
    // the ceiling the caller can rely on, and the caller's signal.
    const settled = await settleWithin(
      this.stopRetainedProvider(provider),
      profile.shutdownTimeoutMs + LOCAL_RUNTIME_RELEASE_GRACE_MS,
      signal
    );
    if (settled.kind === 'expired') {
      return {
        kind: 'unavailable',
        reason: `The local runtime did not confirm it stopped within ${profile.shutdownTimeoutMs + LOCAL_RUNTIME_RELEASE_GRACE_MS}ms.`
      };
    }
    if (settled.kind === 'aborted') return { kind: 'unavailable', reason: 'The release was cancelled.' };
    if (settled.kind === 'failed') return { kind: 'unavailable', reason: 'The local runtime stop failed; verification can proceed without a confirmed release.' };
    const stopped = settled.value;
    if (stopped.kind !== 'stopped') {
      return { kind: 'unavailable', reason: 'reason' in stopped ? stopped.reason : `The local runtime is ${stopped.kind}.` };
    }
    // An operator Start, Stop or profile switch that landed while the stop was in flight owns the
    // outcome: the runtime is stopped either way, but it is theirs, and nothing starts it back.
    if (this.lifecycleGeneration !== generation || this.options.settings.localInferenceRevision() !== profileRevision) {
      return { kind: 'unavailable', reason: 'An operator action or profile edit superseded the release; Agent Relay will not start the runtime back.' };
    }
    this.releasedForVerification = { profileId, fingerprint, profileRevision };
    return { kind: 'released' };
  }
  /**
   * The provider-side half of `stop()`: delegate once, and release ownership only on the exact
   * confirmation, guarded against an older completion clearing a provider a later operation selected.
   * `stop()` adds the operator's bookkeeping around it; `releaseForVerification` deliberately does not.
   */
  private stopRetainedProvider(provider: LocalInferenceProvider): Promise<LocalInferenceState> {
    // Delegate immediately. LOCAL-A owns cancellation, concurrent/idempotent
    // stop joining, and transition validation for this exact provider.
    return provider.stop().then((stopped) => {
      // Exact confirmation is the only evidence that releases an owning
      // provider. The identity guard prevents an older completion from
      // clearing a provider selected by a later operation.
      if (stopped.kind === 'stopped' && this.provider === provider) {
        this.provider = null;
        this.boundProfileFingerprint = null;
      }
      return stopped;
    });
  }

  capabilities(): Promise<LocalInferenceCapabilities> {
    const reason = this.isDisabledAndUnbound();
    if (reason !== null) return Promise.resolve(this.disabledCapabilities(reason));
    return this.bindProvider().capabilities();
  }

  start(): Promise<LocalInferenceState> {
    // An operator Start supersedes a release: what runs from here on is theirs to stop, not ours to resume.
    this.releasedForVerification = null;
    this.lifecycleGeneration += 1;
    const reason = this.isDisabledAndUnbound();
    if (reason !== null) return Promise.resolve({ kind: 'unavailable', reason });
    return this.bindProvider().start();
  }

  health(): Promise<LocalInferenceState> {
    const reason = this.isDisabledAndUnbound();
    if (reason !== null) return Promise.resolve({ kind: 'unavailable', reason });
    return this.bindProvider().health();
  }

  stop(): Promise<LocalInferenceState> {
    // An operator Stop is theirs: nothing stopped from here on is started back by a resume, and a
    // `releaseForVerification` whose stop is still in flight sees the generation move and leaves no mark.
    this.releasedForVerification = null;
    this.lifecycleGeneration += 1;
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
    return this.stopRetainedProvider(provider);
  }

  /**
   * Quitting: stop the runtime this service owns, through the ordinary operator `stop()` (which also tells
   * an Ornith run using it to unwind), and wait at most the profile's shutdown budget plus a grace — the
   * provider's own stop escalates to SIGKILL within that budget. A runtime that is starting, healthy,
   * inferring or already stopping is stopped or joined the same way `stop()` does it. The first call's
   * outcome is shared by every later one, so a repeated quit never starts a second stop.
   */
  stopForQuit(): Promise<LocalInferenceQuitOutcome> {
    if (this.quitStop !== null) return this.quitStop;
    if (this.provider === null) {
      this.quitStop = Promise.resolve({ kind: 'not_running' });
      return this.quitStop;
    }
    const ceilingMs =
      (this.activeProfile()?.shutdownTimeoutMs ?? LOCAL_INFERENCE_LIMITS.shutdownTimeoutMsMax) + LOCAL_RUNTIME_RELEASE_GRACE_MS;
    this.quitStop = settleWithin(this.stop(), ceilingMs).then((settled): LocalInferenceQuitOutcome => {
      if (settled.kind === 'settled' && settled.value.kind === 'stopped') return { kind: 'stopped' };
      if (settled.kind === 'expired') {
        return { kind: 'unconfirmed', reason: `The local runtime did not confirm it stopped within ${ceilingMs}ms.` };
      }
      if (settled.kind === 'settled') {
        const state = settled.value;
        return { kind: 'unconfirmed', reason: 'reason' in state ? state.reason : `The local runtime is ${state.kind}.` };
      }
      return { kind: 'unconfirmed', reason: 'The local runtime stop failed.' };
    });
    return this.quitStop;
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
    const reason = this.isDisabledAndUnbound();
    if (reason !== null) {
      return Promise.resolve({
        kind: 'failed',
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId: this.options.ids.next(),
        reason,
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

  async acquireOrnithLease(
    expectedProfileId: string,
    expectedProfileFingerprint: string,
    signal?: AbortSignal
  ): Promise<OrnithHealthyLease> {
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
        this.ornithLeaseProfileFingerprint = null;
        this.ornithStopHandlers.clear();
      }
    };

    try {
      if (this.selectedProfileId !== expectedProfileId) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          this.selectedProfileId === null
            ? 'No local-model profile is currently active.'
            : 'A different local-model profile is currently active than the one this task is bound to.',
          {
            remediation:
              'Select and start this task’s bound profile in Settings → Local inference, and confirm it is Healthy.'
          }
        );
      }
      // The one start on this path: a runtime Agent Relay itself stopped before its own verification,
      // and only when its mark names exactly this task's bound profile at exactly its configuration and
      // that profile is still enabled and unedited. The lease token is already claimed above, so no
      // release can stop it again in between. A runtime the operator stopped is never started.
      const mark = this.releasedForVerification;
      const retainedKind = this.provider === null ? 'stopped' : this.provider.state().kind;
      if (
        mark !== null && retainedKind === 'stopped' &&
        mark.profileId === expectedProfileId && mark.fingerprint === expectedProfileFingerprint &&
        this.markMatchesActiveProfile(mark)
      ) {
        this.releasedForVerification = null;
        const started = await this.bindProvider().start(signal);
        if (started.kind !== 'healthy') {
          throw new AgentRelayError(
            'VALIDATION_FAILED',
            `The local runtime Agent Relay released before verification could not be started back: ${'reason' in started ? started.reason : started.kind}.`,
            { remediation: 'Start the local runtime in Settings → Local inference and confirm it is Healthy.' }
          );
        }
      }
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

      const profile = this.activeProfile();
      if (profile === null) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'The retained local runtime’s profile is no longer configured.',
          { remediation: 'Stop the runtime, review Settings → Local inference, then start it again.' }
        );
      }
      // Refused only here, at the start of a NEW round — never inside `recheckOrnithLease` or
      // `inferForOrnith`, which only ever act on a lease this same method already granted. Disabling a
      // profile mid-round must not yank a turn already in flight; it must stop the NEXT round from
      // starting against it, exactly like a deleted or edited profile already does.
      if (!profile.enabled) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          `This task’s bound local-model profile "${profile.displayName}" is disabled.`,
          {
            remediation:
              'Re-enable the profile in Settings → Local inference, or switch this task to a different one.'
          }
        );
      }
      const currentFingerprint = localInferenceProfileFingerprint(profile);
      if (this.boundProfileFingerprint !== currentFingerprint) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'The retained local runtime does not match the saved profile configuration.',
          { remediation: 'Stop the runtime, review Settings, then start it manually again.' }
        );
      }
      if (currentFingerprint !== expectedProfileFingerprint) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'This task’s bound profile was edited since it was approved.',
          {
            remediation:
              'The model, executable or budget for this profile changed after this task started using it. Review the change, then retry once you are sure it is still safe.'
          }
        );
      }
      const config = assembleLocalInferenceConfig(profile);
      const lease: OrnithHealthyLease = {
        runtimeInstanceId: checked.runtimeInstanceId,
        providerId: config.providerId,
        modelId: config.model.id,
        modelProfileId: profile.id,
        modelProfileDisplayName: profile.displayName,
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
      this.ornithLeaseProfileFingerprint = currentFingerprint;
      return lease;
    } catch (error) {
      release();
      throw error;
    }
  }

  async recheckOrnithLease(lease: OrnithHealthyLease, signal?: AbortSignal): Promise<boolean> {
    if (this.ornithLeaseToken === null || this.ornithLeaseOwner !== lease) return false;
    if (this.selectedProfileId !== lease.modelProfileId) return false;
    const provider = this.provider;
    if (provider === null || provider !== this.ornithLeaseProvider) return false;
    const state = provider.state();
    if (state.kind !== 'healthy' || state.runtimeInstanceId !== lease.runtimeInstanceId) return false;
    const profile = this.activeProfile();
    if (profile === null) return false;
    const currentFingerprint = localInferenceProfileFingerprint(profile);
    if (currentFingerprint !== this.ornithLeaseProfileFingerprint || currentFingerprint !== this.boundProfileFingerprint) return false;
    const config = assembleLocalInferenceConfig(profile);
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
    if (this.selectedProfileId !== lease.modelProfileId) {
      return failed('The active local-model profile changed during this run.');
    }
    const provider = this.provider;
    if (provider === null || provider !== this.ornithLeaseProvider) {
      return failed('The local runtime is no longer retained.');
    }
    const profile = this.activeProfile();
    if (profile === null) {
      return failed('The retained runtime’s profile is no longer configured.');
    }
    const currentFingerprint = localInferenceProfileFingerprint(profile);
    if (currentFingerprint !== this.ornithLeaseProfileFingerprint || currentFingerprint !== this.boundProfileFingerprint) {
      return failed('The saved local-inference configuration changed during this run.');
    }
    const config = assembleLocalInferenceConfig(profile);
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
    const afterProfile = this.activeProfile();
    const afterFingerprint = afterProfile === null ? null : localInferenceProfileFingerprint(afterProfile);
    const afterConfig = afterProfile === null ? null : assembleLocalInferenceConfig(afterProfile);
    const afterState = provider.state();
    if (
      this.ornithLeaseOwner !== lease ||
      this.provider !== provider ||
      this.ornithLeaseProvider !== provider ||
      this.selectedProfileId !== lease.modelProfileId ||
      afterFingerprint === null ||
      afterFingerprint !== this.ornithLeaseProfileFingerprint ||
      afterFingerprint !== this.boundProfileFingerprint ||
      afterConfig === null ||
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

  /** The currently SELECTED profile's live configuration, or null if none is selected or it was removed. */
  private activeProfile(): LocalInferenceProfile | null {
    if (this.selectedProfileId === null) return null;
    return this.options.settings.get().localInference.profiles.find((profile) => profile.id === this.selectedProfileId) ?? null;
  }

  /** Why nothing may be constructed right now, or null when it may. Checked before every lifecycle method. */
  private isDisabledAndUnbound(): string | null {
    if (this.provider !== null) return null;
    return this.unavailableReason();
  }

  private unavailableReason(): string | null {
    if (!this.options.settings.get().localInference.enabled) return LOCAL_INFERENCE_DISABLED_REASON;
    if (this.selectedProfileId === null) return NO_ACTIVE_PROFILE_REASON;
    return null;
  }

  private disabledCapabilities(reason: string): LocalInferenceCapabilities {
    const profile = this.activeProfile();
    return {
      protocol: LOCAL_INFERENCE_PROTOCOL,
      contractVersion: LOCAL_INFERENCE_CONTRACT_VERSION,
      providerId: LOCAL_INFERENCE_PROVIDER_ID,
      modelId: profile?.model.id ?? 'none',
      available: false,
      unavailableReason: reason,
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
    const profile = this.activeProfile();
    if (profile === null) {
      // isDisabledAndUnbound()/unavailableReason() already refused every public entry point before a
      // provider could be requested while unselected; a caller reaching this with no provider retained
      // and no profile selected is an internal contract violation, not a user-facing state.
      throw new AgentRelayError('INTERNAL', 'No local-model profile is selected; cannot bind a provider.');
    }
    const fingerprint = localInferenceProfileFingerprint(profile);

    if (this.provider !== null && this.boundProfileFingerprint !== fingerprint) {
      const state = this.provider.state();
      // A never-started provider has no process handle to preserve. Every
      // active or terminal failure state remains pinned until stop confirms it.
      if (state.kind === 'stopped' || state.kind === 'unavailable') {
        this.provider = null;
        this.boundProfileFingerprint = null;
      }
    }

    if (this.provider === null) {
      const config = assembleLocalInferenceConfig(profile);
      this.provider = this.options.createProvider(config);
      this.boundProfileFingerprint = fingerprint;
    }
    return this.provider;
  }

}
