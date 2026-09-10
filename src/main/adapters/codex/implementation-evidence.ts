import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { ClaudeRoundAssessmentRecord } from '../../../shared/domain/claude-assessment';
import { analyseCommand, commandTouchesDestructiveOperation, parseShellToolRule, ruleMatchesCommand } from '../../../shared/domain/claude-tool-rules';

/** SDK reports the shell launcher, not just its script. Only unwrap one quoted,
 * literal script with no expansion, nested quoting or additional arguments. */
export function sdkCommandScript(command: string): string {
  const shell = '(?:"[^"\\r\\n]+(?:powershell|pwsh)\\.exe"|(?:powershell|pwsh)(?:\\.exe)?)';
  const windows = new RegExp(`^${shell} (?:-NoProfile )?-Command (["'])([^"'\\r\\n\\x60$]+)\\1$`, 'i').exec(command);
  const posix = /^(?:\/bin\/)?(?:bash|sh|zsh) -[l]?c (["'])([^"'\r\n`$]+)\1$/.exec(command);
  return windows?.[2] ?? posix?.[2] ?? command;
}

/** Observe the SDK's command results and ordering, without trusting the final answer. */
export class CodexImplementationEvidence {
  private sequence = 0;
  private lastWrite = 0;
  private ended = false;
  private broken = false;
  private security = false;
  private readonly items = new Map<string, { item: ThreadItem; started: number; completed: boolean }>();
  constructor(private readonly commands: readonly string[]) {}

  accept(event: ThreadEvent): void {
    this.sequence++;
    if (event.type === 'turn.completed') this.ended = true;
    if (event.type === 'turn.failed' || event.type === 'error') this.broken = true;
    if (!('item' in event)) return;
    const item = event.item;
    if (item.type === 'file_change') this.lastWrite = this.sequence;
    if (item.type === 'error' || item.type === 'mcp_tool_call') this.broken = true;
    if (item.type !== 'command_execution') return;
    const previous = this.items.get(item.id);
    if (previous?.completed && (previous.item.type !== 'command_execution' ||
      previous.item.command !== item.command || previous.item.exit_code !== item.exit_code || previous.item.status !== item.status)) this.broken = true;
    this.items.set(item.id, { item, started: previous?.started ?? this.sequence, completed: event.type === 'item.completed' });
    if (commandTouchesDestructiveOperation(analyseCommand(sdkCommandScript(item.command)))) this.security = true;
  }

  assessment(): ClaudeRoundAssessmentRecord {
    const rules = this.commands.map(parseShellToolRule).filter((r) => r !== null);
    let verification: ClaudeRoundAssessmentRecord['verification'] = null;
    let status: ClaudeRoundAssessmentRecord['verificationStatus'] = 'not_run';
    let latest = -1;
    for (const { item, started, completed } of this.items.values()) {
      if (item.type !== 'command_execution') continue;
      if (!completed || item.status === 'in_progress' || item.exit_code === undefined) this.broken = true;
      const analysis = analyseCommand(sdkCommandScript(item.command));
      const rule = rules.find((r) => ruleMatchesCommand(r, r.tool, analysis));
      // A compound/wrapped command cannot demonstrate a check. It could edit after a check.
      if (!rule || analysis.compound) {
        if (started > this.lastWrite) this.lastWrite = started;
        continue;
      }
      if (started < latest) continue;
      latest = started;
      status = completed && item.status === 'completed' && item.exit_code === 0 ? 'passed' : 'failed';
      verification = { tool: 'Codex', command: rule.prefix.slice(0, 500), matchedRule: rule.canonical.slice(0, 500), toolUseSequence: started };
    }
    if (latest < this.lastWrite && status === 'passed') status = 'unknown';
    const telemetry = !this.ended || this.broken;
    const publishBlock = this.security ? 'security' : telemetry ? 'telemetry' : rules.length === 0 ? 'configuration' : status === 'passed' ? 'none' : 'verification';
    return { version: 1, disposition: publishBlock === 'none' ? 'pass' : 'fail', verificationStatus: status,
      publishBlock, reasonCodes: publishBlock === 'none' ? [] : [`CODEX_${publishBlock.toUpperCase()}`], verification, denials: [] };
  }
}
