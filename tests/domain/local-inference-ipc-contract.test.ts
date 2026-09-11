import { describe, expect, it } from 'vitest';
import {
  IPC_CHANNELS,
  ipcInputSchemas,
  type IpcResponseMap
} from '../../src/shared/ipc';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  LOCAL_INFERENCE_PROTOCOL,
  type LocalInferenceCapabilities,
  type LocalInferenceState
} from '../../src/shared/domain/local-inference';

const CHANNELS = [
  'localInference:getCapabilities',
  'localInference:start',
  'localInference:getState',
  'localInference:checkHealth',
  'localInference:stop'
] as const;

describe('local-inference IPC contract', () => {
  it('contains exactly the five lifecycle channels', () => {
    expect(IPC_CHANNELS.filter((channel) => channel.startsWith('localInference:')).sort()).toEqual(
      [...CHANNELS].sort()
    );
  });

  it('accepts only strict empty objects on every channel', () => {
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

    for (const channel of CHANNELS) {
      expect(ipcInputSchemas[channel].safeParse({}).success).toBe(true);
      for (const input of smuggled) {
        expect(ipcInputSchemas[channel].safeParse(input).success).toBe(false);
      }
    }
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
});
