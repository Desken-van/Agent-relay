/**
 * The local-inference contract and its lifecycle graph.
 *
 * Pure data and pure functions only: no process, no socket, no model. What is
 * being checked is that the shapes fail closed and that the state machine
 * refuses the moves that would let a runtime be started twice, inferred against
 * before it is known to be alive, or restarted by itself.
 */

import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../src/shared/domain/errors';
import {
  allowedLocalInferenceEvents,
  canLocalInferenceTransition,
  chatTemplateParametersSchema,
  defaultLocalInferenceSettings,
  isReservedRuntimeFlag,
  LOCAL_INFERENCE_CONTRACT_VERSION,
  LOCAL_INFERENCE_EVENTS,
  LOCAL_INFERENCE_HOST,
  LOCAL_INFERENCE_LIMITS,
  LOCAL_INFERENCE_PROTOCOL,
  LOCAL_INFERENCE_SETTINGS_VERSION,
  LOCAL_INFERENCE_STATE_KINDS,
  LOCAL_INFERENCE_TRANSITIONS,
  localInferenceConfigSchema,
  localInferenceSettingsSchema,
  localInferenceMessageSchema,
  localInferenceOutcomeSchema,
  localInferenceProfileSchema,
  localInferenceProfilesSettingsSchema,
  localInferencePromptSchema,
  localInferenceRequestSchema,
  localInferenceResponseSchema,
  localInferenceStateSchema,
  localInferenceTransition,
  modelArgumentFor,
  summarizeLocalInferenceProfiles,
  upgradeLegacyLocalInferenceSettings,
  upgradeLocalInferenceProfilesSettings,
  type LocalInferenceEvent,
  type LocalInferenceStateKind
} from '../../src/shared/domain/local-inference';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const EXECUTABLE_PATH = process.platform === 'win32' ? 'C:\\tools\\llama-server.exe' : '/opt/llama/llama-server';
const MODEL_PATH = process.platform === 'win32' ? 'C:\\models\\fake.gguf' : '/models/fake.gguf';
const WORKDIR = process.platform === 'win32' ? 'C:\\work\\runtime' : '/work/runtime';

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    providerId: 'local-1',
    executable: { kind: 'explicit_path', path: EXECUTABLE_PATH },
    model: { id: 'ornith-8b', source: { kind: 'path', path: MODEL_PATH } },
    workingDirectory: WORKDIR,
    port: 8099,
    fixedArguments: ['--threads', '4'],
    contextLimitTokens: 8192,
    maxOutputTokens: 512,
    defaultChatTemplateParameters: {},
    maxPromptBytes: 100_000,
    maxRequestBytes: 200_000,
    maxResponseBytes: 400_000,
    maxCompletionBytes: 50_000,
    maxProcessOutputBytes: 100_000,
    startupTimeoutMs: 30_000,
    healthTimeoutMs: 2_000,
    inferenceTimeoutMs: 60_000,
    shutdownTimeoutMs: 5_000,
    ...overrides
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    requestId: 'req-1',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides
  };
}

/* -------------------------------------------------------------------------- */
/* Protocol identity                                                           */
/* -------------------------------------------------------------------------- */

