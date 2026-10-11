import { describe, expect, it } from 'vitest';
import {
  choiceFromModel,
  choiceToModel,
  isChoiceIncomplete,
  type ModelChoice
} from '../../src/shared/domain/model-choice';

describe('whitespace handling in custom drafts', () => {
  it('treats a draft of only tab, newline, and non-breaking space as empty', () => {
    const draft = '\t\n\u00a0';
    const choice: ModelChoice = { kind: 'custom', draft };
    expect(choiceToModel(choice)).toBeNull();
    expect(isChoiceIncomplete(choice)).toBe(true);
  });
});

describe('frozen-input preservation', () => {
  it('preserves kind and draft after choiceToModel and isChoiceIncomplete', () => {
    const originalDraft = '\t\u00a0claude-opus-5\u00a0\t';
    const choice = Object.freeze({ kind: 'custom', draft: originalDraft });
    expect(choiceToModel(choice)).toBe('claude-opus-5');
    expect(isChoiceIncomplete(choice)).toBe(false);
    expect(choice.kind).toBe('custom');
    expect(choice.draft).toBe(originalDraft);
  });
});

describe('case-sensitive catalogue matching', () => {
  it('derives a custom choice for a differently-cased model and round-trips its spelling', () => {
    const presets = [{ value: 'gpt-5.6-sol' }];
    const model = 'GPT-5.6-SOL';
    const derived = choiceFromModel(model, presets);
    expect(derived).toEqual({ kind: 'custom', draft: 'GPT-5.6-SOL' });
    expect(choiceToModel(derived)).toBe('GPT-5.6-SOL');
  });
});
