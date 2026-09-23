import { describe, expect, it } from 'vitest';
import type { LocalInferenceProvider, SettingsRepository } from '../../src/main/ports';
import {
  assembleLocalInferenceConfig,
  LOCAL_INFERENCE_APPLICATION_LIMITS,
  LOCAL_INFERENCE_PROVIDER_ID,
  LocalInferenceService
} from '../../src/main/services/local-inference-service';
import { localInferenceProfileFingerprint } from '../../src/main/services/local-inference-profile-fingerprint';
import { defaultSettings } from '../../src/main/container';
import { SequentialIdGenerator } from '../../src/main/infra/clock';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  LOCAL_INFERENCE_LIMITS,
  LOCAL_INFERENCE_PROTOCOL,
  type LocalInferenceCapabilities,
  type LocalInferenceOutcome,
  type LocalInferenceProfile,
  type LocalInferenceRequest,
  type LocalInferenceState
} from '../../src/shared/domain/local-inference';
import type { Settings } from '../../src/shared/domain/models';

/** A fresh deterministic id source for tests that do not care about its output. */
function testIds(): SequentialIdGenerator {
  return new SequentialIdGenerator('svc-test');
}

function enabledDefaults(): Settings {
  const settings = defaultSettings({ dataDir: 'C:\\data', documentsDir: 'C:\\docs' });
  const localInference = settings.localInference;
  return {
    ...settings,
    localInference: {
      ...localInference,
      enabled: true,
      profiles: localInference.profiles.map((profile) =>
        profile.id === localInference.defaultProfileId ? { ...profile, enabled: true } : profile
      )
    }
  };
}

class MutableSettings implements SettingsRepository {
  // Lifecycle operations are only exercised through a provider when local
  // inference is enabled; these tests are about provider ownership and
  // delegation, not the disabled short-circuit, so they opt in up front.
  value = enabledDefaults();

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch };
    return this.value;
  }

  /** The current 'default' profile — the only one these tests configure. */
  defaultProfile(): LocalInferenceProfile {
    const localInference = this.value.localInference;
    const profile = localInference.profiles.find((candidate) => candidate.id === localInference.defaultProfileId);
    if (!profile) throw new Error('test fixture is missing its default profile');
    return profile;
  }

  /** The 'default' profile's current fingerprint — what a fresh `acquireOrnithLease` call should pass. */
  defaultFingerprint(): string {
    return localInferenceProfileFingerprint(this.defaultProfile());
  }

  /** Patches only the 'default' profile's runtime config, leaving id/displayName/enabled/adapterKind alone. */
  patchDefaultProfile(patch: Partial<LocalInferenceProfile>): void {
    const localInference = this.value.localInference;
    this.update({
      localInference: {
        ...localInference,
        profiles: localInference.profiles.map((profile) =>
          profile.id === localInference.defaultProfileId ? { ...profile, ...patch } : profile
        )
      }
    });
  }
}

class StubProvider implements LocalInferenceProvider {
  current: LocalInferenceState = { kind: 'stopped' };
  capabilityCalls = 0;
  healthCalls = 0;
  stopCalls = 0;
  launches = 0;
  stopAttempts = 0;
  ownedProcess = false;
  stopResult: LocalInferenceState = { kind: 'stopped' };
  startGate: Promise<void> | null = null;
  stopGate: Promise<void> | null = null;
  inferGate: Promise<void> | null = null;
  /** Every request `infer` actually received, in order. */
  readonly inferCalls: LocalInferenceRequest[] = [];
  /** Overrides the outcome the next `infer` call returns. */
  inferOutcome: LocalInferenceOutcome | null = null;
  private stopping: Promise<LocalInferenceState> | null = null;

  state(): LocalInferenceState {
    return this.current;
  }

  async capabilities(): Promise<LocalInferenceCapabilities> {
    this.capabilityCalls += 1;
    return {
      protocol: LOCAL_INFERENCE_PROTOCOL,
      contractVersion: LOCAL_INFERENCE_CONTRACT_VERSION,
      providerId: LOCAL_INFERENCE_PROVIDER_ID,
      modelId: 'local-model',
      available: true,
      unavailableReason: null,
      executableSource: 'path',
      runtimeVersion: 'fake-1',
      supportsChatCompletions: true,
      supportsStreaming: false,
      supportsUsageWhenReported: true,
      supportsChatTemplateParameters: true,
      inferenceVerified: false
    };
  }

