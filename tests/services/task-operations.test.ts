import { describe, expect, it } from 'vitest';
import { AgentRelayError } from '../../src/shared/domain/errors';
import { runAsOperation, TaskOperationRegistry } from '../../src/main/services/task-operations';

describe('TaskOperationRegistry', () => {
  it('registers an operation with a live signal and forgets it on release', () => {
    const registry = new TaskOperationRegistry();

    const operation = registry.begin('task-1', 'plan_correction', { exclusive: true });

    expect(registry.isActive('task-1')).toBe(true);
    expect(operation.signal.aborted).toBe(false);
    operation.release();
    expect(registry.isActive('task-1')).toBe(false);
  });

  it('release is idempotent, so a second call can never free somebody else’s entry', () => {
    const registry = new TaskOperationRegistry();
    const first = registry.begin('task-1', 'plan_correction', { exclusive: true });
    first.release();
    const second = registry.begin('task-1', 'plan_correction', { exclusive: true });

    first.release();

    expect(registry.isActive('task-1')).toBe(true);
    second.release();
    expect(registry.isActive('task-1')).toBe(false);
  });

  it('refuses an exclusive operation while anything is registered, and anything while an exclusive one is', () => {
    const registry = new TaskOperationRegistry();
    const shared = registry.begin('task-1', 'plan_auto_decide', { exclusive: false });

    expect(() => registry.begin('task-1', 'plan_correction', { exclusive: true })).toThrow(/already has an operation running/);
    shared.release();
    const exclusive = registry.begin('task-1', 'plan_correction', { exclusive: true });
    expect(() => registry.begin('task-1', 'plan_auto_decide', { exclusive: false })).toThrowError(
      expect.objectContaining({ code: 'BUSY' })
    );
    exclusive.release();
  });

  it('lets several shared operations (different findings) run together', () => {
    const registry = new TaskOperationRegistry();

    const a = registry.begin('task-1', 'plan_auto_decide', { exclusive: false });
    const b = registry.begin('task-1', 'plan_auto_decide', { exclusive: false });

    expect(registry.abort('task-1')).toBe(2);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it('keeps tasks apart: an operation on one task never blocks or stops another', () => {
    const registry = new TaskOperationRegistry();
    const first = registry.begin('task-1', 'plan_correction', { exclusive: true });
    const second = registry.begin('task-2', 'plan_correction', { exclusive: true });

    expect(registry.abort('task-1')).toBe(1);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(registry.abort('task-3')).toBe(0);
  });

  it('links the caller’s signal both ways: aborting it aborts the operation, and one already aborted starts aborted', () => {
    const registry = new TaskOperationRegistry();
    const caller = new AbortController();
    const linked = registry.begin('task-1', 'plan_correction', { exclusive: true, signal: caller.signal });

    caller.abort();
    expect(linked.signal.aborted).toBe(true);
    linked.release();

    const already = new AbortController();
    already.abort();
    const born = registry.begin('task-1', 'plan_correction', { exclusive: true, signal: already.signal });
    expect(born.signal.aborted).toBe(true);
    born.release();
  });

  it('stops listening to the caller’s signal once released, so a long-lived signal leaks nothing', () => {
    const registry = new TaskOperationRegistry();
    const caller = new AbortController();
    const operation = registry.begin('task-1', 'plan_correction', { exclusive: true, signal: caller.signal });

    operation.release();
    caller.abort();

    expect(operation.signal.aborted).toBe(false);
  });
});

describe('runAsOperation', () => {
  const options = (claim: () => () => void = () => () => undefined) => ({
    exclusive: true,
    claim,
    stoppedMessage: 'Stopped while running.'
  });

  it('registers for the body, hands it the operation’s signal, and releases the registration and the claim after it', async () => {
    const registry = new TaskOperationRegistry();
    let claimed = 0;
    let released = 0;
    let seen: AbortSignal | undefined;

    const result = await runAsOperation(
      registry,
      'task-1',
      'code_review',
      options(() => {
        claimed += 1;
        return () => {
          released += 1;
        };
      }),
      (signal) => {
        seen = signal;
        expect(registry.isActive('task-1')).toBe(true);
        return Promise.resolve('done');
      }
    );

    expect(result).toBe('done');
    expect(seen?.aborted).toBe(false);
    expect([claimed, released]).toEqual([1, 1]);
    expect(registry.isActive('task-1')).toBe(false);
  });

  it('is stopped by registry.abort, and reports whatever the body threw after that as a stop', async () => {
    const registry = new TaskOperationRegistry();

    const running = runAsOperation(registry, 'task-1', 'code_triage', options(), async (signal) => {
      registry.abort('task-1');
      expect(signal.aborted).toBe(true);
      throw new Error('the provider process was killed');
    });

    await expect(running).rejects.toMatchObject({ code: 'CANCELLED', message: 'Stopped while running.' });
    expect(registry.isActive('task-1')).toBe(false);
  });

  it('keeps a failure that was not a stop as itself, and keeps a CANCELLED that is already typed', async () => {
    const registry = new TaskOperationRegistry();

    await expect(
      runAsOperation(registry, 'task-1', 'code_review', options(), () => Promise.reject(new Error('plain failure')))
    ).rejects.toThrow('plain failure');
    expect(registry.isActive('task-1')).toBe(false);

    const typed = new AgentRelayError('CANCELLED', 'Typed already.');
    await expect(
      runAsOperation(registry, 'task-1', 'code_review', options(), async () => {
        registry.abort('task-1');
        throw typed;
      })
    ).rejects.toBe(typed);
  });

  it('refuses before the claim or the body when something conflicting is registered, and leaves that entry alone', async () => {
    const registry = new TaskOperationRegistry();
    const other = registry.begin('task-1', 'plan_correction', { exclusive: true });
    let claimed = false;
    let ran = false;

    await expect(
      runAsOperation(
        registry,
        'task-1',
        'code_review',
        options(() => {
          claimed = true;
          return () => undefined;
        }),
        async () => {
          ran = true;
        }
      )
    ).rejects.toMatchObject({ code: 'BUSY' });

    expect([claimed, ran]).toEqual([false, false]);
    expect(registry.isActive('task-1')).toBe(true);
    other.release();
  });

  it('releases the registration when the claim itself is refused', async () => {
    const registry = new TaskOperationRegistry();

    await expect(
      runAsOperation(
        registry,
        'task-1',
        'code_review',
        options(() => {
          throw new AgentRelayError('BUSY', 'Somebody holds the claim.');
        }),
        async () => undefined
      )
    ).rejects.toMatchObject({ code: 'BUSY' });

    expect(registry.isActive('task-1')).toBe(false);
  });

  it('honours the caller’s own signal too', async () => {
    const registry = new TaskOperationRegistry();
    const caller = new AbortController();

    const running = runAsOperation(
      registry,
      'task-1',
      'code_review',
      { ...options(), signal: caller.signal },
      async (signal) => {
        caller.abort();
        return signal.aborted;
      }
    );

    await expect(running).resolves.toBe(true);
  });
});
