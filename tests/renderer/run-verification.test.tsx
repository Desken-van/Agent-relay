/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { VerificationControls } from '../../src/renderer/src/components/RunView';
import { VerificationSummary } from '../../src/renderer/src/components/RelayTimeline';
import { taskSchema, type Run } from '../../src/shared/domain/models';
import { burstClick, deferred, deliver, installBridge, ok } from './harness';
const task = taskSchema.parse({id:'t', projectId:'p', title:'Task', originalRequest:'Do it', status:'READY_FOR_IMPLEMENTATION', currentRound:1, maxRounds:3, codexThreadId:null, claudeSessionId:null, worktreePath:'C:/test/worktree', branchName:'agent/task', baseBranch:'main', specificationJson:'{}', specificationApprovedAt:'2026-09-10T00:00:00.000Z', lastReviewJson:null, lastError:null, codexModel:null, claudeModel:null, createdAt:'2026-09-10T00:00:00.000Z', updatedAt:'2026-09-10T00:00:00.000Z'});
afterEach(cleanup);
it('submits verification once without implementation and refreshes the returned state', async () => {
  const pending = deferred<ReturnType<typeof ok<'workflow:verify'>>>();
  const bridge = installBridge({'workflow:verify':() => pending.promise});
  const changed = vi.fn(async () => {});
  render(<VerificationControls task={task} busy={false} onChanged={changed} />);
  burstClick(screen.getByRole('button', {name:/Run verification/}));
  expect(bridge.callsTo('workflow:verify')).toHaveLength(1);
  expect(bridge.callsTo('workflow:implement')).toHaveLength(0);
  await waitFor(() => expect(screen.getByRole('button', {name:/Run verification/})).toHaveProperty('disabled', true));
  await deliver(pending, ok<'workflow:verify'>({...task, status:'READY_FOR_REVIEW'}));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(screen.getByText(/Run review is available/)).toBeTruthy();
});
it.each(['VERIFYING', 'IMPLEMENTING', 'DRAFT', 'COMPLETED'] as const)('cannot start verification in %s', status => {
  installBridge(); render(<VerificationControls task={{...task,status}} busy={false} onChanged={async () => {}} />);
  expect(screen.getByRole('button', {name:/Run verification/})).toHaveProperty('disabled', true);
});
it('shows the command, exit, snapshot and historical nature of a stored result', () => {
  const run: Run = {id:'r', taskId:'t', agent:'system', runType:'verification', status:'succeeded', round:1, startedAt:'2026-09-10', finishedAt:'2026-09-10', finalMessage:null, errorMessage:null, structuredResult:JSON.stringify({version:1, command:'npm run verify', identity:'a'.repeat(64), passed:true, exitCode:0, durationMs:10, reason:null})};
  render(<VerificationSummary run={run} />);
  expect(screen.getByText('Command: npm run verify')).toBeTruthy();
  expect(screen.getByText(/Exit: 0/)).toBeTruthy();
  expect(screen.getByText(/Historical result/)).toBeTruthy();
});
