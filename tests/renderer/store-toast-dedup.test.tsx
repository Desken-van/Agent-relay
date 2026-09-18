import { describe, expect, it } from 'vitest';
import { initialState, reducer } from '../../src/renderer/src/state/store';

describe('store toast reducer', () => {
  it('drops a toast identical to the most recent still-visible one', () => {
    const first = reducer(initialState, {
      type: 'toast',
      toast: { id: 1, tone: 'error', title: 'Implementation run failed', body: 'HTTP 500' }
    });
    expect(first.toasts).toHaveLength(1);

    // A double-submitted action failing twice in the same tick must not stack
    // a second, identical toast.
    const second = reducer(first, {
      type: 'toast',
      toast: { id: 2, tone: 'error', title: 'Implementation run failed', body: 'HTTP 500' }
    });
    expect(second.toasts).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('keeps two toasts that differ in tone, title, or body', () => {
    const withFirst = reducer(initialState, {
      type: 'toast',
      toast: { id: 1, tone: 'error', title: 'Implementation run failed', body: 'HTTP 500' }
    });
    const withDifferentBody = reducer(withFirst, {
      type: 'toast',
      toast: { id: 2, tone: 'error', title: 'Implementation run failed', body: 'timeout' }
    });
    expect(withDifferentBody.toasts).toHaveLength(2);

    const withDifferentTitle = reducer(withDifferentBody, {
      type: 'toast',
      toast: { id: 3, tone: 'success', title: 'Implementation round finished' }
    });
    expect(withDifferentTitle.toasts).toHaveLength(3);
  });

  it('still allows the identical toast again once a different one came between', () => {
    const first = reducer(initialState, {
      type: 'toast',
      toast: { id: 1, tone: 'error', title: 'Implementation run failed', body: 'HTTP 500' }
    });
    const middle = reducer(first, {
      type: 'toast',
      toast: { id: 2, tone: 'success', title: 'Implementation round finished' }
    });
    const repeatOfFirst = reducer(middle, {
      type: 'toast',
      toast: { id: 3, tone: 'error', title: 'Implementation run failed', body: 'HTTP 500' }
    });
    expect(repeatOfFirst.toasts).toHaveLength(3);
  });
});
