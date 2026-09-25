import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/ipc';
import {
  IPC_NAMESPACES,
  RELAY_ACTION_LABELS,
  ornithInstructionProblem,
  ornithInstructionViolations,
  type OrnithInstructionCategory
} from '../../src/shared/domain/ornith-instruction-contract';

const prompt = (implementationPrompt: string) =>
  ornithInstructionViolations({ implementationPrompt, acceptanceCriteria: [], suggestedTests: [] });
const criterion = (text: string) =>
  ornithInstructionViolations({ implementationPrompt: 'Edit docs/manual-test.md.', acceptanceCriteria: [text], suggestedTests: [] });
const test = (text: string) =>
  ornithInstructionViolations({ implementationPrompt: 'Edit docs/manual-test.md.', acceptanceCriteria: [], suggestedTests: [text] });

describe('the Ornith instruction contract refuses', () => {
  it('the instruction that reached Ornith: invoke the UI "Run verification" action and read its persisted result', () => {
    const violations = prompt(
      'Append the section to docs/manual-test.md. After the edit, invoke Agent Relay\'s UI "Run verification" action (distinct from your run_verification tool) and read the UI action\'s persisted result.'
    );
    expect(violations.map((violation) => violation.category)).toEqual(['relay_ui']);
    expect(violations[0]).toMatchObject({ field: 'implementationPrompt', index: null });
    expect(violations[0]!.excerpt).toContain('invoke Agent Relay');
  });

  it.each<[string, OrnithInstructionCategory]>([
    // Agent Relay's UI and IPC.
    ['Press "Run verification" when the edit is done.', 'relay_ui'],
    ['Click the Run verification button.', 'relay_ui'],
    ['Invoke workflow:verify to check the change.', 'relay_ui'],
    ['Call window.agentRelay.invoke with the task id.', 'relay_ui'],
    ['Open the Run screen and confirm the status.', 'relay_ui'],
    ['Use the Run verification action once more.', 'relay_ui'],
    ['Select "Approve specification" afterwards.', 'relay_ui'],
    ['You must trigger the UI action for verification.', 'relay_ui'],
    // Run IDs and records.
    ['Capture the run ID.', 'relay_record'],
    ['Then note the run ID shown in the timeline.', 'relay_record'],
    ['Read the persisted result of the verification.', 'relay_record'],
    ['Report the run ID of Agent Relay\'s verification in the handoff.', 'relay_record'],
    ['Ornith reads Agent Relay\'s run records to find the outcome.', 'relay_record'],
    // Agent Relay's own verification stage.
    ['Wait for Agent Relay\'s verification to pass.', 'relay_stage'],
    ['Run Agent Relay\'s verification before finishing.', 'relay_stage'],
    ['Poll the separate verification stage until it completes.', 'relay_stage'],
    // Commands.
    ['Run `npm run verify` and confirm it passes.', 'command'],
    ['Run the tests.', 'command'],
    ['Execute scripts/make-probe.mjs.', 'command'],
    ['Update the heading and then run npx vitest run tests/domain/x.test.ts.', 'command'],
    ['Confirm the change by running `npm test`.', 'command'],
    ['You should run the linter before finishing.', 'command'],
    ['Verify with `npx tsc --noEmit`.', 'command'],
    ['Open a terminal in the worktree.', 'command'],
    ['Start the app and look at the new page.', 'command'],
    ['Build the project.', 'command'],
    ['After editing, git add docs/manual-test.md.', 'command'],
    // Git.
    ['Commit the change with a short message.', 'git'],
    ['Stage the edited file.', 'git'],
    ['Create a new branch for the fix.', 'git'],
    ['Push the changes to origin.', 'git'],
    ['Check out the main branch first.', 'git'],
    ['Reset HEAD to the base commit.', 'git'],
    // File operations outside the protocol.
    ['Open a file handle, seek to the end and append the section.', 'file_operation'],
    ['Seek to the end of docs/manual-test.md.', 'file_operation'],
    ['Write raw bytes for the BOM.', 'file_operation'],
    ['Make scripts/check.sh executable.', 'file_operation'],
    ['Create a symlink from docs/latest.md to docs/manual-test.md.', 'file_operation'],
    // Network.
    ['Install the lodash package.', 'network'],
    ['Download the fixture from the release page.', 'network']
  ])('%s', (text, category) => {
    const violations = prompt(text);
    expect(violations.map((violation) => violation.category)).toEqual([category]);
  });

  it('a command on its own, in a suggested test or a prompt line', () => {
    expect(test('npx vitest run tests/domain/ornith.test.ts').map((v) => v.category)).toEqual(['command']);
    expect(test('`npm run verify`').map((v) => v.category)).toEqual(['command']);
    expect(prompt('Steps:\n1. Edit docs/manual-test.md.\n2. `npm run verify` to be sure.').map((v) => v.category)).toEqual(['command']);
    expect(prompt('$ npm test').map((v) => v.category)).toEqual(['command']);
  });

  it('an acceptance criterion that needs an Agent Relay run ID, which only Agent Relay knows', () => {
    expect(criterion('The handoff names the run ID of Agent Relay\'s verification.').map((v) => v.category)).toEqual(['relay_record']);
    expect(criterion('docs/manual-test.md cites Agent Relay\'s run ID for the check.').map((v) => v.category)).toEqual(['relay_record']);
  });

  it('operator steps written as instructions instead of file content', () => {
    const violations = prompt('Append these steps to docs/manual-test.md:\n1. Press Run verification.\n2. Note the run ID.');
    expect(violations.map((violation) => violation.category)).toEqual(['relay_ui', 'relay_record']);
  });

  it('a fenced block that no line ties to a file, and one that is never closed', () => {
    expect(prompt('Run:\n```\nnpm test\n```').map((v) => v.category)).toEqual(['content_block']);
    const unclosed = prompt('Append to docs/manual-test.md:\n```\ntext\nThen commit the change.');
    expect(unclosed.map((violation) => violation.category)).toEqual(['content_block', 'git']);
  });

  it('instructions it cannot read: another script outside quotes is refused, not passed unread', () => {
    // The English grammar would find nothing here; the contract says so instead of approving it.
    expect(prompt('Нажми «Run verification» и запиши run ID.').map((v) => v.category)).toEqual(['language']);
    expect(prompt('Добавь раздел в docs/manual-test.md.\nЗапусти npm run verify.').map((v) => v.category)).toEqual(['language']);
    expect(criterion('Проверка Agent Relay проходит.').map((v) => v.category)).toEqual(['language']);
  });

  it('every violation, in field order, with the entry it came from', () => {
    const violations = ornithInstructionViolations({
      implementationPrompt: 'Capture the run ID.',
      acceptanceCriteria: ['The section exists.', 'The handoff names the run ID of Agent Relay\'s verification.'],
      suggestedTests: ['Run `npx vitest run tests/x.test.ts`.']
    });
    expect(violations.map(({ field, index, category }) => ({ field, index, category }))).toEqual([
      { field: 'implementationPrompt', index: null, category: 'relay_record' },
      { field: 'acceptanceCriteria', index: 1, category: 'relay_record' },
      { field: 'suggestedTests', index: 0, category: 'command' }
    ]);
  });
});

