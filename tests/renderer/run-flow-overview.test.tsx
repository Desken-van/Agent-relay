/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RunFlowOverview } from '../../src/renderer/src/components/RunView';

afterEach(cleanup);

describe('run flow overview', () => {
  it('renders the four user questions and marks the current workflow step', () => {
    render(<RunFlowOverview guidance={{
      happened: 'Verification passed for the current code snapshot.',
      stage: 'Step 4 of 5 · Review',
      result: 'The verified files are ready for the selected reviewer.',
      next: 'Run review · Codex',
      action: { key: 'run_review', label: 'Run review · Codex', enabled: true, disabledReason: null },
      activeStep: 3, tone: 'success'
    }} />);

    expect(screen.getByText('What happened')).toBeTruthy();
    expect(screen.getByText('Current stage')).toBeTruthy();
    expect(screen.getByText('Result')).toBeTruthy();
    expect(screen.getByText('Next action')).toBeTruthy();
    expect(screen.getByText('Run review · Codex')).toBeTruthy();
    expect(screen.getByText('Review').closest('li')?.getAttribute('aria-current')).toBe('step');
  });

  it('renders a review-blocked outcome with a warning tone, never an error tone', () => {
    const { container } = render(<RunFlowOverview guidance={{
      happened: 'The review completed and found that the approach itself needs rework.',
      stage: 'Review blocked',
      result: 'Wrong approach.',
      next: 'Continue in a new run',
      action: { key: 'continue_in_new_run', label: 'Continue in a new run', enabled: true, disabledReason: null },
      activeStep: 3, tone: 'warning'
    }} />);

    expect(container.querySelector('.run-guide--warning')).toBeTruthy();
    expect(container.querySelector('.run-guide--error')).toBeFalsy();
    expect(screen.getByText('Wrong approach.')).toBeTruthy();
    expect(screen.getByText('Continue in a new run')).toBeTruthy();
  });
});
