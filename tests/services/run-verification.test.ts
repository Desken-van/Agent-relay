import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import type { VerificationExecutor } from '../../src/main/services/worktree-verification';
import type { ProcessResult } from '../../src/main/adapters/process/process-runner';
import { planReconciliation } from '../../src/main/services/startup-reconciliation';
import { ipcInputSchemas } from '../../src/shared/ipc';

let h: Harness;
let identity: string;
let executed: number;
let result: ProcessResult;
let execute: VerificationExecutor['execute'];
beforeEach(() => {
  identity = 'a'.repeat(64); executed = 0;
  result = {command: 'npm run verify', exitCode: 0, stdout: 'tests passed', stderr: '', failed: false, timedOut: false, cancelled: false, durationMs: 15};
  execute = async (_target, _signal, progress) => { executed++; progress({type:'log', text:'npm run verify'}); return result; };
  h = createHarness({ verification: { identity: async () => identity, execute: (...args) => execute(...args) } });
});
afterEach(() => h.dispose());
async function prepared() {
  const project = h.createProject(); const task = h.createTask(project.id);
  await h.orchestrator.generateSpecification(task.id); h.orchestrator.approveSpecification(task.id);
  // Model the saved worktree after an unsuccessful implementation, not a new agent run.
  return h.tasks.update(task.id, {worktreePath: `${h.worktreesRoot}/task`, branchName: 'agent/task', baseBranch: 'main', currentRound: 1});
}
describe('verification-only workflow', () => {
  it('records system evidence and opens review without launching implementation or consuming a round', async () => {
    const task = await prepared();
    const verified = await h.orchestrator.runVerification(task.id);
    expect(verified).toMatchObject({status:'READY_FOR_REVIEW', currentRound:1, lastError:null});
    expect(h.claude.calls).toHaveLength(0); expect(h.codex.implementationCalls).toHaveLength(0);
    const run = h.runs.listByTask(task.id).find(r => r.runType === 'verification')!;
    expect(run).toMatchObject({agent:'system', status:'succeeded'});
    expect(JSON.parse(run.structuredResult!)).toMatchObject({identity, command:'npm run verify', passed:true, exitCode:0});
    await h.orchestrator.reviewWithCodex(task.id);
    expect(h.codex.reviewCalls).toHaveLength(1);
  });
  it.each(['exit', 'timeout', 'cancelled', 'changed'] as const)('does not open review after %s', async kind => {
    const task = await prepared();
    execute = async () => {
      if (kind === 'changed') identity = 'b'.repeat(64);
      return {...result, exitCode:kind === 'exit' ? 1 : 0, timedOut:kind === 'timeout', cancelled:kind === 'cancelled'};
    };
    expect((await h.orchestrator.runVerification(task.id)).status).toBe('READY_FOR_IMPLEMENTATION');
    await expect(h.orchestrator.reviewWithCodex(task.id)).rejects.toThrow();
    expect(h.codex.reviewCalls).toHaveLength(0);
  });
  it('refuses stale success at review dispatch and sends no reviewer request', async () => {
    const task = await prepared(); await h.orchestrator.runVerification(task.id);
    identity = 'b'.repeat(64);
    await expect(h.orchestrator.reviewWithCodex(task.id)).rejects.toThrow(/stale/);
    expect(h.tasks.findById(task.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(h.codex.reviewCalls).toHaveLength(0);
  });
  it('shares the task exclusion with implementation and refuses a double verification', async () => {
    const task = await prepared(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    execute = async () => { executed++; await pending; return result; };
    const first = h.orchestrator.runVerification(task.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(h.orchestrator.runVerification(task.id)).rejects.toThrow();
    await expect(h.orchestrator.sendToClaude(task.id)).rejects.toThrow();
    release(); await first; expect(executed).toBe(1);
  });
  it('recovers interrupted verification without granting success', async () => {
    const task = await prepared();
    const plan = planReconciliation({ runningRuns: [], busyTasks:[{...task, status:'VERIFYING'}] });
    expect(plan.recoveries[0]).toMatchObject({to:'READY_FOR_IMPLEMENTATION', event:'verification_aborted'});
  });
  it('does not hide a security denial behind a test pass', async () => {
    const task = await prepared();
    h.runs.create({id:'denied', taskId:task.id, agent:'codex', runType:'implementation', status:'running', round:1, startedAt:h.clock.nowIso()});
    h.runs.finish('denied', {status:'failed', finishedAt:h.clock.nowIso(), finalMessage:null, errorMessage:null, structuredResult:JSON.stringify({assessment:{version:1, disposition:'fail', publishBlock:'security', verificationStatus:'unknown', reasonCodes:[], verification:null, denials:[]}})});
    await expect(h.orchestrator.runVerification(task.id)).rejects.toThrow(/security/);
    expect(executed).toBe(0);
  });
  it('checks verification identity again at publication', async () => {
    const task = await prepared(); await h.orchestrator.runVerification(task.id);
    await h.orchestrator.reviewWithCodex(task.id); h.orchestrator.approveForPublishing(task.id);
    identity = 'b'.repeat(64);
    await expect(h.publishService.execute({taskId:task.id, action:'commit'})).rejects.toThrow(/no longer covers/);
  });
  it('accepts only a task id over IPC, never a command', () => {
    expect(ipcInputSchemas['workflow:verify'].safeParse({taskId:'t', command:'anything'}).success).toBe(false);
  });
  it('cancels an active verification without granting review and permits an explicit retry', async () => {
    const task = await prepared();
    execute = async (_target, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({...result, cancelled:true}), {once:true});
    });
    const pending = h.orchestrator.runVerification(task.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    h.orchestrator.stop(task.id);
    expect((await pending).status).toBe('READY_FOR_IMPLEMENTATION');
    execute = async () => result;
    expect((await h.orchestrator.runVerification(task.id)).status).toBe('READY_FOR_REVIEW');
  });
  it('does not reset a later round when failed verification is followed by implementation', async () => {
    const task = await prepared(); h.tasks.update(task.id, {currentRound:3});
    result = {...result, exitCode:1, failed:true};
    await h.orchestrator.runVerification(task.id);
    expect((await h.orchestrator.sendToClaude(task.id)).currentRound).toBe(3);
  });
  it('verification costs no round but a new review after an approval still consumes the next one', async () => {
    const task = await prepared();
    await h.orchestrator.runVerification(task.id); await h.orchestrator.reviewWithCodex(task.id);
    expect((await h.orchestrator.runVerification(task.id)).currentRound).toBe(1);
    expect((await h.orchestrator.reviewWithCodex(task.id)).currentRound).toBe(2);
  });
});