  async start(): Promise<LocalInferenceState> {
    if (this.current.kind !== 'stopped') throw new Error('start is not legal now');
    this.current = { kind: 'starting', runtimeInstanceId: 'runtime-1' };
    this.launches += 1;
    this.ownedProcess = true;
    if (this.startGate !== null) await this.startGate;
    if (this.state().kind === 'stopped') return this.current;
    this.current = { kind: 'healthy', runtimeInstanceId: 'runtime-1' };
    return this.current;
  }

  async health(): Promise<LocalInferenceState> {
    this.healthCalls += 1;
    if (this.current.kind !== 'healthy') throw new Error('health is not legal now');
    return this.current;
  }

  async infer(request: LocalInferenceRequest): Promise<LocalInferenceOutcome> {
    if (this.current.kind !== 'healthy') throw new Error('infer is not legal now');
    this.inferCalls.push(request);
    if (this.inferGate !== null) await this.inferGate;
    if (this.inferOutcome !== null) return this.inferOutcome;
    return {
      kind: 'completed',
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      response: {
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId: request.requestId,
        providerId: LOCAL_INFERENCE_PROVIDER_ID,
        modelId: 'local-model',
        runtimeVersion: 'fake-1',
        runtimeInstanceId: 'runtime-1',
        durationMs: 5,
        completion: 'stub completion',
        promptTokens: 3,
        completionTokens: 2,
        runtimeResponseId: null,
        finishReason: { kind: 'stop' }
      }
    };
  }

  stop(): Promise<LocalInferenceState> {
    this.stopCalls += 1;
    if (this.stopping === null) {
      this.stopping = this.attemptStop().finally(() => {
        this.stopping = null;
      });
    }
    return this.stopping;
  }

  private async attemptStop(): Promise<LocalInferenceState> {
    this.stopAttempts += 1;
    if (this.stopGate !== null) await this.stopGate;
    this.current = this.stopResult;
    if (this.current.kind === 'stopped') this.ownedProcess = false;
    return this.current;
  }
}

class HealthCleanupProvider extends StubProvider {
  cleanupStarts = 0;
  releaseCleanup!: () => void;
  private cleanup: Promise<LocalInferenceState> | null = null;

  constructor() {
    super();
    this.current = { kind: 'healthy', runtimeInstanceId: 'runtime-1' };
  }

  override health(): Promise<LocalInferenceState> {
    this.healthCalls += 1;
    if (this.current.kind !== 'healthy') return Promise.reject(new Error('health is not legal now'));
    if (this.cleanup === null) {
      this.cleanupStarts += 1;
      this.cleanup = new Promise<void>((resolve) => {
        this.releaseCleanup = resolve;
      }).then(() => {
        this.current = {
          kind: 'failed',
          reason: 'The runtime tree could not be confirmed stopped.'
        };
        return this.current;
      });
    }
    return this.cleanup;
  }

  override stop(): Promise<LocalInferenceState> {
    this.stopCalls += 1;
    return this.cleanup ?? Promise.reject(new Error('health cleanup was not started'));
  }
}

/** Constructs a service and immediately selects the 'default' profile — every lifecycle method is a
 *  no-op unavailable DTO until a profile is selected, and every test here except the disabled/unbound
 *  ones is about what happens once one is. */
function selectedService(options: {
  settings: SettingsRepository;
  createProvider: (config: ReturnType<typeof assembleLocalInferenceConfig>) => LocalInferenceProvider;
  ids: SequentialIdGenerator;
}): LocalInferenceService {
  const service = new LocalInferenceService(options);
  service.selectActiveProfile('default');
  return service;
}

