/**
 * Project registration and validation.
 *
 * Safety posture for this file: registering a project **reads** the folder and
 * nothing else. The only two operations that touch the filesystem are
 * `createNew` (which creates exactly one directory, the one the user named) and
 * `initGit` (which runs `git init`, and only after a native confirmation).
 * Nothing here ever deletes, moves, or reformats anything.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';
import type { ProjectValidation, RepositoryInfo } from '../../shared/domain/git';
import type { GithubVisibility, Project } from '../../shared/domain/models';
import { isValidGithubOwner, isValidRepoName } from '../../shared/util/slug';
import type {
  Clock,
  ConfirmationService,
  EventPublisher,
  GitAdapter,
  IdGenerator,
  ProjectRepository,
  SettingsRepository
} from '../ports';
import { assertAbsolutePath } from './path-safety';

export interface AddExistingProjectInput {
  readonly localPath: string;
  readonly name?: string;
  readonly defaultBranch?: string;
  readonly githubOwner?: string | null;
  readonly githubRepo?: string | null;
  readonly githubVisibility?: GithubVisibility;
}

export interface CreateNewProjectInput {
  readonly parentDirectory: string;
  readonly name: string;
  readonly defaultBranch?: string;
  readonly githubOwner?: string | null;
  readonly githubVisibility?: GithubVisibility;
}

export interface ProjectServiceDeps {
  readonly projects: ProjectRepository;
  readonly settings: SettingsRepository;
  readonly git: GitAdapter;
  readonly confirmation: ConfirmationService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
}

/** Names that must never be created or treated as a project directory. */
const RESERVED_WINDOWS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