describe('the Ornith instruction contract allows', () => {
  it.each([
    // What Ornith can do, by its actions or in plain words for them.
    'Read docs/manual-test.md, then append the section after the last heading.',
    'Use run_verification once the edit is complete.',
    'Run the verification with run_verification before you finish.',
    'Check git status and git diff before finishing.',
    'Call git_diff to review the change.',
    'Replace the old paragraph with the new one using replace_text.',
    'Delete the obsolete file docs/old.md.',
    'Search for "Run verification" in src/renderer to find the label.',
    // A change whose subject is Agent Relay itself: editing its code, not operating it.
    'Update the workflow:verify handler in src/main/ipc/register-ipc.ts to log the task id.',
    'Add a column that shows the run ID in the timeline.',
    'Rename the Run verification button label to "Verify now".',
    'Store the run ID on the new row.',
    'Merge the two helper functions into one.',
    'Push the new item onto the queue array.',
    'Create a helper that builds the branch name.',
    'Install the event listener in the constructor.',
    'Add a permissions check to the settings form.',
    // Content for the operator: reported, or given as a file-content block.
    'Append a step to docs/manual-test.md telling the operator to press "Run verification" and note the run ID.',
    'The new section tells the operator to run `npm run dev` and open the Run screen.',
    'Append to docs/manual-test.md:\n\n```markdown\n## Ornith UI smoke test\n1. Press **Run verification**.\n2. Note the run ID shown in the timeline.\n3. Run `git status`.\n```',
    'When the user clicks the button, the handler invokes workflow:verify.',
    // Prohibitions and commentary.
    'Do not run `npm install`; Agent Relay prepares dependencies.',
    'Never commit or push.',
    'You must not invoke Agent Relay\'s UI actions.',
    'Note that Agent Relay\'s verification runs after you stop.',
    'Agent Relay verifies the finished change itself afterwards with `npm run verify`.',
    // Another language as quoted words or file content.
    'Replace the word «штатные» with "standard" in docs/manual-test.md.',
    'Append to docs/manual-test.md:\n```markdown\n## Проверка Ornith\n1. Нажмите «Run verification».\n```'
  ])('%s', (text) => {
    expect(prompt(text)).toEqual([]);
  });

  it.each([
    "Agent Relay's verification of the finished change passes.",
    '`npm run verify` passes.',
    'npm run verify exits with code 0.',
    'docs/manual-test.md contains a step telling the operator to note the run ID.',
    'The timeline row shows the run ID.',
    'The Run verification action of the finished change succeeds for the operator.',
    // Outcomes Agent Relay records: Ornith need not see the record for them to hold.
    "Agent Relay's persisted verification record shows a passed outcome.",
    "Agent Relay's timeline records a passed verification run."
  ])('the criterion %s', (text) => {
    expect(criterion(text)).toEqual([]);
  });

  it.each([
    'tests/domain/ornith.test.ts: asserts the new action kind is accepted.',
    'Add a test in tests/services/foo.test.ts that covers the empty case.',
    '`npm run verify` still passes.'
  ])('the suggested test %s', (text) => {
    expect(test(text)).toEqual([]);
  });
});

