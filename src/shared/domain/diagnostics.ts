/**
 * Tool availability reporting.
 *
 * Agent Relay depends on four external programs it does not own. When one is
 * missing or logged out the application must stay usable and say precisely what
 * to do — never throw an unhandled error at startup.
 */

export const TOOL_IDS = ['codex', 'claude', 'git', 'github'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export type ToolStatus =
  /** Installed, reachable and authenticated (where authentication applies). */
  | 'ok'
  /** Installed but not logged in. */
  | 'unauthenticated'
  /** Executable could not be found. */
  | 'missing'
  /** Found, but probing it failed. */
  | 'error'
  /** Not probed yet. */
  | 'unknown';

export interface ToolDiagnostic {
  readonly tool: ToolId;
  readonly status: ToolStatus;
  /** Resolved absolute path, or null when the tool was not found. */
  readonly executablePath: string | null;
  readonly version: string | null;
  /** Short human-readable summary. Always redacted. */
  readonly detail: string;
  /** What the user should do next; null when nothing is wrong. */
  readonly remediation: string | null;
  /** GitHub only: accounts `gh` knows about. Never includes tokens. */
  readonly accounts?: readonly string[];
  /** GitHub only: the currently active account login. */
  readonly activeAccount?: string | null;
  readonly checkedAt: string;
}

export interface DiagnosticsReport {
  readonly codex: ToolDiagnostic;
  readonly claude: ToolDiagnostic;
  readonly git: ToolDiagnostic;
  readonly github: ToolDiagnostic;
  readonly checkedAt: string;
}

export function unknownDiagnostic(tool: ToolId): ToolDiagnostic {
  return {
    tool,
    status: 'unknown',
    executablePath: null,
    version: null,
    detail: 'Not checked yet.',
    remediation: null,
    checkedAt: new Date().toISOString()
  };
}
