import { describe, expect, it } from 'vitest';
import {
  buildSpecificationPrompt,
  buildSpecificationRevisionPrompt,
  buildTriagePrompt
} from '../../src/main/adapters/codex/prompts';
import { implementerCapabilitiesSection, specificationTargetSection } from '../../src/main/adapters/codex/implementer-contract';
import type { ImplementationProvider } from '../../src/shared/domain/execution-providers';
import { ORNITH_ACTION_KINDS } from '../../src/shared/domain/ornith';
import type { AcceptedPlanFinding } from '../../src/shared/domain/plan-correction';
import type { SpecificationGrounding } from '../../src/shared/domain/specification-grounding';
import { makeGrounding, makeSpecification } from '../helpers/fakes';

const TARGET = makeGrounding({ commit: 'b'.repeat(40) });

const accepted: AcceptedPlanFinding = {
  finding: 2,
  severity: 'major',
  category: 'reliability',
  file: 'docs/manual-test.md',
  line: 0,
  title: 'The section names no fixture policy',
  why: 'The implementer could reach the live database.',
  fix: 'Require synthetic fixtures in the constraints and in the instruction.',
  operatorNote: ''
};

const generation = (provider: ImplementationProvider = 'claude', target: SpecificationGrounding = TARGET): string =>
  buildSpecificationPrompt({
    projectPath: 'C:\\worktrees\\.agent-relay-specification\\t1',
    target,
    implementationProvider: provider,
    taskTitle: 'Add a section',
    originalRequest: 'Add it.'
  });

const revision = (provider: ImplementationProvider = 'claude', target: SpecificationGrounding = TARGET): string =>
  buildSpecificationRevisionPrompt({
    projectPath: 'C:\\worktrees\\t1-add-a-section',
    target,
    implementationProvider: provider,
    taskTitle: 'Add a section',
    originalRequest: 'Add it.',
    currentSpecification: makeSpecification(),
    acceptedFindings: [accepted],
    round: 1,
    maxRounds: 3
  });

