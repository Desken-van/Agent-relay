import { AgentRelayError } from '../../../shared/domain/errors';
import type { Project } from '../../../shared/domain/models';
import type { Clock, NewProject, ProjectPatch, ProjectRepository } from '../../ports';
import type { Db } from '../database';
import { toProject, type ProjectRow } from '../rows';

const COLUMNS = `id, name, local_path, project_type, default_branch, github_owner,
                 github_repo, github_visibility, created_at, updated_at`;

export class SqliteProjectRepository implements ProjectRepository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
  ) {}

  list(): Project[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM projects ORDER BY name COLLATE NOCASE ASC`)
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  findById(id: string): Project | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : null;
  }

  findByLocalPath(localPath: string): Project | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM projects WHERE local_path = ?`).get(localPath) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : null;
  }

  create(project: NewProject): Project {
    const now = this.clock.nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO projects (id, name, local_path, project_type, default_branch,
                                 github_owner, github_repo, github_visibility, created_at, updated_at)
           VALUES (@id, @name, @localPath, @projectType, @defaultBranch,
                   @githubOwner, @githubRepo, @githubVisibility, @createdAt, @updatedAt)`
        )
        .run({ ...project, createdAt: now, updatedAt: now });
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed: projects.local_path')) {
        throw new AgentRelayError('VALIDATION_FAILED', 'That folder is already registered as a project.', {
          details: project.localPath
        });
      }
      throw error;
    }

    const created = this.findById(project.id);
    if (!created) throw new AgentRelayError('INTERNAL', 'Project disappeared immediately after insert.');
    return created;
  }

  update(id: string, patch: ProjectPatch): Project {
    const existing = this.findById(id);
    if (!existing) {
      throw new AgentRelayError('NOT_FOUND', `No project with id ${id}.`);
    }

    const next: Project = {
      ...existing,
      ...patch,
      updatedAt: this.clock.nowIso()
    };

    this.db
      .prepare(
        `UPDATE projects
            SET name = @name,
                local_path = @localPath,
                project_type = @projectType,
                default_branch = @defaultBranch,
                github_owner = @githubOwner,
                github_repo = @githubRepo,
                github_visibility = @githubVisibility,
                updated_at = @updatedAt
          WHERE id = @id`
      )
      .run(next);

    return next;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
