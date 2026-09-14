/**
 * `ornithDiagnostic()` and the passivity of the Ornith slice of
 * `ToolDiagnosticsService.run()` had no coverage: this proves every
 * `LocalInferenceState` — the unexpected-exit `failed` state included — maps
 * to a sensible, redacted diagnostic, and that building it never calls
 * `health`, `capabilities`, or `start` on the retained local-inference
 * service, only its cheap, synchronous `state()`.
 */
import { describe, expect, it } from 'vitest';
import { ornithDiagnostic, ToolDiagnosticsService } from '../../src/main/services/diagnostics-service';
import type { ToolDiagnostic } from '../../src/shared/domain/diagnostics';
import type { LocalInferenceState } from '../../src/shared/domain/local-inference';
import type {
  ClaudeAdapter,
  CodexAdapter,
  EventPublisher,
  GitAdapter,
  GitHubAdapter,
  LocalInferenceLifecycleService
} from '../../src/main/ports';

const passiveTool: ToolDiagnostic = {
  tool: 'git',
  status: 'ok',
  executablePath: '/usr/bin/git',
  version: '2.0.0',
  detail: 'ok',
  remediation: null,
  checkedAt: new Date(0).toISOString()
};

describe('ornithDiagnostic', () => {
  it('maps every local-inference state to a distinct, safe diagnostic', () => {
    const cases: Array<{ state: LocalInferenceState; status: ToolDiagnostic['status'] }> = [
      { state: { kind: 'unavailable', reason: 'Local inference is disabled.' }, status: 'missing' },
      { state: { kind: 'stopped' }, status: 'unauthenticated' },
      { state: { kind: 'starting', runtimeInstanceId: 'r1' }, status: 'unauthenticated' },
      { state: { kind: 'healthy', runtimeInstanceId: 'r1' }, status: 'ok' },
      { state: { kind: 'inferring', runtimeInstanceId: 'r1', requestId: 'req-1' }, status: 'ok' },
      { state: { kind: 'stopping', runtimeInstanceId: 'r1' }, status: 'unauthenticated' },
      { state: { kind: 'failed', reason: 'The runtime process exited unexpectedly.' }, status: 'error' },
      { state: { kind: 'cancelled', reason: 'cancelled' }, status: 'error' },
      { state: { kind: 'timed_out', reason: 'timed out' }, status: 'error' }
    ];

    for (const { state, status } of cases) {
      const diagnostic = ornithDiagnostic(state);
      expect(diagnostic.tool).toBe('ornith');
      expect(diagnostic.status).toBe(status);
      expect(diagnostic.executablePath).toBeNull();
      expect(typeof diagnostic.detail).toBe('string');
      expect(diagnostic.detail.length).toBeGreaterThan(0);
    }
  });

  it('reports the unexpected-exit ("failed") state as an error with actionable remediation, and never as ok/unauthenticated', () => {
    const diagnostic = ornithDiagnostic({ kind: 'failed', reason: 'The runtime process exited unexpectedly (1).' });
    expect(diagnostic.status).toBe('error');
    expect(diagnostic.detail).toContain('failed');
    expect(diagnostic.remediation).not.toBeNull();
  });
});

describe('ToolDiagnosticsService: Ornith slice stays passive', () => {
  function fakeAdapter(): CodexAdapter & ClaudeAdapter & GitAdapter & GitHubAdapter {
    return {
      diagnose: async () => passiveTool
    } as unknown as CodexAdapter & ClaudeAdapter & GitAdapter & GitHubAdapter;
  }

  it('builds the Ornith diagnostic from state() alone, never calling health, capabilities, or start', async () => {
    let stateCalls = 0;
    const localInference: LocalInferenceLifecycleService = {
      state: () => {
        stateCalls += 1;
        return { kind: 'failed', reason: 'The runtime process exited unexpectedly.' };
      },
      capabilities: async () => {
        throw new Error('capabilities() must never be called by diagnostics.');
      },
      start: async () => {
        throw new Error('start() must never be called by diagnostics.');
      },
      health: async () => {
        throw new Error('health() must never be called by diagnostics.');
      },
      stop: async () => {
        throw new Error('stop() must never be called by diagnostics.');
      },
      runTestInference: async () => {
        throw new Error('runTestInference() must never be called by diagnostics.');
      }
    };
    const events: EventPublisher = { publishDiagnostics: () => undefined } as unknown as EventPublisher;
    const adapter = fakeAdapter();

    const service = new ToolDiagnosticsService({
      codex: adapter,
      claude: adapter,
      git: adapter,
      github: adapter,
      localInference,
      events
    });

    const report = await service.run(true);

    expect(stateCalls).toBe(1);
    expect(report.ornith.status).toBe('error');
  });
});
