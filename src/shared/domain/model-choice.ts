/**
 * The model picker's selection, as data.
 *
 * Kept out of the component for three reasons: these rules are the part that
 * used to go wrong, a plain module can be unit tested without rendering, and
 * they are the client side of the same three-state contract `tasks:create`
 * enforces — `undefined` inherits, `null` is an explicit Tool default, a string
 * is an exact model.
 *
 * A bare `string | null` cannot express "Custom is selected but the box is
 * empty" — that state has to look like Custom on screen while sending `null`
 * over IPC. Collapsing the two made the dropdown jump back to Tool default on
 * its own, and let a late-arriving catalogue overwrite a deliberate choice.
 */
export type ModelChoice =
  | { readonly kind: 'default' }
  | { readonly kind: 'preset'; readonly value: string }
  | { readonly kind: 'custom'; readonly draft: string };

/** The value to send over IPC: an exact string, or null for Tool default. */
export function choiceToModel(choice: ModelChoice): string | null {
  if (choice.kind === 'default') return null;
  if (choice.kind === 'preset') return choice.value;

  const trimmed = choice.draft.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * True while Custom is selected but nothing has been typed.
 *
 * Submitting here would send `null`, i.e. silently become Tool default, so the
 * form blocks instead.
 */
export function isChoiceIncomplete(choice: ModelChoice): boolean {
  return choice.kind === 'custom' && choice.draft.trim().length === 0;
}

/**
 * Derive the mode for a stored model.
 *
 * Applied only to a form the user has not touched, which is what lets a slug
 * that appears in the catalogue late be shown as a named preset instead of
 * staying stuck in Custom — while a choice the user has actually made is held
 * in state and never re-derived.
 */
export function choiceFromModel(
  model: string | null,
  presets: readonly { readonly value: string }[]
): ModelChoice {
  if (model === null) return { kind: 'default' };

  return presets.some((preset) => preset.value === model)
    ? { kind: 'preset', value: model }
    : { kind: 'custom', draft: model };
}
