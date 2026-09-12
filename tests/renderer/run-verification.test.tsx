/** @vitest-environment jsdom */
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VerificationSummary } from '../../src/renderer/src/components/RelayTimeline';
import type { Run } from '../../src/shared/domain/models';
afterEach(cleanup);
it('shows the command, exit, snapshot and historical nature of a stored result', () => {
  const run: Run = {id:'r', taskId:'t', agent:'system', runType:'verification', status:'succeeded', round:1, startedAt:'2026-09-10', finishedAt:'2026-09-10', finalMessage:null, errorMessage:null, structuredResult:JSON.stringify({version:1, command:'npm run verify', identity:'a'.repeat(64), passed:true, exitCode:0, durationMs:10, reason:null})};
  render(<VerificationSummary run={run} />);
  expect(screen.getByText('Command: npm run verify')).toBeTruthy();
  expect(screen.getByText(/Exit: 0/)).toBeTruthy();
  expect(screen.getByText(/Historical result/)).toBeTruthy();
});