describe('local inference configuration assembly', () => {
  it('maps only persisted fields and supplies bounded application policy', () => {
    const profile = new MutableSettings().defaultProfile();
    const config = assembleLocalInferenceConfig({ ...profile, contextLimitTokens: 8 });

    expect(config.providerId).toBe('local-llama-cpp');
    expect(config).not.toHaveProperty('workingDirectory');
    expect(config.maxOutputTokens).toBe(8);
    expect(config.executable).toEqual(profile.executable);
    expect(config.model).toEqual(profile.model);
    expect(config.fixedArguments).toEqual(profile.fixedArguments);
    expect(config.port).toBe(profile.port);
    expect(config.startupTimeoutMs).toBe(profile.startupTimeoutMs);
    expect(config.healthTimeoutMs).toBe(profile.healthTimeoutMs);
    expect(config.inferenceTimeoutMs).toBe(profile.inferenceTimeoutMs);
    expect(config.shutdownTimeoutMs).toBe(profile.shutdownTimeoutMs);
    expect(config.maxPromptBytes).toBe(LOCAL_INFERENCE_APPLICATION_LIMITS.maxPromptBytes);
    expect(config.maxOutputTokens).toBeLessThanOrEqual(config.contextLimitTokens);
    expect(config.maxPromptBytes).toBeLessThanOrEqual(LOCAL_INFERENCE_LIMITS.promptBytesMax);
    expect(config.maxRequestBytes).toBeLessThanOrEqual(LOCAL_INFERENCE_LIMITS.requestBytesMax);
    expect(config.maxResponseBytes).toBeLessThanOrEqual(LOCAL_INFERENCE_LIMITS.responseBytesMax);
    expect(config.maxCompletionBytes).toBeLessThanOrEqual(LOCAL_INFERENCE_LIMITS.completionBytesMax);
    expect(config.maxProcessOutputBytes).toBeLessThanOrEqual(
      LOCAL_INFERENCE_LIMITS.processOutputBytesMax
    );
  });

  it('maps requestDefaults into the assembled config', () => {
    const profile = new MutableSettings().defaultProfile();
    const config = assembleLocalInferenceConfig({
      ...profile,
      requestDefaults: { maxOutputTokens: 777, chatTemplateParameters: { enable_thinking: false } }
    });
    expect(config.maxOutputTokens).toBe(777);
    expect(config.defaultChatTemplateParameters).toEqual({ enable_thinking: false });
  });
});

describe('LocalInferenceService disabled behaviour', () => {
  it('performs no provider construction and returns a disabled DTO when disabled and unbound', async () => {
    const settings = new MutableSettings();
    settings.update({ localInference: { ...settings.get().localInference, enabled: false } });
    let constructions = 0;
    const service = new LocalInferenceService({
      settings,
      createProvider: () => {
        constructions += 1;
        return new StubProvider();
      },
      ids: testIds()
    });

    expect(service.state()).toEqual({
      kind: 'unavailable',
      reason: 'Local inference is disabled in Settings.'
    });
    const capabilities = await service.capabilities();
    expect(capabilities.available).toBe(false);
    expect(capabilities.unavailableReason).toBe('Local inference is disabled in Settings.');
    expect((await service.start()).kind).toBe('unavailable');
    expect((await service.health()).kind).toBe('unavailable');
    expect(await service.stop()).toEqual({ kind: 'stopped' });
    expect(constructions).toBe(0);
  });

  it('returns an unavailable DTO naming no active profile when enabled but nothing is selected', async () => {
    const settings = new MutableSettings();
    let constructions = 0;
    const service = new LocalInferenceService({
      settings,
      createProvider: () => {
        constructions += 1;
        return new StubProvider();
      },
      ids: testIds()
    });

    expect(service.state()).toEqual({
      kind: 'unavailable',
      reason: 'No local-model profile is selected. Choose one in Settings → Local inference.'
    });
    expect((await service.start()).kind).toBe('unavailable');
    expect(constructions).toBe(0);
  });

  it('keeps delegating to a retained provider even after settings become disabled', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    let constructions = 0;
    const service = selectedService({
      settings,
      createProvider: () => {
        constructions += 1;
        return provider;
      },
      ids: testIds()
    });

    await service.start();
    expect(service.state().kind).toBe('healthy');

    settings.update({ localInference: { ...settings.get().localInference, enabled: false } });
    // Still bound to the same active provider: health must still reach it,
    // not the disabled short-circuit.
    await service.health();
    expect(provider.healthCalls).toBe(1);
    expect(constructions).toBe(1);

    expect(await service.stop()).toEqual({ kind: 'stopped' });
    // Now unbound and disabled: the next call must not construct a provider.
    expect(service.state()).toEqual({
      kind: 'unavailable',
      reason: 'Local inference is disabled in Settings.'
    });
    await service.capabilities();
    expect(constructions).toBe(1);
  });
});