describe('local inference contract identity', () => {
  it('names itself and pins the host', () => {
    expect(LOCAL_INFERENCE_PROTOCOL).toBe('agent-relay.local-inference');
    expect(LOCAL_INFERENCE_CONTRACT_VERSION).toBe(1);
    expect(LOCAL_INFERENCE_HOST).toBe('127.0.0.1');
  });
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

describe('local inference configuration', () => {
  it('accepts a complete version-1 configuration', () => {
    const parsed = localInferenceConfigSchema.parse(config());
    expect(parsed.providerId).toBe('local-1');
    expect(parsed.model.id).toBe('ornith-8b');
  });

  it('rejects an unknown contract version', () => {
    expect(localInferenceConfigSchema.safeParse(config({ version: 2 })).success).toBe(false);
    expect(localInferenceConfigSchema.safeParse(config({ version: 0 })).success).toBe(false);
  });

  it('rejects an unknown property rather than ignoring it', () => {
    expect(localInferenceConfigSchema.safeParse(config({ baseUrl: 'http://elsewhere' })).success).toBe(
      false
    );
  });

  it('accepts PATH discovery only for the fixed command', () => {
    expect(
      localInferenceConfigSchema.safeParse(
        config({ executable: { kind: 'discovered', command: 'llama-server' } })
      ).success
    ).toBe(true);
    expect(
      localInferenceConfigSchema.safeParse(
        config({ executable: { kind: 'discovered', command: 'curl' } })
      ).success
    ).toBe(false);
  });

  it('rejects a relative explicit executable or model path', () => {
    expect(
      localInferenceConfigSchema.safeParse(
        config({ executable: { kind: 'explicit_path', path: 'llama-server' } })
      ).success
    ).toBe(false);
    expect(
      localInferenceConfigSchema.safeParse(
        config({ model: { id: 'm', source: { kind: 'path', path: './fake.gguf' } } })
      ).success
    ).toBe(false);
  });

  /**
   * A `.cmd` is not a program, it is an instruction to `cmd.exe`. Spawning one
   * without a shell either fails or succeeds by having something else start the
   * shell on our behalf — and "Agent Relay never launches a shell" then holds
   * only in the code that says so. `.js`/`.mjs` are the deliberate exception:
   * `launchFor` runs them through Node, which is what the test fixture relies
   * on, and no shell is involved.
   */
  it('rejects a configured executable that is a command shim or a script', () => {
    const shims = [
      'C:\\tools\\llama-server.cmd',
      'C:\\tools\\llama-server.bat',
      'C:\\tools\\llama-server.ps1',
      'C:\\tools\\llama-server.psm1',
      'C:\\tools\\llama-server.vbs',
      '/usr/local/bin/llama-server.sh'
    ];
    for (const path of shims) {
      expect(
        localInferenceConfigSchema.safeParse(config({ executable: { kind: 'explicit_path', path } }))
          .success
      ).toBe(false);
    }

    for (const path of ['C:\\tools\\llama-server.exe', '/usr/local/bin/llama-server']) {
      expect(
        localInferenceConfigSchema.safeParse(config({ executable: { kind: 'explicit_path', path } }))
          .success
      ).toBe(true);
    }
  });

  it('rejects a path containing relative segments', () => {
    const traversal = process.platform === 'win32' ? 'C:\\models\\..\\fake.gguf' : '/models/../fake.gguf';
    expect(
      localInferenceConfigSchema.safeParse(
        config({ model: { id: 'm', source: { kind: 'path', path: traversal } } })
      ).success
    ).toBe(false);
  });

  it('keeps the model identity separate from the model source', () => {
    const byPath = localInferenceConfigSchema.parse(config());
    expect(modelArgumentFor(byPath.model)).toBe(MODEL_PATH);
    expect(byPath.model.id).not.toBe(MODEL_PATH);

    const byId = localInferenceConfigSchema.parse(
      config({ model: { id: 'ornith-8b', source: { kind: 'runtime_id', runtimeModelId: 'ornith-8b-q4' } } })
    );
    expect(modelArgumentFor(byId.model)).toBe('ornith-8b-q4');
  });

  it('requires a port inside the legal range', () => {
    for (const port of [0, -1, 65_536, 1.5]) {
      expect(localInferenceConfigSchema.safeParse(config({ port })).success).toBe(false);
    }
    expect(localInferenceConfigSchema.safeParse(config({ port: 65_535 })).success).toBe(true);
  });

  it('refuses a completion cap larger than the context limit', () => {
    expect(
      localInferenceConfigSchema.safeParse(config({ contextLimitTokens: 512, maxOutputTokens: 513 }))
        .success
    ).toBe(false);
  });

  it('refuses byte budgets that contradict each other', () => {
    expect(
      localInferenceConfigSchema.safeParse(config({ maxPromptBytes: 300_000, maxRequestBytes: 200_000 }))
        .success
    ).toBe(false);
    expect(
      localInferenceConfigSchema.safeParse(
        config({ maxCompletionBytes: 500_000, maxResponseBytes: 400_000 })
      ).success
    ).toBe(false);
  });

  it('keeps health and startup timeout budgets independent', () => {
    // Health and startup are independent budgets. During startup the adapter
    // bounds each probe by the smaller of these values and the remaining
    // overall startup budget.
    expect(
      localInferenceConfigSchema.safeParse(config({ startupTimeoutMs: 1_000, healthTimeoutMs: 2_000 }))
        .success
    ).toBe(true);
  });

  it('refuses non-positive, fractional and oversized limits', () => {
    for (const patch of [
      { contextLimitTokens: 0 },
      { maxOutputTokens: -1 },
      { maxResponseBytes: 1.5 },
      { inferenceTimeoutMs: Number.POSITIVE_INFINITY },
      { shutdownTimeoutMs: 60_001 },
      { maxProcessOutputBytes: 2 * 1024 * 1024 + 1 }
    ]) {
      expect(localInferenceConfigSchema.safeParse(config(patch)).success).toBe(false);
    }
  });
});

/**
 * The shipped single-runtime default `defaultLocalInferenceSettings()` wraps as its one profile —
 * reproduced here because the function that used to return this flat shape directly now returns the
 * profiles shape, and this literal is what `localInferenceSettingsSchema` (the flat, per-profile runtime
 * config validator) and `upgradeLegacyLocalInferenceSettings` (which still targets that flat shape) are
 * tested against.
 */
const FLAT_DEFAULT = {
  version: LOCAL_INFERENCE_CONTRACT_VERSION,
  enabled: false,
  executable: { kind: 'discovered', command: 'llama-server' },
  model: {
    id: 'local-model',
    source: { kind: 'runtime_id', runtimeModelId: 'local-model' }
  },
  fixedArguments: [],
  port: 8080,
  contextLimitTokens: 4096,
  startupTimeoutMs: 600_000,
  healthTimeoutMs: 60_000,
  inferenceTimeoutMs: 1_800_000,
  shutdownTimeoutMs: 60_000,
  requestDefaults: {
    maxOutputTokens: 4096,
    chatTemplateParameters: {}
  }
} as const;

describe('persisted local inference settings', () => {
  const persisted = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...FLAT_DEFAULT,
    ...overrides
  });

  it('ships a fresh, harmless default with exactly one runtime-id profile', () => {
    const first = defaultLocalInferenceSettings();
    const second = defaultLocalInferenceSettings();
    const { version: _flatVersion, ...runtimeConfig } = FLAT_DEFAULT;
    expect(first).toEqual({
      version: 2,
      enabled: false,
      profiles: [
        {
          id: 'default',
          displayName: 'Local model',
          adapterKind: 'llama_cpp',
          ...runtimeConfig
        }
      ],
      defaultProfileId: 'default'
    });
    expect(first).not.toBe(second);
    expect(first.profiles).not.toBe(second.profiles);
    expect(first.profiles[0]).not.toBe(second.profiles[0]);
    expect(first.profiles[0]?.fixedArguments).not.toBe(second.profiles[0]?.fixedArguments);
    expect(first.profiles[0]?.model).not.toBe(second.profiles[0]?.model);
    expect(first.profiles[0]?.requestDefaults).not.toBe(second.profiles[0]?.requestDefaults);
    expect(first.profiles[0]?.requestDefaults.chatTemplateParameters).not.toBe(
      second.profiles[0]?.requestDefaults.chatTemplateParameters
    );
  });

  it('bounds and cross-validates the default output token cap', () => {
    expect(
      localInferenceSettingsSchema.safeParse(
        persisted({ requestDefaults: { maxOutputTokens: 4097, chatTemplateParameters: {} }, contextLimitTokens: 4096 })
      ).success
    ).toBe(false);
    expect(
      localInferenceSettingsSchema.safeParse(
        persisted({ requestDefaults: { maxOutputTokens: 4096, chatTemplateParameters: {} }, contextLimitTokens: 4096 })
      ).success
    ).toBe(true);
    expect(
      localInferenceSettingsSchema.safeParse(
        persisted({ requestDefaults: { maxOutputTokens: 0, chatTemplateParameters: {} } })
      ).success
    ).toBe(false);
  });

  it('preserves false and zero in the default chat-template parameter map', () => {
    const parsed = localInferenceSettingsSchema.parse(
      persisted({
        requestDefaults: {
          maxOutputTokens: 4096,
          chatTemplateParameters: { enable_thinking: false, preserve_thinking: false, budget: 0 }
        }
      })
    );
    expect(parsed.requestDefaults.chatTemplateParameters).toEqual({
      enable_thinking: false,
      preserve_thinking: false,
      budget: 0
    });
  });

  it('rejects an object missing the new required fields', () => {
    const { enabled: _enabled, ...withoutEnabled } = persisted();
    expect(localInferenceSettingsSchema.safeParse(withoutEnabled).success).toBe(false);
    const { requestDefaults: _requestDefaults, ...withoutRequestDefaults } = persisted();
    expect(localInferenceSettingsSchema.safeParse(withoutRequestDefaults).success).toBe(false);
  });

  it('accepts both executable variants and both model-source variants', () => {
    expect(localInferenceSettingsSchema.safeParse(persisted()).success).toBe(true);
    expect(
      localInferenceSettingsSchema.safeParse(
        persisted({
          executable: { kind: 'explicit_path', path: EXECUTABLE_PATH },
          model: { id: 'model-path', source: { kind: 'path', path: MODEL_PATH } }
        })
      ).success
    ).toBe(true);
  });

  it('rejects unknown keys, unknown versions and unclean or shell-dependent paths', () => {
    for (const candidate of [
      persisted({ version: 0 }),
      persisted({ version: 2 }),
      { ...persisted(), surprise: true },
      persisted({ executable: { kind: 'explicit_path', path: 'relative/llama-server' } }),
      persisted({ executable: { kind: 'explicit_path', path: `${EXECUTABLE_PATH}.cmd` } }),
      persisted({
        model: { id: 'model', source: { kind: 'path', path: `${MODEL_PATH}${process.platform === 'win32' ? '\\..\\' : '/../'}other.gguf` } }
      })
    ]) {
      expect(localInferenceSettingsSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('reuses all fixed-argument protections', () => {
    for (const argument of [
      '--model',
      '-m=other',
      '--model-url=x',
      '--alias=x',
      '-a',
      '--host=0.0.0.0',
      '--port',
      '--ctx-size=1',
      '-c',
      '--ctx_size=1',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'line\nother'
    ]) {
      expect(
        localInferenceSettingsSchema.safeParse(persisted({ fixedArguments: [argument] })).success
      ).toBe(false);
    }
  });

  it('bounds ports, context and every timeout with LOCAL_INFERENCE_LIMITS', () => {
    const fields = [
      ['contextLimitTokens', LOCAL_INFERENCE_LIMITS.contextTokensMax],
      ['startupTimeoutMs', LOCAL_INFERENCE_LIMITS.startupTimeoutMsMax],
      ['healthTimeoutMs', LOCAL_INFERENCE_LIMITS.healthTimeoutMsMax],
      ['inferenceTimeoutMs', LOCAL_INFERENCE_LIMITS.inferenceTimeoutMsMax],
      ['shutdownTimeoutMs', LOCAL_INFERENCE_LIMITS.shutdownTimeoutMsMax]
    ] as const;

    for (const [field, maximum] of fields) {
      expect(localInferenceSettingsSchema.safeParse(persisted({ [field]: maximum })).success).toBe(true);
      for (const invalid of [0, -1, 1.5, maximum + 1]) {
        expect(localInferenceSettingsSchema.safeParse(persisted({ [field]: invalid })).success).toBe(false);
      }
    }
    for (const port of [0, 65_536, 1.5]) {
      expect(localInferenceSettingsSchema.safeParse(persisted({ port })).success).toBe(false);
    }
    expect(localInferenceSettingsSchema.safeParse(persisted({ port: 1 })).success).toBe(true);
    expect(localInferenceSettingsSchema.safeParse(persisted({ port: 65_535 })).success).toBe(true);
  });
});

describe('upgradeLegacyLocalInferenceSettings', () => {
  it('leaves a row already in the current (flat, single-runtime) shape unchanged', () => {
    expect(upgradeLegacyLocalInferenceSettings(FLAT_DEFAULT)).toEqual(FLAT_DEFAULT);
  });

  it('upgrades a pre-B2 legacy row, keeping every existing value and adding safe defaults', () => {
    const legacy = {
      version: 1,
      executable: { kind: 'explicit_path', path: EXECUTABLE_PATH },
      model: { id: 'legacy-model', source: { kind: 'path', path: MODEL_PATH } },
      fixedArguments: ['--threads', '4'],
      port: 18080,
      contextLimitTokens: 2048,
      startupTimeoutMs: 10_000,
      healthTimeoutMs: 2_000,
      inferenceTimeoutMs: 20_000,
      shutdownTimeoutMs: 5_000
    };

    const upgraded = upgradeLegacyLocalInferenceSettings(legacy);
    expect(upgraded.executable).toEqual(legacy.executable);
    expect(upgraded.model).toEqual(legacy.model);
    expect(upgraded.fixedArguments).toEqual(legacy.fixedArguments);
    expect(upgraded.port).toBe(legacy.port);
    expect(upgraded.contextLimitTokens).toBe(legacy.contextLimitTokens);
    expect(upgraded.startupTimeoutMs).toBe(legacy.startupTimeoutMs);
    expect(upgraded.healthTimeoutMs).toBe(legacy.healthTimeoutMs);
    expect(upgraded.inferenceTimeoutMs).toBe(legacy.inferenceTimeoutMs);
    expect(upgraded.shutdownTimeoutMs).toBe(legacy.shutdownTimeoutMs);
    expect(upgraded.enabled).toBe(false);
    expect(upgraded.requestDefaults).toEqual({ maxOutputTokens: 2048, chatTemplateParameters: {} });
  });

  it('clamps the migrated default output cap to min(4096, context limit)', () => {
    const legacy = {
      version: 1,
      executable: { kind: 'discovered', command: 'llama-server' },
      model: { id: 'm', source: { kind: 'runtime_id', runtimeModelId: 'm' } },
      fixedArguments: [],
      port: 8080,
      contextLimitTokens: 32_768,
      startupTimeoutMs: 10_000,
      healthTimeoutMs: 2_000,
      inferenceTimeoutMs: 20_000,
      shutdownTimeoutMs: 5_000
    };
    expect(upgradeLegacyLocalInferenceSettings(legacy).requestDefaults.maxOutputTokens).toBe(4096);
  });

  it('falls back to the shipped default for malformed or unrecognisable data', () => {
    for (const bad of [undefined, null, 'not an object', { version: 1 }, { surprise: true }]) {
      expect(upgradeLegacyLocalInferenceSettings(bad)).toEqual(FLAT_DEFAULT);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Local-model profiles                                                       */
/* -------------------------------------------------------------------------- */

describe('local-model profiles', () => {
  const { version: _flatDefaultVersion, ...profileRuntimeConfig } = FLAT_DEFAULT;

  const profile = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
    ...profileRuntimeConfig,
    id: 'default',
    displayName: 'Local model',
    enabled: true,
    adapterKind: 'llama_cpp',
    ...overrides
  });

  it('accepts a well-formed profile', () => {
    expect(localInferenceProfileSchema.safeParse(profile()).success).toBe(true);
  });

  it('bounds the profile id and rejects an unsafe id shape', () => {
    expect(
      localInferenceProfileSchema.safeParse(profile({ id: 'a'.repeat(LOCAL_INFERENCE_LIMITS.profileIdMax) }))
        .success
    ).toBe(true);
    expect(
      localInferenceProfileSchema.safeParse(
        profile({ id: 'a'.repeat(LOCAL_INFERENCE_LIMITS.profileIdMax + 1) })
      ).success
    ).toBe(false);
    expect(localInferenceProfileSchema.safeParse(profile({ id: '' })).success).toBe(false);
    expect(localInferenceProfileSchema.safeParse(profile({ id: 'has space' })).success).toBe(false);
    expect(localInferenceProfileSchema.safeParse(profile({ id: '../etc' })).success).toBe(false);
  });

  it('bounds the display name and rejects control characters', () => {
    expect(
      localInferenceProfileSchema.safeParse(
        profile({ displayName: 'a'.repeat(LOCAL_INFERENCE_LIMITS.profileDisplayNameMax) })
      ).success
    ).toBe(true);
    expect(
      localInferenceProfileSchema.safeParse(
        profile({ displayName: 'a'.repeat(LOCAL_INFERENCE_LIMITS.profileDisplayNameMax + 1) })
      ).success
    ).toBe(false);
    expect(localInferenceProfileSchema.safeParse(profile({ displayName: '' })).success).toBe(false);
    expect(localInferenceProfileSchema.safeParse(profile({ displayName: 'bad\u0007name' })).success).toBe(
      false
    );
  });

  it('rejects an unknown adapterKind and an unknown property', () => {
    expect(localInferenceProfileSchema.safeParse(profile({ adapterKind: 'openai_compatible' })).success).toBe(
      false
    );
    expect(localInferenceProfileSchema.safeParse({ ...profile(), path: 'C:\\models\\x.gguf' }).success).toBe(
      false
    );
  });

  it('still cross-validates the default output cap against its own context limit', () => {
    expect(
      localInferenceProfileSchema.safeParse(
        profile({ contextLimitTokens: 512, requestDefaults: { maxOutputTokens: 513, chatTemplateParameters: {} } })
      ).success
    ).toBe(false);
  });

  const profilesSettings = (
    overrides: Partial<Record<string, unknown>> = {}
  ): Record<string, unknown> => ({
    version: LOCAL_INFERENCE_SETTINGS_VERSION,
    enabled: true,
    profiles: [profile()],
    defaultProfileId: 'default',
    ...overrides
  });

  it('accepts a well-formed profiles settings object, and a null default with an empty profile list', () => {
    expect(localInferenceProfilesSettingsSchema.safeParse(profilesSettings()).success).toBe(true);
    expect(
      localInferenceProfilesSettingsSchema.safeParse(
        profilesSettings({ profiles: [], defaultProfileId: null })
      ).success
    ).toBe(true);
  });

  it('rejects duplicate profile ids', () => {
    expect(
      localInferenceProfilesSettingsSchema.safeParse(
        profilesSettings({ profiles: [profile(), profile({ displayName: 'Second' })] })
      ).success
    ).toBe(false);
  });

  it('rejects a defaultProfileId that names no configured profile', () => {
    expect(
      localInferenceProfilesSettingsSchema.safeParse(
        profilesSettings({ defaultProfileId: 'missing' })
      ).success
    ).toBe(false);
  });

  it('bounds the number of configured profiles', () => {
    const many = Array.from({ length: LOCAL_INFERENCE_LIMITS.profilesMax + 1 }, (_value, index) =>
      profile({ id: `profile-${index}`, displayName: `Profile ${index}` })
    );
    expect(
      localInferenceProfilesSettingsSchema.safeParse(
        profilesSettings({ profiles: many, defaultProfileId: 'profile-0' })
      ).success
    ).toBe(false);
    expect(
      localInferenceProfilesSettingsSchema.safeParse(
        profilesSettings({ profiles: many.slice(0, LOCAL_INFERENCE_LIMITS.profilesMax), defaultProfileId: 'profile-0' })
      ).success
    ).toBe(true);
  });

  describe('upgradeLocalInferenceProfilesSettings', () => {
    it('returns an already-current profiles row unchanged', () => {
      const current = localInferenceProfilesSettingsSchema.parse(profilesSettings());
      expect(upgradeLocalInferenceProfilesSettings(current)).toEqual(current);
    });

    it('wraps a legacy flat row as its one profile, naming it after the configured model id', () => {
      const legacy = { ...FLAT_DEFAULT, model: { id: 'qwen3-coder-30b', source: { kind: 'runtime_id', runtimeModelId: 'qwen' } } };
      const upgraded = upgradeLocalInferenceProfilesSettings(legacy);
      expect(upgraded.version).toBe(LOCAL_INFERENCE_SETTINGS_VERSION);
      expect(upgraded.defaultProfileId).toBe('default');
      expect(upgraded.profiles).toHaveLength(1);
      expect(upgraded.profiles[0]?.id).toBe('default');
      expect(upgraded.profiles[0]?.displayName).toBe('qwen3-coder-30b');
      expect(upgraded.profiles[0]?.model).toEqual(legacy.model);
      expect(upgraded.profiles[0]?.executable).toEqual(legacy.executable);
    });

    it('falls back to the shipped default for malformed or unrecognisable data', () => {
      // Every runtime-config field matches the shipped default; only the display name differs — this
      // path derives it from the (fallback) model id rather than the shipped "Local model" label.
      const shipped = defaultLocalInferenceSettings();
      const shippedProfile = shipped.profiles[0];
      for (const bad of [undefined, null, 'not an object', 42, { surprise: true }]) {
        const upgraded = upgradeLocalInferenceProfilesSettings(bad);
        expect({ ...upgraded, profiles: [{ ...upgraded.profiles[0], displayName: shippedProfile?.displayName }] }).toEqual(
          shipped
        );
      }
    });
  });

  describe('summarizeLocalInferenceProfiles', () => {
    const settings = localInferenceProfilesSettingsSchema.parse(
      profilesSettings({
        profiles: [profile(), profile({ id: 'second', displayName: 'Second profile', enabled: false })],
        defaultProfileId: 'default'
      })
    );

    it('never exposes a path, executable, fingerprint or other machine-local detail', () => {
      const summaries = summarizeLocalInferenceProfiles(settings, 'default', 'healthy');
      for (const summary of summaries) {
        expect(Object.keys(summary).sort()).toEqual(
          ['activeStateKind', 'activity', 'displayName', 'enabled', 'id', 'isDefault'].sort()
        );
      }
    });

    it('marks exactly the active profile, carrying its live state kind, and the configured default', () => {
      const summaries = summarizeLocalInferenceProfiles(settings, 'default', 'healthy');
      expect(summaries).toEqual([
        { id: 'default', displayName: 'Local model', enabled: true, isDefault: true, activity: 'active', activeStateKind: 'healthy' },
        { id: 'second', displayName: 'Second profile', enabled: false, isDefault: false, activity: 'inactive', activeStateKind: null }
      ]);
    });

    it('marks every profile inactive, with no active state kind, when none is currently selected', () => {
      const summaries = summarizeLocalInferenceProfiles(settings, null, 'stopped');
      expect(summaries.every((summary) => summary.activity === 'inactive')).toBe(true);
      expect(summaries.every((summary) => summary.activeStateKind === null)).toBe(true);
    });

    it('a disabled profile can still be the active one — enabled and activity are independent', () => {
      const summaries = summarizeLocalInferenceProfiles(settings, 'second', 'starting');
      const second = summaries.find((summary) => summary.id === 'second');
      expect(second).toMatchObject({ enabled: false, activity: 'active', activeStateKind: 'starting' });
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Fixed arguments                                                             */
/* -------------------------------------------------------------------------- */

describe('fixed runtime arguments', () => {
  it('accepts ordinary tuning flags', () => {
    expect(
      localInferenceConfigSchema.safeParse(config({ fixedArguments: ['--threads', '8', '--no-mmap'] }))
        .success
    ).toBe(true);
  });

  it('rejects every spelling of an adapter-owned flag', () => {
    for (const flag of [
      '--model',
      '-m',
      '--model=/tmp/other.gguf',
      '--alias',
      '-a',
      '--host',
      '--host=0.0.0.0',
      '--port',
      '--ctx-size',
      '-c',
      '--CTX-SIZE'
    ]) {
      expect(isReservedRuntimeFlag(flag)).toBe(true);
      expect(localInferenceConfigSchema.safeParse(config({ fixedArguments: [flag] })).success).toBe(
        false
      );
    }
  });

  it('does not mistake a value for a reserved flag', () => {
    expect(isReservedRuntimeFlag('model')).toBe(false);
    expect(isReservedRuntimeFlag('--models-directory')).toBe(false);
  });

  it('rejects empty, control-bearing and credential-shaped entries', () => {
    for (const argument of ['', 'a\u0000b', 'x\ny', 'ghp_abcdefghijklmnopqrstuvwxyz0123']) {
      expect(localInferenceConfigSchema.safeParse(config({ fixedArguments: [argument] })).success).toBe(
        false
      );
    }
  });

  it('rejects more arguments than the ceiling allows', () => {
    const many = Array.from({ length: 65 }, (_value, index) => `--flag-${index}`);
    expect(localInferenceConfigSchema.safeParse(config({ fixedArguments: many })).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Chat template parameters                                                    */
/* -------------------------------------------------------------------------- */

describe('chat template parameters', () => {
  it('preserves false and zero exactly', () => {
    const parsed = chatTemplateParametersSchema.parse({
      enable_thinking: false,
      preserve_thinking: true,
      thinking_budget: 0,
      style: ''
    });
    expect(parsed.enable_thinking).toBe(false);
    expect(parsed.preserve_thinking).toBe(true);
    expect(parsed.thinking_budget).toBe(0);
    expect(parsed.style).toBe('');
  });

  it('rejects arrays, nested objects and non-finite numbers', () => {
    expect(chatTemplateParametersSchema.safeParse({ a: [1, 2] }).success).toBe(false);
    expect(chatTemplateParametersSchema.safeParse({ a: { b: 1 } }).success).toBe(false);
    expect(chatTemplateParametersSchema.safeParse({ a: Number.NaN }).success).toBe(false);
    expect(chatTemplateParametersSchema.safeParse({ a: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(chatTemplateParametersSchema.safeParse({ a: null }).success).toBe(false);
  });

  it('rejects keys that are not identifiers', () => {
    expect(chatTemplateParametersSchema.safeParse({ '1bad': true }).success).toBe(false);
    expect(chatTemplateParametersSchema.safeParse({ 'has space': true }).success).toBe(false);
  });

  it('rejects more parameters than the ceiling allows', () => {
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_value, index) => [`k${index}`, true])
    );
    expect(chatTemplateParametersSchema.safeParse(many).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Requests, responses, outcomes                                               */
/* -------------------------------------------------------------------------- */

describe('local inference request', () => {
  it('accepts a minimal request', () => {
    expect(localInferenceRequestSchema.safeParse(request()).success).toBe(true);
  });

  it('rejects an unknown version or an unknown property', () => {
    expect(localInferenceRequestSchema.safeParse(request({ version: 2 })).success).toBe(false);
    expect(localInferenceRequestSchema.safeParse(request({ tools: [] })).success).toBe(false);
    expect(localInferenceRequestSchema.safeParse(request({ stream: true })).success).toBe(false);
  });

  it('rejects an unknown role, an empty message and an empty message list', () => {
    expect(
      localInferenceRequestSchema.safeParse(request({ messages: [{ role: 'tool', content: 'x' }] }))
        .success
    ).toBe(false);
    expect(
      localInferenceRequestSchema.safeParse(request({ messages: [{ role: 'user', content: '' }] }))
        .success
    ).toBe(false);
    expect(localInferenceRequestSchema.safeParse(request({ messages: [] })).success).toBe(false);
  });

  it('carries chat template parameters through unchanged', () => {
    const parsed = localInferenceRequestSchema.parse(
      request({ chatTemplateParameters: { enable_thinking: false } })
    );
    expect(parsed.chatTemplateParameters).toEqual({ enable_thinking: false });
  });

  it('accepts only the closed application-owned structured-output profile', () => {
    expect(
      localInferenceRequestSchema.safeParse(request({ structuredOutput: 'ornith_action_v1' })).success
    ).toBe(true);
    expect(
      localInferenceRequestSchema.safeParse(request({ structuredOutput: 'arbitrary_schema' })).success
    ).toBe(false);
  });
});

describe('local inference prompt', () => {
  it('rejects an empty prompt', () => {
    expect(localInferencePromptSchema.safeParse('').success).toBe(false);
  });

  it('accepts up to the shared message-content ceiling and rejects one character past it', () => {
    expect(
      localInferencePromptSchema.safeParse('x'.repeat(LOCAL_INFERENCE_LIMITS.messageContentMax))
        .success
    ).toBe(true);
    expect(
      localInferencePromptSchema.safeParse('x'.repeat(LOCAL_INFERENCE_LIMITS.messageContentMax + 1))
        .success
    ).toBe(false);
  });

  it('preserves Unicode prompt text unchanged', () => {
    const prompt = '你好，世界 🌍 — café';
    expect(localInferencePromptSchema.parse(prompt)).toBe(prompt);
  });

  it('applies exactly the same rule as one message\'s content', () => {
    const cases = ['', 'a', 'x'.repeat(LOCAL_INFERENCE_LIMITS.messageContentMax + 1)];
    for (const value of cases) {
      expect(localInferencePromptSchema.safeParse(value).success).toBe(
        localInferenceMessageSchema.shape.content.safeParse(value).success
      );
    }
  });
});

describe('local inference response and outcome', () => {
  const response = {
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    requestId: 'req-1',
    providerId: 'local-1',
    modelId: 'ornith-8b',
    runtimeVersion: 'version: 4321 (stub)',
    runtimeInstanceId: 'rt0011aabb',
    durationMs: 12,
    completion: 'hello',
    promptTokens: null,
    completionTokens: null,
    runtimeResponseId: null,
    finishReason: { kind: 'unknown' }
  };

  it('accepts nulls for values the runtime did not report', () => {
    expect(localInferenceResponseSchema.safeParse(response).success).toBe(true);
  });

  it('rejects a completed response without its established runtime version', () => {
    expect(
      localInferenceResponseSchema.safeParse({ ...response, runtimeVersion: null }).success
    ).toBe(false);
  });

  it('rejects a negative token count and an unknown finish reason shape', () => {
    expect(localInferenceResponseSchema.safeParse({ ...response, promptTokens: -1 }).success).toBe(
      false
    );
    expect(
      localInferenceResponseSchema.safeParse({ ...response, finishReason: 'stop' }).success
    ).toBe(false);
    expect(
      localInferenceResponseSchema.safeParse({ ...response, finishReason: { kind: 'other' } }).success
    ).toBe(false);
  });

  it('lets only a completed outcome carry a response', () => {
    expect(
      localInferenceOutcomeSchema.safeParse({
        kind: 'completed',
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        response
      }).success
    ).toBe(true);
    expect(
      localInferenceOutcomeSchema.safeParse({ kind: 'cancelled', response, requestId: 'req-1' }).success
    ).toBe(false);
    expect(
      localInferenceOutcomeSchema.safeParse({
        kind: 'timed_out',
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId: 'req-1',
        reason: 'gone',
        dispatchOutcome: 'unknown'
      }).success
    ).toBe(true);
    expect(
      localInferenceOutcomeSchema.safeParse({
        kind: 'failed',
        version: LOCAL_INFERENCE_CONTRACT_VERSION,
        requestId: 'req-1',
        reason: 'gone',
        dispatchOutcome: 'retried'
      }).success
    ).toBe(false);
    expect(
      localInferenceOutcomeSchema.safeParse({
        kind: 'failed',
        version: 2,
        requestId: 'req-1',
        reason: 'gone',
        dispatchOutcome: 'unknown'
      }).success
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

describe('local inference lifecycle', () => {
  it('strictly validates bounded lifecycle metadata', () => {
    expect(localInferenceStateSchema.safeParse({ kind: 'stopped' }).success).toBe(true);
    expect(
      localInferenceStateSchema.safeParse({ kind: 'healthy', runtimeInstanceId: 'rt001' }).success
    ).toBe(true);
    expect(localInferenceStateSchema.safeParse({ kind: 'stopped', extra: true }).success).toBe(
      false
    );
    expect(
      localInferenceStateSchema.safeParse({ kind: 'failed', reason: 'bad\u001b[31m' }).success
    ).toBe(false);
  });
  it('has exactly the nine specified states', () => {
    expect([...LOCAL_INFERENCE_STATE_KINDS].sort()).toEqual(
      [
        'cancelled',
        'failed',
        'healthy',
        'inferring',
        'starting',
        'stopped',
        'stopping',
        'timed_out',
        'unavailable'
      ].sort()
    );
    expect(Object.keys(LOCAL_INFERENCE_TRANSITIONS).sort()).toEqual(
      [...LOCAL_INFERENCE_STATE_KINDS].sort()
    );
  });

  it('allows an explicit start only from a state with no runtime', () => {
    for (const from of ['unavailable', 'stopped', 'failed', 'cancelled', 'timed_out'] as const) {
      expect(localInferenceTransition(from, 'start_requested')).toBe('starting');
    }
    for (const from of ['starting', 'healthy', 'inferring', 'stopping'] as const) {
      expect(canLocalInferenceTransition(from, 'start_requested')).toBe(false);
      expect(() => localInferenceTransition(from, 'start_requested')).toThrow(InvalidTransitionError);
    }
  });

  it('allows inference only from healthy, and only one completion returns to healthy', () => {
    expect(localInferenceTransition('healthy', 'inference_started')).toBe('inferring');
    for (const from of [
      'unavailable',
      'starting',
      'inferring',
      'stopping',
      'stopped',
      'failed',
      'cancelled',
      'timed_out'
    ] as const) {
      expect(canLocalInferenceTransition(from, 'inference_started')).toBe(false);
    }

    expect(localInferenceTransition('inferring', 'inference_completed')).toBe('healthy');
    expect(localInferenceTransition('inferring', 'inference_failed')).toBe('failed');
    expect(localInferenceTransition('inferring', 'inference_cancelled')).toBe('cancelled');
    expect(localInferenceTransition('inferring', 'inference_timed_out')).toBe('timed_out');
  });

  it('allows an explicit health check only while healthy', () => {
    expect(localInferenceTransition('healthy', 'health_checked')).toBe('healthy');
    for (const from of LOCAL_INFERENCE_STATE_KINDS) {
      if (from === 'healthy') continue;
      expect(canLocalInferenceTransition(from, 'health_checked')).toBe(false);
    }
  });

  it('turns an unexpected process exit from healthy into failed', () => {
    expect(localInferenceTransition('healthy', 'process_exited')).toBe('failed');
    expect(localInferenceTransition('starting', 'process_exited')).toBe('failed');
    expect(localInferenceTransition('inferring', 'process_exited')).toBe('failed');
    expect(canLocalInferenceTransition('stopped', 'process_exited')).toBe(false);
  });

  it('accepts a stop from every state except one already stopping', () => {
    for (const from of LOCAL_INFERENCE_STATE_KINDS) {
      if (from === 'stopping') {
        expect(canLocalInferenceTransition(from, 'stop_requested')).toBe(false);
        continue;
      }
      const expected = from === 'stopped' ? from : 'stopping';
      expect(localInferenceTransition(from, 'stop_requested')).toBe(expected);
    }
    expect(localInferenceTransition('stopping', 'stop_completed')).toBe('stopped');
    expect(localInferenceTransition('stopping', 'stop_failed')).toBe('failed');
    expect(localInferenceTransition('stopping', 'stop_timed_out')).toBe('timed_out');
  });

  it('never leaves a startup in place: every start ends somewhere explicit', () => {
    expect(localInferenceTransition('starting', 'started_healthy')).toBe('healthy');
    expect(localInferenceTransition('starting', 'start_failed')).toBe('failed');
    expect(localInferenceTransition('starting', 'start_cancelled')).toBe('cancelled');
    expect(localInferenceTransition('starting', 'start_timed_out')).toBe('timed_out');
  });

  it('records a discovery failure only where no runtime is running', () => {
    for (const from of ['unavailable', 'stopped', 'failed', 'cancelled', 'timed_out'] as const) {
      expect(localInferenceTransition(from, 'discovery_failed')).toBe('unavailable');
    }
    for (const from of ['starting', 'healthy', 'inferring', 'stopping'] as const) {
      expect(canLocalInferenceTransition(from, 'discovery_failed')).toBe(false);
    }
  });

  it('refuses every move the table does not name, and names them all', () => {
    const kinds: readonly LocalInferenceStateKind[] = LOCAL_INFERENCE_STATE_KINDS;
    const events: readonly LocalInferenceEvent[] = LOCAL_INFERENCE_EVENTS;

    for (const from of kinds) {
      const allowed = new Set(allowedLocalInferenceEvents(from));
      for (const event of events) {
        if (allowed.has(event)) {
          expect(kinds).toContain(localInferenceTransition(from, event));
        } else {
          expect(() => localInferenceTransition(from, event)).toThrow(InvalidTransitionError);
        }
      }
    }
  });

  it('reports a refused move with the INVALID_TRANSITION code', () => {
    try {
      localInferenceTransition('stopped', 'inference_started');
      expect.unreachable('the transition should have thrown');
    } catch (error) {
      expect((error as InvalidTransitionError).code).toBe('INVALID_TRANSITION');
    }
  });
});
