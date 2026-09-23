import { describe, expect, it } from 'vitest';
import {
  IPC_CHANNELS,
  ipcInputSchemas,
  type IpcResponseMap
} from '../../src/shared/ipc';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  LOCAL_INFERENCE_LIMITS,
  LOCAL_INFERENCE_PROTOCOL,
  type LocalInferenceCapabilities,
  type LocalInferenceOutcome,
  type LocalInferenceProfileSummary,
  type LocalInferenceState
} from '../../src/shared/domain/local-inference';

const LIFECYCLE_CHANNELS = [
  'localInference:getCapabilities',
  'localInference:start',
  'localInference:getState',
  'localInference:checkHealth',
  'localInference:stop'
] as const;

/** Read-only or profile-selection channels: additive alongside the five lifecycle ones, never a path,
 *  identity, executable or fingerprint — see `listProfiles`'s own doc comment in `shared/ipc.ts`. */
const PROFILE_CHANNELS = ['localInference:listProfiles', 'localInference:selectProfile'] as const;

const ALL_CHANNELS = [
  ...LIFECYCLE_CHANNELS,
  'localInference:runTestInference',
  ...PROFILE_CHANNELS
] as const;

describe('local-inference IPC contract', () => {
  it('contains exactly the five lifecycle channels plus the additive prompt and profile channels', () => {
    expect(IPC_CHANNELS.filter((channel) => channel.startsWith('localInference:')).sort()).toEqual(
      [...ALL_CHANNELS].sort()
    );
  });

  it('localInference:listProfiles accepts only a strict empty object', () => {
    const schema = ipcInputSchemas['localInference:listProfiles'];
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ profileId: 'default' }).success).toBe(false);
  });

  it('localInference:selectProfile accepts only a bounded profileId and nothing else', () => {
    const schema = ipcInputSchemas['localInference:selectProfile'];
    expect(schema.safeParse({ profileId: 'default' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ profileId: '' }).success).toBe(false);
    expect(schema.safeParse({ profileId: 'x'.repeat(65) }).success).toBe(false);
    expect(schema.safeParse({ profileId: 'default', path: 'C:\\models\\model.gguf' }).success).toBe(false);
  });

  it('accepts only strict empty objects on every lifecycle channel', () => {
    const smuggled = [
      { executable: 'C:\\tools\\llama-server.exe' },
      { argv: ['--port', '9'] },
      { model: 'model.gguf' },
      { path: 'C:\\models\\model.gguf' },
      { prompt: 'repository contents' },
      { url: 'http://elsewhere' },
      { repository: 'C:\\repo' },
      { token: 'not-a-real-token' },
      { command: 'run anything' }
    ];

    for (const channel of LIFECYCLE_CHANNELS) {
      expect(ipcInputSchemas[channel].safeParse({}).success).toBe(true);
      for (const input of smuggled) {
        expect(ipcInputSchemas[channel].safeParse(input).success).toBe(false);
      }
    }
  });

  describe('localInference:runTestInference', () => {
    const schema = ipcInputSchemas['localInference:runTestInference'];

    it('accepts only a bounded, non-empty prompt', () => {
      expect(schema.safeParse({ prompt: 'Say something short.' }).success).toBe(true);
      expect(schema.safeParse({ prompt: 'ok' }).success).toBe(true);
    });

    it('rejects a missing, empty or oversized prompt', () => {
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ prompt: '' }).success).toBe(false);
      expect(
        schema.safeParse({ prompt: 'x'.repeat(LOCAL_INFERENCE_LIMITS.messageContentMax + 1) }).success
      ).toBe(false);
      expect(
        schema.safeParse({ prompt: 'x'.repeat(LOCAL_INFERENCE_LIMITS.messageContentMax) }).success
      ).toBe(true);
    });

    it('rejects unknown properties and every other channel is not allowed to smuggle', () => {
      const smuggled = [
        { prompt: 'hi', requestId: 'req-1' },
        { prompt: 'hi', messages: [{ role: 'user', content: 'hi' }] },
        { prompt: 'hi', maxOutputTokens: 999_999 },
        { prompt: 'hi', chatTemplateParameters: { enable_thinking: true } },
        { prompt: 'hi', model: 'other-model' },
        { prompt: 'hi', executable: 'C:\\tools\\llama-server.exe' },
        { prompt: 'hi', path: 'C:\\models\\model.gguf' },
        { prompt: 'hi', host: '0.0.0.0' },
        { prompt: 'hi', url: 'http://elsewhere' },
        { prompt: 'hi', repository: 'C:\\repo' },
        { prompt: 'hi', argv: ['--port', '9'] },
        { prompt: 'hi', command: 'run anything' },
        { prompt: 'hi', token: 'not-a-real-token' }
      ];
      for (const input of smuggled) {
        expect(schema.safeParse(input).success).toBe(false);
      }
    });

    it('rejects a non-string prompt', () => {
      expect(schema.safeParse({ prompt: 123 }).success).toBe(false);
      expect(schema.safeParse({ prompt: null }).success).toBe(false);
      expect(schema.safeParse({ prompt: ['hi'] }).success).toBe(false);
    });
  });

  it('declares the existing capability and state DTOs as responses', () => {
    const capabilities: LocalInferenceCapabilities = {
      protocol: LOCAL_INFERENCE_PROTOCOL,
      contractVersion: LOCAL_INFERENCE_CONTRACT_VERSION,
      providerId: 'local-llama-cpp',
      modelId: 'local-model',
      available: false,
      unavailableReason: 'Not installed.',
      executableSource: null,
      runtimeVersion: null,
      supportsChatCompletions: true,
      supportsStreaming: false,
      supportsUsageWhenReported: true,
      supportsChatTemplateParameters: true,
      inferenceVerified: false
    };
    const state: LocalInferenceState = { kind: 'stopped' };
    const capabilityResponse: IpcResponseMap['localInference:getCapabilities'] = capabilities;
    const stateResponses: Array<
      | IpcResponseMap['localInference:start']
      | IpcResponseMap['localInference:getState']
      | IpcResponseMap['localInference:checkHealth']
      | IpcResponseMap['localInference:stop']
    > = [state];
    expect(capabilityResponse).toBe(capabilities);
    expect(stateResponses).toEqual([state]);
  });

  it('maps localInference:runTestInference to the existing version-1 LocalInferenceOutcome', () => {
    const outcome: LocalInferenceOutcome = {
      kind: 'failed',
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId: 'req-1',
      reason: 'boom',
      dispatchOutcome: 'not_dispatched'
    };
    const response: IpcResponseMap['localInference:runTestInference'] = outcome;
    expect(response).toBe(outcome);
  });

  it('maps localInference:listProfiles to a readonly array of summaries, and selectProfile to null', () => {
    const summary: LocalInferenceProfileSummary = {
      id: 'default',
      displayName: 'Local model',
      enabled: true,
      isDefault: true,
      activity: 'inactive',
      activeStateKind: null
    };
    const profilesResponse: IpcResponseMap['localInference:listProfiles'] = [summary];
    const selectResponse: IpcResponseMap['localInference:selectProfile'] = null;
    expect(profilesResponse).toEqual([summary]);
    expect(selectResponse).toBeNull();
  });
});
