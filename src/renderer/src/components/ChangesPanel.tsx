import { useMemo } from 'react';
import type { GitChangeSet } from '@shared/domain/git';
import { Card, Empty } from './primitives';

export function ChangesPanel({
  changes,
  loading,
  onRefresh
}: {
  changes: GitChangeSet | null;
  loading: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <>
      <Card
        title={changes ? `Changed files (${changes.changedFiles.length})` : 'Changed files'}
        flush
        actions={
          <button type="button" className="btn btn--sm btn--ghost" onClick={onRefresh} disabled={loading}>
            {loading ? 'Collecting…' : 'Refresh'}
          </button>
        }
      >
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
      </Card>

      {changes && changes.diff.trim().length > 0 ? (
        <Card
          title={`Diff${changes.diffTruncated ? ' (truncated)' : ''}`}
          flush
          actions={<span className="faint mono">{changes.diffBytes.toLocaleString()} chars</span>}
        >
          <DiffView diff={changes.diff} />
        </Card>
      ) : null}

      {changes && changes.recentCommits.length > 0 ? (
        <Card title="Commits on the task branch" flush>
          {changes.recentCommits.map((commit) => (
            <div key={commit} className="filerow">
              <span className="filerow__path selectable">{commit}</span>
            </div>
          ))}
        </Card>
      ) : null}
    </>
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
