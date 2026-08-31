import { describe, expect, it } from 'vitest';
import {
  choiceFromModel,
  choiceToModel,
  isChoiceIncomplete,
  type ModelChoice
} from '../../src/shared/domain/model-choice';

/**
 * The picker's mode is data, not a local boolean, precisely so these rules can
 * be checked without rendering anything. Each case below is a way the old
 * value-only version drifted out of step with what was on screen.
 */

const presets = [{ value: 'gpt-5.6-sol' }, { value: 'gpt-5.6-terra' }];

describe('model choice → IPC value', () => {
  it('sends null for Tool default', () => {
    expect(choiceToModel({ kind: 'default' })).toBeNull();
  });

  it('sends the exact slug for a preset', () => {
    expect(choiceToModel({ kind: 'preset', value: 'gpt-5.6-sol' })).toBe('gpt-5.6-sol');
  });

  it('sends a trimmed custom id', () => {
    expect(choiceToModel({ kind: 'custom', draft: '  claude-opus-5  ' })).toBe('claude-opus-5');
  });

  it('sends null for an empty custom box', () => {
    expect(choiceToModel({ kind: 'custom', draft: '' })).toBeNull();
    expect(choiceToModel({ kind: 'custom', draft: '   ' })).toBeNull();
  });
});

describe('incomplete custom entry', () => {
  it('is flagged while the box is empty', () => {
    expect(isChoiceIncomplete({ kind: 'custom', draft: '' })).toBe(true);
    expect(isChoiceIncomplete({ kind: 'custom', draft: '  ' })).toBe(true);
  });

  it('is not flagged once something is typed', () => {
    expect(isChoiceIncomplete({ kind: 'custom', draft: 'gpt-5.5' })).toBe(false);
  });

  it('never flags the other two modes', () => {
    expect(isChoiceIncomplete({ kind: 'default' })).toBe(false);
    expect(isChoiceIncomplete({ kind: 'preset', value: 'gpt-5.5' })).toBe(false);
  });

  it('stays visibly Custom rather than collapsing into Tool default', () => {
    // Both produce a null IPC value, but only one of them is Tool default —
    // the mode is what keeps the dropdown from silently jumping back.
    const empty: ModelChoice = { kind: 'custom', draft: '' };
    expect(choiceToModel(empty)).toBeNull();
    expect(empty.kind).toBe('custom');
    expect(isChoiceIncomplete(empty)).toBe(true);
  });
});

describe('deriving the mode from a stored model', () => {
  it('maps null to Tool default', () => {
    expect(choiceFromModel(null, presets)).toEqual({ kind: 'default' });
  });

  it('maps a known slug to a preset', () => {
    expect(choiceFromModel('gpt-5.6-sol', presets)).toEqual({
      kind: 'preset',
      value: 'gpt-5.6-sol'
    });
  });

  it('maps an unknown slug to custom, carrying the value into the box', () => {
    expect(choiceFromModel('some-future-model', presets)).toEqual({
      kind: 'custom',
      draft: 'some-future-model'
    });
  });

  it('promotes a slug from custom to preset once the catalogue arrives', () => {
    // Before the catalogue loads there are no presets, so the Settings default
    // can only be shown as a typed id; afterwards it must display as the named
    // model instead of looking hand-entered.
    expect(choiceFromModel('gpt-5.6-sol', [])).toEqual({
      kind: 'custom',
      draft: 'gpt-5.6-sol'
    });
    expect(choiceFromModel('gpt-5.6-sol', presets)).toEqual({
      kind: 'preset',
      value: 'gpt-5.6-sol'
    });
  });

  it('round-trips every mode back to the same IPC value', () => {
    for (const model of [null, 'gpt-5.6-sol', 'unknown-model']) {
      expect(choiceToModel(choiceFromModel(model, presets))).toBe(model);
    }
  });
});
