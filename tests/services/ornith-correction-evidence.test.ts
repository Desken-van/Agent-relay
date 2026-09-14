import { describe, expect, it } from 'vitest';
import { renderOrnithCorrectionFindings } from '../../src/main/services/orchestrator';
import type { CodexReviewResult } from '../../src/shared/schemas/codex';

describe('Ornith correction evidence rendering', () => {
  it('keeps only bounded redacted structured evidence and repository-relative locations', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const review: CodexReviewResult = {
      verdict: 'changes_requested',
      summary: `Inspect path=C:\\Users\\operator\\private\\build.log, source:/home/operator/summary.log, and ${secret}. ${'s'.repeat(10_000)}`,
      findings: [
        {
          severity: 'high',
          title: `Safe title ${secret}`,
          description: `Use [/home/operator/raw.log], {\\\\server\\share\\trace.log}, and ${'d'.repeat(20_000)}`,
          file: 'src/safe.ts',
          line: 12
        },
        {
          severity: 'medium',
          title: 'Unsafe location',
          description: 'The location is intentionally invalid.',
          file: 'C:\\Users\\operator\\outside.ts',
          line: 1
        }
      ],
      // This unstructured provider-authored text is intentionally excluded.
      followUpPrompt: `RAW_LOG_SENTINEL ${secret} C:\\private\\command.log`,
      suggestedTests: []
    };

    const rendered = renderOrnithCorrectionFindings(review);

    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(rendered).toContain('[src/safe.ts:12]');
    expect(rendered).toContain('[absolute-path-omitted]');
    expect(rendered).toContain('[redacted]');
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain('C:\\Users');
    expect(rendered).not.toContain('\\\\server');
    expect(rendered).not.toContain('/home/operator');
    expect(rendered).not.toContain('RAW_LOG_SENTINEL');
    expect(rendered).not.toContain('[C:');
  });
});
