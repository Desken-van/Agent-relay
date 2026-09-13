import { useMemo } from 'react';
import type { GitChangeSet } from '@shared/domain/git';
import { Empty } from './primitives';

/**
 * Changed files, diff and recent commits as one stack of labelled
 * subsections. The caller wraps this in a single flush, collapsible Card
 * ("Changes and diff") and owns the Refresh action in that Card's header —
 * this component only ever renders content, never its own chrome, so a task
 * with nothing to show collapses to one "No changes collected yet" line
 * instead of three empty bordered boxes. Each subsection carries its own
 * horizontal inset (matching `.filerow`'s) since the Card itself is flush.
 */
export function ChangesPanel({ changes }: { changes: GitChangeSet | null }): React.JSX.Element {
  return (
    <div className="stack">
      <div>
        <div className="section-title" style={{ padding: '12px 14px 0' }}>
          {changes ? `Changed files (${changes.changedFiles.length})` : 'Changed files'}
        </div>
        {!changes ? (
          <Empty title="No changes collected yet" hint="Refresh once Claude has finished a round." />
        ) : changes.changedFiles.length === 0 ? (
          <Empty title="No files changed" hint="The worktree is identical to the base branch." />
        ) : (
          <div>
            {changes.changedFiles.map((file) => (
              <div key={file.path} className="filerow">
                <span className={`statuscode statuscode--${file.status.charAt(0)}`}>
                  {file.status.charAt(0)}
                </span>
                <span className="filerow__path selectable" title={file.path}>
                  {file.path}
                </span>
                <span className="filerow__stat">
                  {file.binary ? (
                    <span className="faint">binary</span>
                  ) : (
                    <>
                      <span className="add">+{file.insertions ?? 0}</span>{' '}
                      <span className="del">−{file.deletions ?? 0}</span>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {changes && changes.diff.trim().length > 0 ? (
        <div>
          <div className="row" style={{ justifyContent: 'space-between', padding: '12px 14px 0' }}>
            <div className="section-title">Diff{changes.diffTruncated ? ' (truncated)' : ''}</div>
            <span className="faint mono">{changes.diffBytes.toLocaleString()} chars</span>
          </div>
          <DiffView diff={changes.diff} />
        </div>
      ) : null}

      {changes && changes.recentCommits.length > 0 ? (
        <div>
          <div className="section-title" style={{ padding: '12px 14px 0' }}>Commits on the task branch</div>
          {changes.recentCommits.map((commit) => (
            <div key={commit} className="filerow">
              <span className="filerow__path selectable">{commit}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A deliberately simple unified-diff renderer: colouring by line prefix is
 * enough to read a review, and it avoids shipping a syntax highlighter into a
 * CSP-locked renderer.
 */
function DiffView({ diff }: { diff: string }): React.JSX.Element {
  const lines = useMemo(() => diff.split('\n').slice(0, 6000), [diff]);

  return (
    <div className="diff selectable">
      {lines.map((line, index) => {
        let modifier = '';
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) {
          modifier = 'meta';
        } else if (line.startsWith('@@')) {
          modifier = 'hunk';
        } else if (line.startsWith('+')) {
          modifier = 'add';
        } else if (line.startsWith('-')) {
          modifier = 'del';
        }

        return (
          <div key={index} className={`diff__line${modifier ? ` diff__line--${modifier}` : ''}`}>
            {line.length === 0 ? ' ' : line}
          </div>
        );
      })}
    </div>
  );
}
