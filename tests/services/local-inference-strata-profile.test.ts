/**
 * A Strata profile through the pieces that turn a saved profile into a running one: its shape rules in
 * Settings, the fingerprint a task binding is checked against, the configuration the service assembles, and
 * the summary every picker shows. The llama.cpp side of each must stay exactly what it was.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { localInferenceProfileFingerprint } from '../../src/main/services/local-inference-profile-fingerprint';
import {
  assembleLocalInferenceConfig,
  LOCAL_INFERENCE_PROVIDER_ID,
  localInferenceProviderIdFor,
  STRATA_LOCAL_INFERENCE_PROVIDER_ID
} from '../../src/main/services/local-inference-service';
import {
  defaultLocalInferenceSettings,
  localInferenceProfileSchema,
  localInferenceProfilesSettingsSchema,
  localRuntimeTag,
  summarizeLocalInferenceProfiles,
  type LocalInferenceProfile
} from '../../src/shared/domain/local-inference';

const llamaProfile = (): LocalInferenceProfile => ({
  ...defaultLocalInferenceSettings().profiles[0]!,
  executable: { kind: 'explicit_path', path: '/opt/llama/llama-server' },
  model: { id: 'ornith-9b', source: { kind: 'path', path: '/models/ornith.gguf' } },
  fixedArguments: ['-ngl', 'all'],
  contextLimitTokens: 32768,
  requestDefaults: { maxOutputTokens: 1024, chatTemplateParameters: { enable_thinking: false } }
});

const strataProfile = (): LocalInferenceProfile => ({
  ...defaultLocalInferenceSettings().profiles[0]!,
  id: 'strata-coder',
  displayName: 'Strata Qwen Coder',
  adapterKind: 'strata',
  strata: { serverScript: '/opt/strata/src/serve/server.py', engineConfig: '/opt/strata/src/strata-coder-iq1_m.json' },
  executable: { kind: 'explicit_path', path: '/opt/strata/src/.venv/bin/python' },
  model: { id: 'qwen-coder', source: { kind: 'runtime_id', runtimeModelId: 'qwen3.8-flash-next-coder-iq1_m' } },
  fixedArguments: [],
  port: 18190,
  contextLimitTokens: 32768,
  requestDefaults: { maxOutputTokens: 1024, chatTemplateParameters: { enable_thinking: false } }
});

/** The fingerprint exactly as it was computed before Strata existed. */
function legacyFingerprint(profile: LocalInferenceProfile): string {
  const { executable, model, fixedArguments, port, contextLimitTokens, startupTimeoutMs, healthTimeoutMs, inferenceTimeoutMs, shutdownTimeoutMs, requestDefaults } = profile;
  const shape = { executable, model, fixedArguments, port, contextLimitTokens, startupTimeoutMs, healthTimeoutMs, inferenceTimeoutMs, shutdownTimeoutMs, requestDefaults };
  return createHash('sha256').update(JSON.stringify(shape), 'utf8').digest('hex').slice(0, 16);
}

describe('a Strata profile in Settings', () => {
  it('is a valid profile beside llama.cpp ones, and a stored llama.cpp profile still parses unchanged', () => {
    const settings = { ...defaultLocalInferenceSettings(), profiles: [llamaProfile(), strataProfile()] };
    const parsed = localInferenceProfilesSettingsSchema.parse(settings);
    expect(parsed.profiles.map((p) => p.adapterKind)).toEqual(['llama_cpp', 'strata']);
    expect(parsed.profiles[0]).not.toHaveProperty('strata');
    expect(parsed.profiles[1]!.strata).toEqual(strataProfile().strata);
  });

  it('refuses a Strata profile that would run something else than Strata\'s own interpreter and config', () => {
    const bad: Array<[string, Partial<LocalInferenceProfile>]> = [
      ['no Strata paths', { strata: undefined }],
      ['PATH discovery', { executable: { kind: 'discovered', command: 'llama-server' } }],
      ['a model file', { model: { id: 'qwen-coder', source: { kind: 'path', path: '/m.gguf' } } }],
      ['fixed arguments', { fixedArguments: ['--mcp-config', '/x.json'] }],
      ['a relative server script', { strata: { serverScript: 'serve/server.py', engineConfig: '/opt/strata/src/x.json' } }]
    ];
    for (const [label, patch] of bad) {
      expect(localInferenceProfileSchema.safeParse({ ...strataProfile(), ...patch }).success, label).toBe(false);
    }
    expect(localInferenceProfileSchema.safeParse({ ...llamaProfile(), strata: strataProfile().strata }).success).toBe(false);
  });
});

describe('what a task binding is checked against', () => {
  it('leaves every llama.cpp profile\'s fingerprint exactly as it was', () => {
    for (const profile of [llamaProfile(), defaultLocalInferenceSettings().profiles[0]!]) {
      expect(localInferenceProfileFingerprint(profile)).toBe(legacyFingerprint(profile));
    }
  });

  it('changes a Strata profile\'s fingerprint when its server or model config changes, not when it is renamed', () => {
    const base = localInferenceProfileFingerprint(strataProfile());
    expect(localInferenceProfileFingerprint({ ...strataProfile(), displayName: 'Renamed' })).toBe(base);
    expect(localInferenceProfileFingerprint({ ...strataProfile(), strata: { ...strataProfile().strata!, engineConfig: '/opt/strata/src/other.json' } })).not.toBe(base);
    expect(localInferenceProfileFingerprint({ ...strataProfile(), strata: { ...strataProfile().strata!, serverScript: '/srv/strata/serve/server.py' } })).not.toBe(base);
    // Never equal to a llama.cpp profile that happens to share the other fields.
    expect(base).not.toBe(legacyFingerprint(strataProfile()));
  });
});

describe('the configuration the service assembles', () => {
  it('names a Strata runtime as Strata: provider identity, kind, paths and Strata\'s own directory to stand in', () => {
    const config = assembleLocalInferenceConfig(strataProfile());
    expect(config).toMatchObject({
      providerId: STRATA_LOCAL_INFERENCE_PROVIDER_ID,
      adapterKind: 'strata',
      strata: strataProfile().strata,
      workingDirectory: '/opt/strata/src',
      model: { id: 'qwen-coder' }
    });
    expect(STRATA_LOCAL_INFERENCE_PROVIDER_ID).not.toBe(LOCAL_INFERENCE_PROVIDER_ID);
  });

  it('assembles a llama.cpp profile exactly as before', () => {
    const config = assembleLocalInferenceConfig(llamaProfile());
    expect(config.providerId).toBe(LOCAL_INFERENCE_PROVIDER_ID);
    expect(config.adapterKind).toBe('llama_cpp');
    expect(config).not.toHaveProperty('strata');
    expect(config).not.toHaveProperty('workingDirectory');
    expect(localInferenceProviderIdFor(llamaProfile())).toBe('local-llama-cpp');
  });
});

describe('what every picker shows', () => {
  it('tags a Strata profile as Strata and leaves a llama.cpp profile\'s name as it was', () => {
    const settings = { ...defaultLocalInferenceSettings(), profiles: [llamaProfile(), strataProfile()] };
    const summaries = summarizeLocalInferenceProfiles(settings, null, 'stopped');
    expect(summaries.map((s) => [s.displayName + localRuntimeTag(s.runtime), s.runtime])).toEqual([
      ['Local model', 'llama_cpp'],
      ['Strata Qwen Coder · Strata', 'strata']
    ]);
  });
});