describe('LocalInferenceService ownership and lifecycle delegation', () => {
  it('is passive for state reads and delegates all explicit operations to one provider', async () => {
    const settings = new MutableSettings();
    const providers: StubProvider[] = [];
    const service = selectedService({
      settings,
      createProvider: () => {
        const provider = new StubProvider();
        providers.push(provider);
        return provider;
      },
      ids: testIds()
    });

    expect(service.state()).toEqual({ kind: 'stopped' });
    expect(providers).toHaveLength(0);
    await service.capabilities();
    await service.start();
    expect(service.state().kind).toBe('healthy');
    await service.health();
    await service.stop();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.capabilityCalls).toBe(1);
    expect(providers[0]?.healthCalls).toBe(1);
    expect(providers[0]?.stopCalls).toBe(1);
  });

  it('binds simultaneous starts to one provider so only one runtime can launch', async () => {
    const settings = new MutableSettings();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = new StubProvider();
    provider.startGate = gate;
    let constructions = 0;
    const service = selectedService({
      settings,
      createProvider: () => { constructions += 1; return provider; },
      ids: testIds()
    });

    const first = service.start();
    const second = service.start();
    await Promise.resolve();
    expect(provider.launches).toBe(1);
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(constructions).toBe(1);
    expect(provider.launches).toBe(1);
    await service.stop();
  });

  it('delegates stop during blocked startup before startup is released', async () => {
    const settings = new MutableSettings();
    let release!: () => void;
    const provider = new StubProvider();
    provider.startGate = new Promise<void>((resolve) => { release = resolve; });
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });

    const starting = service.start();
    const stopping = service.stop();
    await Promise.resolve();
    expect(provider.stopCalls).toBe(1);
    expect(await stopping).toEqual({ kind: 'stopped' });
    expect(provider.ownedProcess).toBe(false);
    release();
    expect(await starting).toEqual({ kind: 'stopped' });
  });

  it('delegates concurrent stops to the same provider cleanup', async () => {
    const settings = new MutableSettings();
    let release!: () => void;
    const provider = new StubProvider();
    provider.stopGate = new Promise<void>((resolve) => { release = resolve; });
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();

    const first = service.stop();
    const second = service.stop();
    expect(provider.stopCalls).toBe(2);
    expect(provider.stopAttempts).toBe(1);
    release();
    await expect(first).resolves.toEqual({ kind: 'stopped' });
    await expect(second).resolves.toEqual({ kind: 'stopped' });
    expect(provider.stopAttempts).toBe(1);
    expect(service.state()).toEqual({ kind: 'stopped' });
  });

  it('does not defer health transition validation while startup is blocked', async () => {
    const settings = new MutableSettings();
    let release!: () => void;
    const provider = new StubProvider();
    provider.startGate = new Promise<void>((resolve) => { release = resolve; });
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });

    const starting = service.start();
    await expect(service.health()).rejects.toThrow('health is not legal now');
    expect(provider.healthCalls).toBe(1);
    const stopping = service.stop();
    await expect(stopping).resolves.toEqual({ kind: 'stopped' });
    release();
    await expect(starting).resolves.toEqual({ kind: 'stopped' });
  });

  it('routes stop to an in-flight health cleanup and retains uncertain ownership', async () => {
    const settings = new MutableSettings();
    const provider = new HealthCleanupProvider();
    let constructions = 0;
    const service = selectedService({
      settings,
      createProvider: () => { constructions += 1; return provider; },
      ids: testIds()
    });

    const health = service.health();
    const stopping = service.stop();
    expect(provider.cleanupStarts).toBe(1);
    expect(provider.stopCalls).toBe(1);
    provider.releaseCleanup();
    await expect(health).resolves.toMatchObject({ kind: 'failed' });
    await expect(stopping).resolves.toMatchObject({ kind: 'failed' });
    settings.patchDefaultProfile({ port: 19092 });
    await service.capabilities();
    expect(constructions).toBe(1);
  });

  it('defers changed settings until a confirmed stop releases the provider', async () => {
    const settings = new MutableSettings();
    const configs: number[] = [];
    const providers: StubProvider[] = [];
    const service = selectedService({
      settings,
      createProvider: (config) => {
        configs.push(config.port);
        const provider = new StubProvider();
        providers.push(provider);
        return provider;
      },
      ids: testIds()
    });

    await service.start();
    settings.patchDefaultProfile({ port: 19090 });
    await service.capabilities();
    expect(configs).toEqual([8080]);
    expect(providers[0]?.capabilityCalls).toBe(1);
    await service.stop();
    await service.capabilities();
    expect(configs).toEqual([8080, 19090]);
  });

  it('retains the owning provider when cleanup is not confirmed', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    provider.stopResult = { kind: 'failed', reason: 'The runtime tree could not be confirmed stopped.' };
    let constructions = 0;
    const service = selectedService({
      settings,
      createProvider: () => { constructions += 1; return provider; },
      ids: testIds()
    });
    await service.start();
    settings.patchDefaultProfile({ port: 19091 });

    expect((await service.stop()).kind).toBe('failed');
    await service.capabilities();
    expect(constructions).toBe(1);
    expect(provider.capabilityCalls).toBe(1);
  });
});