export function isValidProjectDirectoryName(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  if (RESERVED_WINDOWS_NAMES.has(name.toLowerCase())) return false;
  // No separators, no traversal, no characters Windows forbids in a path.
  if (/[\\/:*?"<>|]/.test(name)) return false;
  if (name === '.' || name === '..') return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  return true;
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  list(): Project[] {
    return this.deps.projects.list();
  }

  async validatePath(localPath: string): Promise<ProjectValidation> {
    const problems: string[] = [];
    const warnings: string[] = [];

    if (!isAbsolute(localPath)) {
      return {
        ok: false,
        localPath,
        problems: ['The project path must be absolute.'],
        warnings: [],
        repository: null
      };
    }

    const path = resolve(localPath);

    if (!existsSync(path)) {
      return {
        ok: false,
        localPath: path,
        problems: ['That folder does not exist.'],
        warnings: [],
        repository: null
      };
    }
    if (!statSync(path).isDirectory()) {
      return {
        ok: false,
        localPath: path,
        problems: ['That path is a file, not a folder.'],
        warnings: [],
        repository: null
      };
    }

    const existing = this.deps.projects.findByLocalPath(path);
    if (existing) {
      warnings.push(`Already registered as the project "${existing.name}".`);
    }

    let repository: RepositoryInfo | null = null;
    try {
      repository = await this.deps.git.inspect(path);
    } catch (error) {
      problems.push(
        `Git could not inspect that folder: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (repository && !repository.isRepository) {
      problems.push('That folder is not a Git repository. Agent Relay needs one to create a worktree.');
    }

    if (repository?.isRepository) {
      if (!repository.isClean) {
        warnings.push(
          `The working tree has ${repository.dirtyFiles.length} uncommitted change(s). Agent Relay works in a separate worktree, so they are safe — but the task branch will not include them.`
        );
      }
      if (!repository.hasRemoteOrigin) {
        warnings.push('No "origin" remote is configured. You can still work locally.');
      }
      if (!repository.userName || !repository.userEmail) {
        warnings.push('Git has no commit identity here; committing will be blocked until it is set.');
      }
    }

    return {
      ok: problems.length === 0,
      localPath: path,
      problems,
      warnings,
      repository
    };
  }

  async addExisting(input: AddExistingProjectInput): Promise<Project> {
    assertAbsolutePath(input.localPath, 'Project path');
    const path = resolve(input.localPath);

    const validation = await this.validatePath(path);
    if (!validation.ok) {
      throw new AgentRelayError('VALIDATION_FAILED', validation.problems.join(' '), {
        details: path
      });
    }
    if (this.deps.projects.findByLocalPath(path)) {
      throw new AgentRelayError('VALIDATION_FAILED', 'That folder is already registered.', {
        details: path
      });
    }

    const settings = this.deps.settings.get();
    const repository = validation.repository;

    const project = this.deps.projects.create({
      id: this.deps.ids.next(),
      name: input.name?.trim() || basename(path),
      localPath: path,
      projectType: 'existing',
      defaultBranch:
        input.defaultBranch ?? repository?.defaultBranchGuess ?? repository?.currentBranch ?? 'main',
      githubOwner: normalizeOwner(input.githubOwner ?? settings.githubOwner),
      githubRepo: normalizeRepo(input.githubRepo ?? null),
      githubVisibility: input.githubVisibility ?? 'private'
    });

    this.deps.events.publishProject(project);
    return project;
  }

  /**
   * Create a brand-new project directory.
   *
   * Creates exactly one child of `parentDirectory`. It refuses if the target
   * already exists with content, and it does not initialise Git — that is a
   * separate, confirmed step.
   */
  createNew(input: CreateNewProjectInput): Project {
    assertAbsolutePath(input.parentDirectory, 'Parent directory');

    const name = input.name.trim();
    if (!isValidProjectDirectoryName(name)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `"${name}" is not a usable folder name. Avoid \\ / : * ? " < > | and reserved Windows names.`
      );
    }

    const parent = resolve(input.parentDirectory);
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new AgentRelayError('VALIDATION_FAILED', 'The parent folder does not exist.', {
        details: parent
      });
    }

    const target = join(parent, name);

    if (existsSync(target)) {
      if (!statSync(target).isDirectory()) {
        throw new AgentRelayError('VALIDATION_FAILED', 'A file with that name already exists.', {
          details: target
        });
      }
      if (readdirSync(target).length > 0) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          'That folder already exists and is not empty. Agent Relay will not write into it.',
          { details: target, remediation: 'Register it as an existing project instead.' }
        );
      }
    } else {
      // The single filesystem mutation in this method: create the child folder.
      mkdirSync(target, { recursive: false });
    }

    const settings = this.deps.settings.get();
    const project = this.deps.projects.create({
      id: this.deps.ids.next(),
      name,
      localPath: target,
      projectType: 'new',
      defaultBranch: input.defaultBranch ?? 'main',
      githubOwner: normalizeOwner(input.githubOwner ?? settings.githubOwner),
      githubRepo: normalizeRepo(name),
      githubVisibility: input.githubVisibility ?? 'private'
    });

    this.deps.events.publishProject(project);
    return project;
  }

  /** `git init` for a new project — only after an explicit native confirmation. */
  async initGit(projectId: string): Promise<Project> {
    const project = this.deps.projects.findById(projectId);
    if (!project) throw new AgentRelayError('NOT_FOUND', `No project with id ${projectId}.`);

    const existing = await this.deps.git.inspect(project.localPath);
    if (existing.isRepository) {
      throw new AgentRelayError('VALIDATION_FAILED', 'That folder is already a Git repository.');
    }

    const confirmed = await this.deps.confirmation.confirmSimple({
      headline: 'Initialise a Git repository?',
      detail: `Agent Relay will run "git init" in this folder.`,
      details: [
        `Folder: ${project.localPath}`,
        `Initial branch: ${project.defaultBranch}`,
        'No files are added, committed, or deleted.'
      ],
      confirmLabel: 'Initialise Git'
    });

    if (!confirmed) {
      throw new AgentRelayError('CANCELLED', 'Git initialisation was cancelled.');
    }

    const info = await this.deps.git.initRepository(project.localPath, project.defaultBranch);

    if (!info.userName || !info.userEmail) {
      // Not fatal — the repository exists — but the user must know before the
      // first commit is attempted.
      const updated = this.deps.projects.update(project.id, {});
      this.deps.events.publishProject(updated);
      throw new AgentRelayError(
        'GIT_FAILED',
        'The repository was created, but Git has no commit identity configured.',
        {
          remediation:
            'Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.'
        }
      );
    }

    const updated = this.deps.projects.update(project.id, {
      defaultBranch: info.currentBranch ?? project.defaultBranch
    });
    this.deps.events.publishProject(updated);
    return updated;
  }

  update(
    projectId: string,
    patch: {
      name?: string;
      defaultBranch?: string;
      githubOwner?: string | null;
      githubRepo?: string | null;
      githubVisibility?: GithubVisibility;
    }
  ): Project {
    const project = this.deps.projects.findById(projectId);
    if (!project) throw new AgentRelayError('NOT_FOUND', `No project with id ${projectId}.`);

    if (patch.githubOwner && !isValidGithubOwner(patch.githubOwner)) {
      throw new AgentRelayError('VALIDATION_FAILED', `"${patch.githubOwner}" is not a valid GitHub owner.`);
    }
    if (patch.githubRepo && !isValidRepoName(patch.githubRepo)) {
      throw new AgentRelayError('VALIDATION_FAILED', `"${patch.githubRepo}" is not a valid repository name.`);
    }

    const updated = this.deps.projects.update(projectId, {
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
      ...(patch.defaultBranch === undefined ? {} : { defaultBranch: patch.defaultBranch.trim() }),
      ...(patch.githubOwner === undefined ? {} : { githubOwner: normalizeOwner(patch.githubOwner) }),
      ...(patch.githubRepo === undefined ? {} : { githubRepo: normalizeRepo(patch.githubRepo) }),
      ...(patch.githubVisibility === undefined ? {} : { githubVisibility: patch.githubVisibility })
    });

    this.deps.events.publishProject(updated);
    return updated;
  }

  /** Removes the project from Agent Relay's database. The folder is untouched. */
  forget(projectId: string): void {
    const project = this.deps.projects.findById(projectId);
    if (!project) throw new AgentRelayError('NOT_FOUND', `No project with id ${projectId}.`);
    this.deps.projects.delete(projectId);
  }
}

function normalizeOwner(owner: string | null | undefined): string | null {
  const trimmed = owner?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeRepo(repo: string | null | undefined): string | null {
  const trimmed = repo?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
