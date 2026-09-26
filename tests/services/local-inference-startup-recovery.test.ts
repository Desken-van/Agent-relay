import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApplication, type Application } from '../../src/main/container';
import type { ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import { RecordingConfirmationService } from '../helpers/fakes';

const roots: string[] = [];
const applications: Application[] = [];

afterEach(() => {
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local inference startup recovery', () => {
  it('restores only configuration and performs no probe, launch, request, retry, or auto-start', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-relay-local-restart-'));
    roots.push(root);
    const databaseFile = join(root, 'agent-relay.sqlite');
    let processCalls = 0;
    let providerConstructions = 0;
    const runner: ProcessRunner = {
      async run() {
        processCalls += 1;
        throw new Error('startup must not run a process');
      }
    };
    const start = (): Application => {
      const app = buildApplication({
        paths: { dataDir: root, documentsDir: root },
        databaseFile,
        events: new InMemoryEventPublisher(),
        confirmation: new RecordingConfirmationService(false),
        processRunner: runner,
        localInferenceProviderFactory: () => {
          providerConstructions += 1;
          throw new Error('startup must not construct or call a provider');
        }
      });
      applications.push(app);
      return app;
    };

    const first = start();
    const before = first.settings.get().localInference;
    const custom = {
      ...before,
      // Enabled on purpose: the claim under test is that startup never probes,
      // launches or auto-starts *even when the operator has opted in* — a
      // disabled configuration proving the same thing would be a weaker test.
      enabled: true,
      profiles: before.profiles.map((profile) =>
        profile.id === before.defaultProfileId
          ? {
              ...profile,
              enabled: true,
              executable: { kind: 'explicit_path' as const, path: 'C:\\tools\\llama-server.exe' },
              model: {
                id: 'restart-model',
                source: { kind: 'runtime_id' as const, runtimeModelId: 'restart-source' }
              },
              fixedArguments: ['--threads', '6'],
              port: 19222,
              contextLimitTokens: 16384
            }
          : profile
      )
    };
    first.settings.update({ localInference: custom });
    first.close();
    applications.splice(applications.indexOf(first), 1);

    const reopened = start();
    expect(reopened.settings.get().localInference).toEqual(custom);
    // Nothing selects a profile on its own, on startup or otherwise — the volatile "which profile the
    // retained runtime is bound to" concept starts unselected every time the process starts, exactly like
    // it never auto-starts. Only once an operator explicitly picks one does state() report anything but
    // "no profile selected", still without probing, launching or contacting anything.
    expect(reopened.localInference.state()).toEqual({
      kind: 'unavailable',
      reason: 'No local-model profile is selected. Choose one in Settings → Local inference.'
    });
    expect(processCalls).toBe(0);
    expect(providerConstructions).toBe(0);

    reopened.localInference.selectActiveProfile(before.defaultProfileId ?? 'default');
    expect(reopened.localInference.state()).toEqual({ kind: 'stopped' });
    expect(processCalls).toBe(0);
    expect(providerConstructions).toBe(0);
  });
});
