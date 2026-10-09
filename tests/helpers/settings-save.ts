/**
 * Save the Settings form through its own button, then confirm what was stored.
 *
 * The e2e suites used to wait for the "Settings saved" toast. That toast is transient and, until it was moved, came
 * only after the forced tool diagnostics that follow a save (codex, claude, git and gh, each with a timeout of up to
 * 30 s): on Windows CI's first, cold Electron launch it once arrived after the suite's 15 s wait although the
 * profile had been stored within milliseconds. What a suite needs to know is that the write happened and holds the
 * fields it relies on, so that is what this checks — by reading the settings back over the read-only `settings:get`
 * channel. The save itself is still the operator's click, done once; nothing is written any other way and nothing
 * is retried.
 *
 * A refused save shows an error toast ("Could not save settings"); that ends the wait at once. Any failure throws
 * with what the screen and the stored settings said at that moment: the Save button, the toasts, the visible error
 * and warning notices, and the stored local-inference profile with what still differs. Settings hold paths and
 * numbers only; no credential is ever part of them.
 */

import type { Page } from 'playwright-core';
import type { Settings } from '../../src/shared/domain/models';

export type SettingsCheck = (settings: Settings) => readonly string[];

interface ScreenEvidence {
  readonly saveButton: { readonly text: string | null; readonly disabled: boolean | null; readonly title: string | null };
  readonly toasts: readonly string[];
  readonly notices: readonly string[];
}

async function readSettings(page: Page): Promise<{ ok: true; data: Settings } | { ok: false; error: unknown }> {
  return page.evaluate(async () => (globalThis as any).agentRelay.invoke('settings:get', {}));
}

async function screenEvidence(page: Page): Promise<ScreenEvidence> {
  return page.evaluate(() => {
    const document = (globalThis as any).document;
    const text = (node: { textContent: string | null }): string => (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const button = Array.from(document.querySelectorAll('button') as ArrayLike<any>).find((b: any) => text(b) === 'Save settings') as any;
    return {
      saveButton: { text: button ? text(button) : null, disabled: button ? Boolean(button.disabled) : null, title: button?.getAttribute('title') ?? null },
      toasts: Array.from(document.querySelectorAll('.toast') as ArrayLike<any>).map((t: any) => `${t.className}: ${text(t)}`),
      notices: Array.from(document.querySelectorAll('.notice--error, .notice--warn, .notice--warning') as ArrayLike<any>).map(text).slice(0, 10)
    };
  });
}

/** The stored local-inference settings, reduced to what the suites set; the default profile in full. */
function storedSummary(settings: Settings | null): unknown {
  if (settings === null) return null;
  const { enabled, defaultProfileId, profiles } = settings.localInference;
  return { enabled, defaultProfileId, profiles };
}

export async function saveSettingsThroughUi(page: Page, check: SettingsCheck, timeoutMs = 15_000): Promise<Settings> {
  const started = Date.now();
  await page.getByRole('button', { name: 'Save settings' }).click();
  let stored: Settings | null = null;
  let differences: readonly string[] = ['settings:get has not answered yet'];
  for (;;) {
    const read = await readSettings(page);
    if (read.ok) {
      stored = read.data;
      differences = check(read.data);
      if (differences.length === 0) return read.data;
    } else {
      differences = [`settings:get failed: ${JSON.stringify(read.error).slice(0, 300)}`];
    }
    const screen = await screenEvidence(page);
    const refused = screen.toasts.some((toast) => toast.includes('toast--error'));
    if (refused || Date.now() - started >= timeoutMs) {
      const evidence = { elapsedMs: Date.now() - started, refused, differences, screen, stored: storedSummary(stored) };
      console.log(`Settings save evidence: ${JSON.stringify(evidence, null, 2)}`);
      throw new Error(
        refused
          ? `Saving Settings was refused: ${JSON.stringify(screen.toasts)}`
          : `The saved Settings did not reach the expected state within ${timeoutMs} ms: ${differences.join('; ')}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The mismatches between the stored default profile and the fields a suite filled in. */
export function defaultProfileDiffers(
  expected: {
    readonly adapterKind: 'llama_cpp' | 'strata';
    readonly modelId: string;
    readonly port: number;
    readonly contextLimitTokens?: number;
    readonly maxOutputTokens: number;
    readonly inferenceTimeoutMs?: number;
    readonly profileEnabled?: boolean;
  }
): SettingsCheck {
  return (settings) => {
    const differences: string[] = [];
    const profile = settings.localInference.profiles.find((candidate) => candidate.id === 'default');
    if (!settings.localInference.enabled) differences.push('local inference is not enabled');
    if (profile === undefined) return [...differences, 'there is no default profile'];
    const compare = (name: string, actual: unknown, wanted: unknown): void => {
      if (wanted !== undefined && actual !== wanted) differences.push(`${name} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
    };
    compare('adapterKind', profile.adapterKind, expected.adapterKind);
    compare('model.id', profile.model.id, expected.modelId);
    compare('port', profile.port, expected.port);
    compare('contextLimitTokens', profile.contextLimitTokens, expected.contextLimitTokens);
    compare('requestDefaults.maxOutputTokens', profile.requestDefaults.maxOutputTokens, expected.maxOutputTokens);
    compare('inferenceTimeoutMs', profile.inferenceTimeoutMs, expected.inferenceTimeoutMs);
    compare('enabled', profile.enabled, expected.profileEnabled);
    return differences;
  };
}