describe('LocalInferenceService.selectActiveProfile', () => {
  it('refuses to switch while the retained runtime is active, and succeeds once stopped', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();

    expect(() => service.selectActiveProfile('default')).toThrow('The local runtime is active');
    await service.stop();
    expect(() => service.selectActiveProfile('default')).not.toThrow();
  });

  it('rejects an unknown profile id', () => {
    const settings = new MutableSettings();
    const service = new LocalInferenceService({ settings, createProvider: () => new StubProvider(), ids: testIds() });
    expect(() => service.selectActiveProfile('does-not-exist')).toThrow('No local-model profile with id');
  });

  it('reports activeProfileId and listProfiles consistently with the selection', () => {
    const settings = new MutableSettings();
    const service = new LocalInferenceService({ settings, createProvider: () => new StubProvider(), ids: testIds() });
    expect(service.activeProfileId()).toBeNull();
    expect(service.listProfiles().every((summary) => summary.activity === 'inactive')).toBe(true);

    service.selectActiveProfile('default');
    expect(service.activeProfileId()).toBe('default');
    const summary = service.listProfiles().find((candidate) => candidate.id === 'default');
    expect(summary).toMatchObject({ activity: 'active', activeStateKind: 'stopped' });
  });
});

describe('LocalInferenceService: Ornith lease profile identity', () => {
  it('acquireOrnithLease fails closed when the requested profile is not the one currently selected', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();

    await expect(
      service.acquireOrnithLease('some-other-profile', settings.defaultFingerprint())
    ).rejects.toThrow('A different local-model profile is currently active');
  });

  it('acquireOrnithLease fails closed when no profile is selected at all', async () => {
    const settings = new MutableSettings();
    const service = new LocalInferenceService({ settings, createProvider: () => new StubProvider(), ids: testIds() });

    await expect(
      service.acquireOrnithLease('default', settings.defaultFingerprint())
    ).rejects.toThrow('No local-model profile is currently active');
  });

  it('acquireOrnithLease fails closed when the retained runtime no longer matches the saved profile', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();
    const staleFingerprint = settings.defaultFingerprint();
    // The retained provider was bound before this edit and is never rebuilt on its own — it keeps
    // running against the OLD config, so this is a mismatch between the retained runtime and Settings,
    // not (yet) a mismatch between Settings and what this task recorded at bind time.
    settings.patchDefaultProfile({ port: 19099 });

    await expect(
      service.acquireOrnithLease('default', staleFingerprint)
    ).rejects.toThrow('The retained local runtime does not match the saved profile configuration.');
  });

  it('acquireOrnithLease fails closed when the profile was edited and restarted since this task bound it', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();
    const boundFingerprint = settings.defaultFingerprint();
    await service.stop();
    settings.patchDefaultProfile({ port: 19099 });
    // The retained runtime IS restarted against the new config, so it matches Settings exactly — the
    // only stale thing left is this task's OWN recorded fingerprint from before the edit.
    await service.start();

    await expect(
      service.acquireOrnithLease('default', boundFingerprint)
    ).rejects.toThrow('This task’s bound profile was edited since it was approved.');
  });

  it('succeeds and carries the profile’s id and display name when everything matches', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();

    const lease = await service.acquireOrnithLease('default', settings.defaultFingerprint());
    expect(lease.modelProfileId).toBe('default');
    expect(lease.modelProfileDisplayName).toBe(settings.defaultProfile().displayName);
    lease.release();
  });

  it('refuses a NEW round against a profile disabled since this task last ran, without touching its fingerprint', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();
    const fingerprint = settings.defaultFingerprint();

    // Disabling alone must not change the fingerprint — `enabled` is deliberately excluded from it — so
    // this is purely the new `enabled` check, not a stale-config rejection.
    settings.patchDefaultProfile({ enabled: false });
    expect(settings.defaultFingerprint()).toBe(fingerprint);

    await expect(service.acquireOrnithLease('default', fingerprint)).rejects.toThrow(
      'This task’s bound local-model profile "Local model" is disabled.'
    );
  });

  it('does not interrupt a round already holding a lease when its profile is disabled mid-round', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();
    const lease = await service.acquireOrnithLease('default', settings.defaultFingerprint());

    settings.patchDefaultProfile({ enabled: false });

    // `recheckOrnithLease`/`inferForOrnith` never re-check `enabled` — only a NEW `acquireOrnithLease`
    // call does. The turn already granted keeps working.
    expect(await service.recheckOrnithLease(lease)).toBe(true);
    lease.release();
  });

  it('a second, untouched profile’s edits never invalidate a lease bound to the first', async () => {
    const settings = new MutableSettings();
    const localInference = settings.get().localInference;
    settings.update({
      localInference: {
        ...localInference,
        profiles: [
          ...localInference.profiles,
          {
            ...settings.defaultProfile(),
            id: 'second',
            displayName: 'Second profile',
            port: 8099
          }
        ]
      }
    });
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();
    const fingerprint = settings.defaultFingerprint();

    // Editing the OTHER, unselected profile must not affect the bound lease's identity check.
    const current = settings.get().localInference;
    settings.update({
      localInference: {
        ...current,
        profiles: current.profiles.map((profile) =>
          profile.id === 'second' ? { ...profile, port: 8100 } : profile
        )
      }
    });

    const lease = await service.acquireOrnithLease('default', fingerprint);
    expect(lease.modelProfileId).toBe('default');
    lease.release();
  });
});

