/**
 * Tool diagnostics.
 *
 * Every probe is wrapped so that a throwing adapter degrades into an `error`
 * status rather than taking the window down with it. That is the whole point:
 * Agent Relay must remain usable — and explain itself — on a machine where none
 * of the four external tools are installed.
 */

import type { DiagnosticsReport, ToolDiagnostic, ToolId } from '../../shared/domain/diagnostics';
import type { LocalInferenceState } from '../../shared/domain/local-inference';
import { redactSecrets } from '../../shared/util/redact';
import type {
  ClaudeAdapter,
  CodexAdapter,
  DiagnosticsService,
  EventPublisher,
  GitAdapter,
  GitHubAdapter,
  LocalInferenceLifecycleService
} from '../ports';

export interface DiagnosticsDeps {
  readonly codex: CodexAdapter;
  readonly claude: ClaudeAdapter;
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  /** Read passively (`.state()` only) to build the Ornith diagnostic. */
  readonly localInference: LocalInferenceLifecycleService;
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
    const ornith = ornithDiagnostic(this.deps.localInference.state());

    return { codex, claude, git, github, ornith, checkedAt: new Date().toISOString() };
  }
}

/**
 * Build the Ornith diagnostic from the local-inference lifecycle's own
 * already-retained state, and nothing else.
 *
 * Deliberately synchronous and side-effect-free: this must never call
 * `capabilities`, `health`, `start` or `infer`. A diagnostic that triggered
 * one of those every time Settings opened would defeat the "start and stop
 * stay manual" guarantee the rest of Ornith depends on.
 */
export function ornithDiagnostic(state: LocalInferenceState): ToolDiagnostic {
  const checkedAt = new Date().toISOString();
  const base = {
    tool: 'ornith' as const,
    executablePath: null,
    version: null,
    checkedAt
  };

  switch (state.kind) {
    case 'unavailable':
      return {
        ...base,
        status: 'missing',
        detail: `Local inference is not available: ${state.reason}`,
        remediation: 'Enable and configure Local inference in Settings, then Start it.'
      };
    case 'stopped':
      return {
        ...base,
        status: 'unauthenticated',
        detail: 'The local runtime is stopped.',
        remediation: 'Start the local runtime in Settings → Local inference, then confirm it is Healthy.'
      };
    case 'starting':
      return {
        ...base,
        status: 'unauthenticated',
        detail: `The local runtime is starting (${state.runtimeInstanceId}).`,
        remediation: 'Wait for it to become Healthy before running Ornith.'
      };
    case 'healthy':
      return {
        ...base,
        status: 'ok',
        detail: `The local runtime is Healthy (${state.runtimeInstanceId}). Ornith implementation is usable.`,
        remediation: null
      };
    case 'inferring':
      return {
        ...base,
        status: 'ok',
        detail: `The local runtime is busy running an inference (${state.runtimeInstanceId}).`,
        remediation: null
      };
    case 'stopping':
      return {
        ...base,
        status: 'unauthenticated',
        detail: 'The local runtime is stopping.',
        remediation: 'Wait for it to stop, then Start it again before running Ornith.'
      };
    case 'failed':
      return {
        ...base,
        status: 'error',
        detail: `The local runtime failed: ${state.reason}`,
        remediation: 'Stop the runtime to clear the failure, then Start it again.'
      };
    case 'cancelled':
      return {
        ...base,
        status: 'error',
        detail: `The local runtime was cancelled: ${state.reason}`,
        remediation: 'Stop the runtime to clear the failure, then Start it again.'
      };
    case 'timed_out':
      return {
        ...base,
        status: 'error',
        detail: `The local runtime timed out: ${state.reason}`,
        remediation: 'Stop the runtime to clear the failure, then Start it again.'
      };
    default:
      return {
        ...base,
        status: 'unknown',
        detail: 'The local runtime state is not yet known.',
        remediation: null
      };
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
