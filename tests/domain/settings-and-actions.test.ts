/**
 * The pure decisions behind two buttons.
 *
 * Both were wrong in ways a type checker could not catch: a button disabled
 * where the backend would have allowed the action, and a Save that quietly
 * replaced the user's rules with the defaults. Extracting the rules from the
 * components is what makes them testable at all.
 */

import { describe, expect, it } from 'vitest';
import {
  correctionAction,
  latestClaudeRoundResult
} from '../../src/shared/domain/claude-assessment';
import type { TaskStatus } from '../../src/shared/domain/workflow';
import {
  READY_TO_PUBLISH_CASES,
  storedAssessment
} from '../helpers/ready-to-publish-cases';
import {
  clearLocalEdits,
  resetPermissionRules,
  type Settings
} from '../../src/shared/domain/models';
import { defaultSettings } from '../../src/main/container';

/* -------------------------------------------------------------------------- */
/* Starting another Claude round                                               */
/* -------------------------------------------------------------------------- */

const stored = storedAssessment;

const action = (input: Partial<Parameters<typeof correctionAction>[0]> = {}) =>
  correctionAction({
    status: 'CHANGES_REQUESTED',
    currentRound: 1,
    maxRounds: 5,
    latestClaudeStructuredResult: null,
    ...input
  });

describe('after a review asked for changes', () => {
  it('offers to send corrections', () => {
    expect(action()).toMatchObject({
      kind: 'corrections',
      label: 'Send corrections',
      enabled: true
    });
  });

  it('stops at the round budget, and says why', () => {
    const result = action({ currentRound: 5, maxRounds: 5 });

    expect(result.enabled).toBe(false);
    expect(result.disabledReason).toMatch(/round budget/i);
  });

  it('is unaffected by whatever the last round recorded', () => {
    // Corrections are driven by the review, not by the publish gate.
    expect(action({ latestClaudeStructuredResult: stored('security') })).toMatchObject({
      kind: 'corrections',
      enabled: true
    });
  });
});

describe('after the publish gate refused an approved round', () => {
  const waiting = (structuredResult: string | null) =>
    action({ status: 'READY_TO_PUBLISH', latestClaudeStructuredResult: structuredResult });

  it('offers to retry verification, under its own name', () => {
    // Not "send corrections": the reviewer was satisfied, so there are no
    // findings to act on, and asking for corrections would describe work nobody
    // requested.
    expect(waiting(stored('verification'))).toMatchObject({
      kind: 'retry_verification',
      label: 'Retry verification',
      enabled: true
    });
  });

  it.each(READY_TO_PUBLISH_CASES)('decides $name the same way every time', (row) => {
    // The shared table. The orchestrator's integration tests walk the same rows,
    // so "the UI and the backend agree" is asserted rather than assumed.
    expect(waiting(row.structuredResult).kind).toBe(row.kind);
  });

  it('offers nothing when the round is clear to publish', () => {
    // The task is finished and waiting for a person. An extra round here would
    // be pointless work on code that is already done.
    expect(waiting(stored('none'))).toMatchObject({ kind: 'unavailable', enabled: false });
  });

  it('still respects the round budget', () => {
    const result = correctionAction({
      status: 'READY_TO_PUBLISH',
      currentRound: 5,
      maxRounds: 5,
      latestClaudeStructuredResult: stored('verification')
    });

    expect(result.enabled).toBe(false);
    expect(result.disabledReason).toMatch(/round budget/i);
  });
});