/** The prompt is hard-wrapped; compare it as running text. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('the specification revision prompt: what "addressed" must contain', () => {
  it('asks for one entry per (accepted finding, changed field) pair, repeating a finding per field', () => {
    const prompt = flat(revision());

    expect(prompt).toContain('one entry for every (accepted finding, changed field) PAIR');
    expect(prompt).toContain('ONE specification field you changed for it');
    expect(prompt).toContain(
      'A finding that required changes to several fields gets one entry per field, repeating the same finding number'
    );
    expect(prompt).toContain('"constraints" and in "implementationPrompt" is two entries, both with its number');
    expect(prompt).toContain('A field changed for several findings gets one entry per finding');
    expect(prompt).toContain(
      'Every accepted finding appears in at least one entry, and every field whose value differs from the current specification appears in at least one entry'
    );
    expect(prompt).toContain('when a field changed without an entry tying it to an accepted finding');
  });

  it('no longer asks for one entry per finding, which cannot describe a finding fixed in two fields', () => {
    expect(flat(revision())).not.toMatch(/one entry for EACH accepted finding/i);
  });
});

describe('the target checkout: one named commit, and facts about it only as observed there', () => {
  it.each([
    ['generation', generation],
    ['revision', revision]
  ] as const)('the %s prompt names the commit it reads and says the project folder is not the target', (_name, build) => {
    const prompt = flat(build());

    expect(prompt).toContain(`You are reading a clean, detached checkout of base branch main at commit ${'b'.repeat(40)}`);
    expect(prompt).toContain("The project's own folder is NOT the target");
    // The rule evidence's clean flag describes where the rules were read, never this tree.
    expect(prompt).toContain('that describes neither this target nor the task\'s worktree');
    expect(prompt).toContain(`at ${'b'.repeat(12)}, docs/example.md is 1,234 bytes`);
    expect(prompt).toContain('Never state one you did not observe here');
    expect(prompt).toContain('tell the implementer to inspect the file when it starts');
  });

  it('forbids every transient fact when the checkout it reads has uncommitted changes', () => {
    const dirty = makeGrounding({ checkout: 'task_worktree', branch: 'agent-relay/t1', clean: false });
    const prompt = flat(revision('claude', dirty));

    expect(prompt).toContain('on branch agent-relay/t1');
    expect(prompt).toContain('WITH uncommitted changes from earlier implementation rounds');
    expect(prompt).toContain('This checkout has uncommitted changes, so state none of them.');
    expect(prompt).not.toContain('docs/example.md is 1,234 bytes');
  });

  it('tells a reviewer the same facts, addressed to the reviewer', () => {
    const section = flat(specificationTargetSection(TARGET, 'reviewer'));
    expect(section).toContain('The specification was written by reading a clean, detached checkout of base branch main');
    expect(section).toContain('The task branch under review starts from exactly this commit.');
    expect(section).not.toContain('You are reading');
  });
});

describe('the implementer contract: Ornith is asked only for what its protocol exposes', () => {
  it.each([
    ['generation', generation],
    ['revision', revision]
  ] as const)('the %s prompt lists exactly Ornith’s actions and forbids UI, IPC, run IDs, a shell and file handles', (_name, build) => {
    const prompt = flat(build('ornith'));

    expect(prompt).toContain(`It has exactly these actions and nothing else: ${ORNITH_ACTION_KINDS.join(', ')}.`);
    expect(prompt).toContain('It has no shell, terminal or command execution');
    expect(prompt).toContain('Never instruct it to run a command (npm, node, git, a script) itself.');
    expect(prompt).toContain('There are no file handles: never instruct it to open, seek, append through a handle, flush or close a file');
    expect(prompt).toContain('Never instruct it to press or invoke an Agent Relay action (for example "Run verification" / workflow:verify)');
    expect(prompt).toContain('to capture, poll or wait for an Agent Relay run ID, or to read an Agent Relay record');
    // Its own tool is not the operator's action, and Relay's check is a later stage of its own.
    expect(prompt).toContain('Its own "run_verification" action runs the project\'s verification inside its loop');
    expect(prompt).toContain('After it stops, Agent Relay verifies the result itself, as a separate stage the operator sees.');
    expect(prompt).toContain('so this implementer can carry it out with exactly these capabilities');
  });

  it('never tells the specifier to require that the implementer invoke the UI verification or read its record', () => {
    for (const prompt of [generation('ornith'), revision('ornith'), generation('claude'), revision('codex')]) {
      const text = flat(prompt);
      expect(text).not.toContain('require Agent Relay\'s own verification — its "Run verification" action');
      expect(text).toContain('Agent Relay verifies the finished change itself, as a separate stage after the implementer stops');
      expect(text).toContain(
        'The "implementationPrompt" must never ask the implementer to start, wait for, poll or read that stage or its record.'
      );
      expect(text).toContain('Acceptance criteria may require that Agent Relay\'s verification of the finished change passes.');
      expect(text).toContain("never stores a command's raw stdout/stderr or a complete log");
    }
  });

  it('describes Claude and Codex accurately, and the reviewer is told to treat an impossible instruction as a defect', () => {
    expect(flat(generation('claude'))).toContain('The implementer is Claude Code, working alone in the task worktree.');
    expect(flat(generation('codex'))).toContain('The implementer is Codex, working alone in the task worktree');
    expect(flat(generation('claude'))).not.toContain('It has exactly these actions and nothing else');
    expect(flat(implementerCapabilitiesSection('ornith', 'reviewer'))).toContain(
      'one this implementer cannot carry out is a defect of the plan'
    );
  });

  it('tells the revision that an accepted finding asking for raw output or the UI stage is met by an acceptance criterion', () => {
    expect(flat(revision('ornith'))).toContain(
      'a finding that asks for such output, or for the implementer to start or read Agent Relay\'s verification, is addressed by an acceptance criterion on that stage\'s persisted record instead'
    );
    expect(flat(generation())).not.toContain('accepted findings too');
  });
});

describe('triage sees the whole specification', () => {
  // The regression: a finding about a word that occurs ONLY in the implementation prompt was
  // rejected by citing a clean constraints field, because triage was never shown the prompt.
  const specification = makeSpecification({
    constraints: ['Do not change the existing sections.'],
    implementationPrompt: 'Добавь раздел и используй штатные средства проверки.',
    suggestedTests: ['A test for the new section.'],
    scopedFilePaths: ['docs/manual-test.md']
  });
  const prompt = buildTriagePrompt({
    refKind: 'index',
    specification,
    findings: [
      {
        ref: 0,
        severity: 'minor',
        category: 'clarity',
        file: 'docs/manual-test.md',
        line: null,
        title: 'The word "штатные" is ambiguous',
        body: 'The instruction says "штатные"; say which tools are meant.',
        fix: 'Name the tools.'
      }
    ],
    priorDecisions: []
  });

  it('renders the implementation prompt, suggested tests and scoped paths beside the other fields', () => {
    expect(prompt).toContain('Implementation prompt (handed verbatim to the implementer):');
    expect(prompt).toContain('используй штатные средства проверки');
    expect(prompt).toContain('A test for the new section.');
    expect(prompt).toContain('  - docs/manual-test.md');
  });

  it('requires every field to be checked before a rejection, and never one cited from another field', () => {
    const text = flat(prompt);
    expect(text).toContain('Judge each finding against the WHOLE specification above.');
    expect(text).toContain('a wording or content problem is often only in the implementation prompt');
    expect(text).toContain('check EVERY field above, and never reject a finding by citing a different field that does not contain what the finding is about');
    expect(text).toContain('name the field(s) you checked');
  });
});
