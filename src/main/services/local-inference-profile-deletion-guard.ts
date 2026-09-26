import type { Task } from '../../shared/domain/models';

/**
 * A profile a non-terminal task is bound to may not be removed from Settings — that task's own lease
 * acquisition is the ONLY place that should ever discover its profile is gone, and it must discover that
 * once the task itself has finished, not mid-life because an unrelated Settings edit deleted the row out
 * from under it.
 *
 * A plain, domain-level function rather than logic embedded in IPC route registration or a dependency
 * SettingsRepository takes on TaskRepository: any caller that can name the surviving profile ids and
 * supply the non-terminal task list can reuse this same check.
 *
 * `listNonTerminalTasks` is called at most once, and only when a profile id actually disappears between
 * `currentProfileIds` and `nextProfileIds` — a routine settings save that touches nothing about the
 * profile list (or only edits/adds profiles) never pays for materializing every non-terminal task.
 */
export function findTaskOrphanedByProfileRemoval(
  currentProfileIds: ReadonlySet<string>,
  nextProfileIds: ReadonlySet<string>,
  listNonTerminalTasks: () => readonly Task[]
): Task | null {
  const removedIds = new Set<string>();
  for (const id of currentProfileIds) {
    if (!nextProfileIds.has(id)) removedIds.add(id);
  }
  if (removedIds.size === 0) return null;

  return (
    listNonTerminalTasks().find(
      (task) => task.ornithModelProfileId !== null && removedIds.has(task.ornithModelProfileId)
    ) ?? null
  );
}