describe('LocalInferenceService.runTestInference', () => {
  it('returns BUSY without dispatching while an Ornith lease owns the retained runtime', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();
    const lease = await service.acquireOrnithLease('default', settings.defaultFingerprint());
    expect(lease.contextLimitTokens).toBe(settings.defaultProfile().contextLimitTokens);
    expect(lease.maxOutputTokens).toBe(settings.defaultProfile().requestDefaults.maxOutputTokens);

    const outcome = await service.runTestInference('must not dispatch');

    expect(outcome).toMatchObject({ kind: 'failed', dispatchOutcome: 'not_dispatched' });
    expect(provider.inferCalls).toHaveLength(0);
    lease.release();
  });

  it('rejects a released stale lease and changed saved configuration before inference', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();
    const staleFingerprint = settings.defaultFingerprint();
    const stale = await service.acquireOrnithLease('default', staleFingerprint);
    stale.release();
    const request: LocalInferenceRequest = {
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId: 'stale-request',
      messages: [{ role: 'user', content: 'no dispatch' }]
    };
    expect(await service.inferForOrnith(stale, request)).toMatchObject({ kind: 'failed', dispatchOutcome: 'not_dispatched' });
    settings.patchDefaultProfile({ port: 19091 });
    await expect(service.acquireOrnithLease('default', staleFingerprint)).rejects.toThrow('does not match');
    expect(provider.inferCalls).toHaveLength(0);
  });

  it('discards a completion when settings drift while inference is in flight', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    await service.start();
    const lease = await service.acquireOrnithLease('default', settings.defaultFingerprint());
    let release!: () => void;
    provider.inferGate = new Promise<void>((resolve) => { release = resolve; });
    const request: LocalInferenceRequest = {
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId: 'drift-request',
      messages: [{ role: 'user', content: 'must be discarded' }]
    };

    const pending = service.inferForOrnith(lease, request);
    await Promise.resolve();
    settings.patchDefaultProfile({ port: 19091 });
    release();

    expect(await pending).toMatchObject({ kind: 'failed', dispatchOutcome: 'unknown' });
    expect(provider.inferCalls).toHaveLength(1);
    lease.release();
  });

  it('constructs no provider and returns a bounded structured failure when disabled and unbound', async () => {
    const settings = new MutableSettings();
    settings.update({ localInference: { ...settings.get().localInference, enabled: false } });
    let constructions = 0;
    const service = new LocalInferenceService({
      settings,
      createProvider: () => {
        constructions += 1;
        return new StubProvider();
      },
      ids: testIds()
    });

    const outcome = await service.runTestInference('hello');

    expect(constructions).toBe(0);
    expect(outcome).toMatchObject({
      kind: 'failed',
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      dispatchOutcome: 'not_dispatched',
      reason: 'Local inference is disabled in Settings.'
    });
    if (outcome.kind !== 'failed') throw new Error('expected a failed outcome');
    expect(outcome.requestId.length).toBeGreaterThan(0);
  });

  it('builds exactly one version-1 request with a generated id and one user message, and delegates once', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    provider.current = { kind: 'healthy', runtimeInstanceId: 'runtime-1' };
    const ids = new SequentialIdGenerator('req');
    const service = selectedService({ settings, createProvider: () => provider, ids });

    const outcome = await service.runTestInference('Say something short.');

    expect(provider.inferCalls).toHaveLength(1);
    expect(provider.inferCalls[0]).toEqual({
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId: 'req-000001',
      messages: [{ role: 'user', content: 'Say something short.' }]
    });
    expect(outcome.kind).toBe('completed');
  });

  it('supplies no request-level output-token cap or chat-template override', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    provider.current = { kind: 'healthy', runtimeInstanceId: 'runtime-1' };
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });

    await service.runTestInference('hi');

    const request = provider.inferCalls[0];
    expect(request).not.toHaveProperty('maxOutputTokens');
    expect(request).not.toHaveProperty('chatTemplateParameters');
  });

  it('preserves Unicode prompt text unchanged in the built message', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    provider.current = { kind: 'healthy', runtimeInstanceId: 'runtime-1' };
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });
    const prompt = '你好，世界 🌍 — café';

    await service.runTestInference(prompt);

    expect(provider.inferCalls[0]?.messages).toEqual([{ role: 'user', content: prompt }]);
  });

  it('sends no completion request and rejects when the retained provider is not Healthy', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    // Left at its default `stopped` state: never started.
    const service = selectedService({ settings, createProvider: () => provider, ids: testIds() });

    await expect(service.runTestInference('hi')).rejects.toThrow('infer is not legal now');
    expect(provider.inferCalls).toHaveLength(0);
  });

  it('delegates to the same provider a prior lifecycle call already bound, without constructing another', async () => {
    const settings = new MutableSettings();
    const provider = new StubProvider();
    let constructions = 0;
    const service = selectedService({
      settings,
      createProvider: () => {
        constructions += 1;
        return provider;
      },
      ids: testIds()
    });

    await service.start();
    await service.runTestInference('hi');

    expect(constructions).toBe(1);
    expect(provider.inferCalls).toHaveLength(1);
  });
});
