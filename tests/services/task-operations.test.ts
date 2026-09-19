import { describe, expect, it } from 'vitest';
import { TaskOperationRegistry } from '../../src/main/services/task-operations';

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