describe('every other state', () => {
  const others: TaskStatus[] = [
    'DRAFT',
    'SPECIFYING',
    'READY_FOR_IMPLEMENTATION',
    'IMPLEMENTING',
    'READY_FOR_REVIEW',
    'REVIEWING',
    'APPROVED',
    'PUBLISHING',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
  ];

  it('offers nothing', () => {
    for (const status of others) {
      expect(action({ status }).kind).toBe('unavailable');
      expect(action({ status }).enabled).toBe(false);
    }
  });

  it('offers nothing when no task is selected', () => {
    expect(action({ status: null }).kind).toBe('unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/* Which round the assessment comes from                                       */
/* -------------------------------------------------------------------------- */

describe('choosing the latest Claude round', () => {
  const run = (agent: string, runType: string, structuredResult: string | null) => ({
    agent,
    runType,
    structuredResult
  });

  it('takes the last Claude round in run order', () => {
    expect(
      latestClaudeRoundResult([
        run('claude', 'implementation', 'first'),
        run('codex', 'review', 'a review'),
        run('claude', 'correction', 'second')
      ])
    ).toBe('second');
  });

  it('ignores runs by other agents and other kinds', () => {
    expect(
      latestClaudeRoundResult([
        run('claude', 'implementation', 'the round'),
        run('codex', 'review', 'a review'),
        run('system', 'git', 'a commit')
      ])
    ).toBe('the round');
  });

  it('does not prefer a correction that came before an implementation', () => {
    // Order, not type. Preferring "the newest correction, else the
    // implementation" would name the wrong round the moment a recovery round
    // follows one, and three callers picking differently would disagree about
    // whether a task may publish.
    expect(
      latestClaudeRoundResult([
        run('claude', 'correction', 'older'),
        run('claude', 'implementation', 'newer')
      ])
    ).toBe('newer');
  });

  it('is null when the task has had no Claude round', () => {
    expect(latestClaudeRoundResult([])).toBeNull();
    expect(latestClaudeRoundResult([run('codex', 'specification', 'spec')])).toBeNull();
  });

  it('passes a null structured result through as null', () => {
    expect(latestClaudeRoundResult([run('claude', 'implementation', null)])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Reset and Save are different operations                                     */
/* -------------------------------------------------------------------------- */

describe('the Settings form draft', () => {
  const defaults: Settings = defaultSettings({ dataDir: 'C:\\data', documentsDir: 'C:\\docs' });

  const custom = {
    claudeAllowedTools: ['Bash(npm run verify *)'],
    claudeVerificationTools: ['Bash(npm run verify *)']
  };

  it('Reset restores the two shipped rules, in the values and the text', () => {
    const next = resetPermissionRules();

    expect(next.claudeAllowedTools).toEqual(['Bash(npm test *)', 'PowerShell(npm test *)']);
    expect(next.claudeVerificationTools).toEqual(['Bash(npm test *)', 'PowerShell(npm test *)']);
    // Both textareas move with the values, or the form shows one thing and
    // saves another.
    expect(next.allowedText).toBe('Bash(npm test *)\nPowerShell(npm test *)');
    expect(next.verificationText).toBe('Bash(npm test *)\nPowerShell(npm test *)');
  });

  it('Save clears the draft instead of resetting it', () => {
    // The bug this separates out: a successful save used to run Reset, which
    // put the defaults back on screen over the rules the user had just stored.
    const cleared = clearLocalEdits();

    expect(cleared).toEqual({ draft: null, allowedText: null, verificationText: null });
  });

  it('keeps custom rules on screen after a save', () => {
    // What the component does with the two results. After saving, the form
    // falls back to the stored settings; nothing overwrites them.
    const savedSettings: Settings = { ...defaults, ...custom };
    const cleared = clearLocalEdits();

    const shownAllowed = cleared.allowedText ?? savedSettings.claudeAllowedTools.join('\n');
    const shownVerification =
      cleared.verificationText ?? savedSettings.claudeVerificationTools.join('\n');

    expect(shownAllowed).toBe('Bash(npm run verify *)');
    expect(shownVerification).toBe('Bash(npm run verify *)');
  });

  it('does not carry a stale draft into the next save', () => {
    // With the draft cleared, a later edit starts from the stored settings, so
    // saving again cannot write back values from before the first save.
    const savedSettings: Settings = { ...defaults, ...custom, githubOwner: 'acme' };
    const cleared = clearLocalEdits();

    const draftForNextEdit = cleared.draft ?? savedSettings;
    const nextSave = { ...draftForNextEdit, maxReviewRounds: 7 };

    expect(nextSave.claudeAllowedTools).toEqual(['Bash(npm run verify *)']);
    expect(nextSave.githubOwner).toBe('acme');
    expect(nextSave.maxReviewRounds).toBe(7);
  });

  it('Reset and Save are not the same operation', () => {
    expect(resetPermissionRules().allowedText).not.toBeNull();
    expect(clearLocalEdits().allowedText).toBeNull();
  });
});
