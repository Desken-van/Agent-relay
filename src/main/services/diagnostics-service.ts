/**
 * Tool diagnostics.
 *
 * Every probe is wrapped so that a throwing adapter degrades into an `error`
 * status rather than taking the window down with it. That is the whole point:
 * Agent Relay must remain usable — and explain itself — on a machine where none
 * of the four external tools are installed.
 */

import type { DiagnosticsReport, ToolDiagnostic, ToolId } from '../../shared/domain/diagnostics';
import { redactSecrets } from '../../shared/util/redact';
import type {
  ClaudeAdapter,
  CodexAdapter,
  DiagnosticsService,
  EventPublisher,
  GitAdapter,
  GitHubAdapter
} from '../ports';

export interface DiagnosticsDeps {
  readonly codex: CodexAdapter;
  readonly claude: ClaudeAdapter;
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  readonly events: EventPublisher;
}

/** Diagnostics shell out to four processes; don't redo that on every render. */
const CACHE_TTL_MS = 30_000;

export class ToolDiagnosticsService implements DiagnosticsService {
  private lastReport: DiagnosticsReport | null = null;
  private lastRunAt = 0;
  private inFlight: Promise<DiagnosticsReport> | null = null;

  constructor(private readonly deps: DiagnosticsDeps) {}

  cached(): DiagnosticsReport | null {
    return this.lastReport;
  }

  async run(force = false): Promise<DiagnosticsReport> {
    const fresh = Date.now() - this.lastRunAt < CACHE_TTL_MS;
    if (!force && this.lastReport && fresh) {
      return this.lastReport;
    }
    // Coalesce concurrent callers (the UI asks on mount from several places).
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.probeAll();
    try {
      const report = await this.inFlight;
      this.lastReport = report;
      this.lastRunAt = Date.now();
      this.deps.events.publishDiagnostics(report);
      return report;
    } finally {
      this.inFlight = null;
    }
  }

  private async probeAll(): Promise<DiagnosticsReport> {
    const [codex, claude, git, github] = await Promise.all([
      safeProbe('codex', () => this.deps.codex.diagnose()),
      safeProbe('claude', () => this.deps.claude.diagnose()),
      safeProbe('git', () => this.deps.git.diagnose()),
      safeProbe('github', () => this.deps.github.diagnose())
    ]);

    return { codex, claude, git, github, checkedAt: new Date().toISOString() };
  }
}

async function safeProbe(
  tool: ToolId,
  probe: () => Promise<ToolDiagnostic>
): Promise<ToolDiagnostic> {
  try {
    return await probe();
  } catch (error) {
    return {
      tool,
      status: 'error',
      executablePath: null,
      version: null,
      detail: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 400),
      remediation: 'Agent Relay could not probe this tool. Check that it is installed and on PATH.',
      checkedAt: new Date().toISOString()
    };
  }
}
