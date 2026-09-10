import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import { CodexImplementationEvidence, sdkCommandScript } from '../../src/main/adapters/codex/implementation-evidence';
const end: ThreadEvent = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
const command = (text: string, exit = 0, id = 'check'): ThreadEvent => ({ type: 'item.completed', item: { id, type: 'command_execution', command: text, aggregated_output: '', status: 'completed', exit_code: exit } });
function assess(events: ThreadEvent[]) { const e = new CodexImplementationEvidence(['Bash(npm test *)']); events.forEach(v => e.accept(v)); return e.assessment(); }
describe('Codex verification evidence', () => {
  it.each(['npm test', '/bin/bash -lc \'npm test\'', '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm test"'])('accepts a completed standalone check: %s', c => {
    expect(sdkCommandScript(c)).toBe('npm test'); expect(assess([command(c), end]).publishBlock).toBe('none');
  });
  it.each(['npm test; echo pass', '/bin/bash -lc \'npm test; echo pass\'', 'echo "npm test"', 'bash -lc "$TEST"', 'npm test && touch changed'])('refuses ambiguous or compound evidence: %s', c => {
    expect(assess([command(c), end]).publishBlock).not.toBe('none');
  });
  it('does not treat the final prose as test evidence', () => {
    expect(assess([{ type: 'item.completed', item: { id: 'text', type: 'agent_message', text: 'All tests pass' } }, end]).publishBlock).toBe('verification');
  });
  it('rejects failed checks, missing completion and later writes', () => {
    expect(assess([command('npm test', 1), end]).publishBlock).toBe('verification');
    expect(assess([command('npm test')]).publishBlock).toBe('telemetry');
    expect(assess([command('npm test'), { type: 'item.completed', item: { id: 'write', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'completed' } }, end]).publishBlock).toBe('verification');
  });
  it('rejects destructive operations even when a later check passes', () => {
    expect(assess([command('git reset --hard', 0, 'bad'), command('npm test'), end]).publishBlock).toBe('security');
  });
});