describe('a stored specification', () => {
  const json = (implementationPrompt: string) =>
    JSON.stringify({ implementationPrompt, acceptanceCriteria: ['Done.'], suggestedTests: [] });

  it('has a problem only when its implementer is Ornith and it breaks the contract', () => {
    const bad = json('Press "Run verification" and capture the run ID.');
    expect(ornithInstructionProblem({ specificationJson: bad, implementationProvider: 'ornith' })).toMatch(
      /^The specification tells Ornith to do something its protocol cannot\. Implementation prompt: "Press "Run verification" and capture the run ID\." — Ornith cannot press/
    );
    expect(ornithInstructionProblem({ specificationJson: bad, implementationProvider: 'claude' })).toBeNull();
    expect(ornithInstructionProblem({ specificationJson: json('Edit docs/a.md.'), implementationProvider: 'ornith' })).toBeNull();
    expect(ornithInstructionProblem({ specificationJson: null, implementationProvider: 'ornith' })).toBeNull();
    // Unreadable is another check's to refuse.
    expect(ornithInstructionProblem({ specificationJson: 'not json', implementationProvider: 'ornith' })).toBeNull();
  });

  it('names at most three violations and counts the rest', () => {
    const many = json(['Capture the run ID.', 'Commit it.', 'Run the tests.', 'Press "Run verification".', 'Stage it.'].join('\n'));
    expect(ornithInstructionProblem({ specificationJson: many, implementationProvider: 'ornith' })).toMatch(/\(and 2 more\)$/);
  });
});

describe('the contract stays in step with what Agent Relay exposes', () => {
  it('knows every IPC namespace', () => {
    const namespaces = new Set(IPC_CHANNELS.map((channel) => channel.split(':')[0]));
    expect([...namespaces].filter((namespace) => !(IPC_NAMESPACES as readonly string[]).includes(namespace!))).toEqual([]);
  });

  it('knows every Run-screen action label', () => {
    const source = readFileSync('src/shared/domain/run-guidance.ts', 'utf8');
    const labels = [...source.matchAll(/action\('[a-z_]+', '([^']+)'\)/g)].map((match) => match[1]!);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter((label) => !(RELAY_ACTION_LABELS as readonly string[]).includes(label))).toEqual([]);
  });
});
