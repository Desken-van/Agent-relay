import { useCallback, useEffect, useState } from 'react';
import type { ProjectValidation } from '@shared/domain/git';
import type { GithubVisibility, Project } from '@shared/domain/models';
import { call, expect } from '../lib/api';
import { useStore } from '../state/store';
import { Card, Empty, Field, Notice, Scope, Spinner } from './primitives';

type Mode = 'existing' | 'new';

export function ProjectsView(): React.JSX.Element {
  const store = useStore();
  const { projects, selectedProject, selectProject, setSection, refreshProjects, perform, notify } =
    store;

  const [mode, setMode] = useState<Mode>('existing');

  return (
    <div className="projects">
      <div className="stack">
        <Card
          title={`Projects (${projects.length})`}
          flush
          actions={
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void refreshProjects()}>
              Refresh
            </button>
          }
        >
          {projects.length === 0 ? (
            <Empty title="No projects yet" hint="Register a local Git repository to begin." />
          ) : (
            <div className="list">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="list__item"
                  aria-selected={project.id === selectedProject?.id}
                  onClick={() => selectProject(project.id)}
                  onDoubleClick={() => {
                    selectProject(project.id);
                    setSection('tasks');
                  }}
                >
                  <div className="list__name">{project.name}</div>
                  <div className="list__meta">{project.localPath}</div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title="Add a project" flush>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
            {(['existing', 'new'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="btn btn--ghost"
                style={{
                  flex: 1,
                  borderRadius: 0,
                  borderBottom: mode === value ? '2px solid var(--codex)' : '2px solid transparent',
                  color: mode === value ? 'var(--text)' : undefined
                }}
                onClick={() => setMode(value)}
              >
                {value === 'existing' ? 'Existing repository' : 'New project'}
              </button>
            ))}
          </div>
          <div style={{ padding: 16 }}>
            {mode === 'existing' ? <AddExistingForm /> : <CreateNewForm />}
          </div>
        </Card>
      </div>

      <div className="stack">
        {selectedProject ? (
          <ProjectDetail
            // Remount on selection change so the form fields re-initialise from
            // the new project instead of being synchronised in an effect.
            key={selectedProject.id}
            project={selectedProject}
            onOpenTasks={() => setSection('tasks')}
            onForget={() =>
              void perform('forget', 'Could not remove the project', async () => {
                await expect('projects:forget', { projectId: selectedProject.id });
                selectProject(null);
                await refreshProjects();
                notify({
                  tone: 'info',
                  title: 'Project removed from Agent Relay',
                  body: 'The folder on disk was not touched.'
                });
              })
            }
          />
        ) : (
          <Card>
            <Empty title="Select a project" hint="Its validation and Git details appear here." />
          </Card>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ProjectDetail({
  project,
  onOpenTasks,
  onForget
}: {
  project: Project;
  onOpenTasks: () => void;
  onForget: () => void;
}): React.JSX.Element {
  const { perform, notify, refreshProjects } = useStore();
  const [validation, setValidation] = useState<ProjectValidation | null>(null);
  const [checking, setChecking] = useState(true);

  // These are initialised from props exactly once: the component is keyed on the
  // project id by its parent, so selecting a different project remounts it with
  // fresh values rather than needing a prop-sync effect.
  const [owner, setOwner] = useState(project.githubOwner ?? '');
  const [repo, setRepo] = useState(project.githubRepo ?? '');
  const [branch, setBranch] = useState(project.defaultBranch);
  const [visibility, setVisibility] = useState<GithubVisibility>(project.githubVisibility);

  const fetchValidation = useCallback(async (): Promise<ProjectValidation | null> => {
    const result = await call('projects:validatePath', { localPath: project.localPath });
    return result.ok ? result.data : null;
  }, [project.localPath]);

  useEffect(() => {
    let active = true;
    void fetchValidation().then((value) => {
      if (!active) return;
      setValidation(value);
      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [fetchValidation]);

  /** Manual re-check from the button — an event handler, so setState is fine. */
  const validate = useCallback(async () => {
    setChecking(true);
    try {
      setValidation(await fetchValidation());
    } finally {
      setChecking(false);
    }
  }, [fetchValidation]);

  const repository = validation?.repository ?? null;

  return (
    <>
      <Card
        title="Project"
        actions={
          <>
            <button type="button" className="btn btn--sm" onClick={onOpenTasks}>
              Open tasks
            </button>
            <button type="button" className="btn btn--sm btn--danger" onClick={onForget}>
              Remove
            </button>
          </>
        }
      >
        <div className="kv">
          <span className="kv__k">Name</span>
          <span className="kv__v">{project.name}</span>
          <span className="kv__k">Local path</span>
          <span className="kv__v mono selectable">{project.localPath}</span>
          <span className="kv__k">Type</span>
          <span className="kv__v">{project.projectType === 'new' ? 'Created by Agent Relay' : 'Existing repository'}</span>
          <span className="kv__k">Base branch</span>
          <span className="kv__v mono">{project.defaultBranch}</span>
          <span className="kv__k">GitHub</span>
          <span className="kv__v mono">
            {project.githubOwner ? `${project.githubOwner}/${project.githubRepo ?? '—'}` : 'not configured'}{' '}
            <span className="faint">({project.githubVisibility})</span>
          </span>
        </div>
      </Card>

      <Card
        title="Validation"
        actions={
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void validate()}
            disabled={checking}
          >
            {checking ? <Spinner /> : null} Re-check
          </button>
        }
      >
        {checking && !validation ? (
          <div className="muted">Inspecting the repository…</div>
        ) : !validation ? (
          <Notice tone="error">Could not inspect this folder.</Notice>
        ) : (
          <div className="stack stack--tight">
            {validation.problems.map((problem) => (
              <Notice key={problem} tone="error">
                {problem}
              </Notice>
            ))}
            {validation.warnings.map((warning) => (
              <Notice key={warning} tone="warn">
                {warning}
              </Notice>
            ))}
            {validation.ok && validation.warnings.length === 0 ? (
              <Notice tone="info">This repository is ready to use.</Notice>
            ) : null}

            {repository?.isRepository ? (
              <div className="kv" style={{ marginTop: 8 }}>
                <span className="kv__k">Current branch</span>
                <span className="kv__v mono">{repository.currentBranch ?? '(detached)'}</span>
                <span className="kv__k">Branches</span>
                <span className="kv__v mono">{repository.branches.join(', ') || '—'}</span>
                <span className="kv__k">Working tree</span>
                <span className="kv__v">
                  {repository.isClean ? 'clean' : `${repository.dirtyFiles.length} uncommitted change(s)`}
                </span>
                <span className="kv__k">Remote origin</span>
                <span className="kv__v mono selectable">{repository.remoteUrl ?? 'none'}</span>
                <span className="kv__k">Commit identity</span>
                <span className="kv__v">
                  {repository.userName && repository.userEmail
                    ? `${repository.userName} <${repository.userEmail}>`
                    : 'not configured'}
                </span>
              </div>
            ) : null}

            {repository && !repository.isRepository ? (
              <button
                type="button"
                className="btn btn--sm"
                style={{ alignSelf: 'flex-start', marginTop: 6 }}
                onClick={() =>
                  void perform('init-git', 'Could not initialise Git', async () => {
                    await expect('projects:initGit', { projectId: project.id });
                    notify({ tone: 'success', title: 'Git repository initialised' });
                    await validate();
                    await refreshProjects();
                  })
                }
              >
                <Scope kind="local" /> Initialise Git here…
              </button>
            ) : null}
          </div>
        )}
      </Card>

      <Card
        title="GitHub target"
        actions={
          <button
            type="button"
            className="btn btn--sm"
            onClick={() =>
              void perform('update-project', 'Could not save', async () => {
                await expect('projects:update', {
                  projectId: project.id,
                  defaultBranch: branch,
                  githubOwner: owner.trim() || null,
                  githubRepo: repo.trim() || null,
                  githubVisibility: visibility
                });
                notify({ tone: 'success', title: 'Project updated' });
                await refreshProjects();
              })
            }
          >
            Save
          </button>
        }
      >
        <div className="stack">
          <div className="grid-2">
            <Field label="Base branch" hint="Task branches are cut from this.">
              <input className="input input--mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </Field>
            <Field label="Visibility" hint="Used when creating the repository.">
              <select
                className="select"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as GithubVisibility)}
              >
                <option value="private">private</option>
                <option value="public">public</option>
              </select>
            </Field>
          </div>
          <div className="grid-2">
            <Field label="GitHub owner">
              <input className="input input--mono" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </Field>
            <Field label="Repository name">
              <input className="input input--mono" value={repo} onChange={(e) => setRepo(e.target.value)} />
            </Field>
          </div>
        </div>
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function AddExistingForm(): React.JSX.Element {
  const { perform, notify, refreshProjects, selectProject } = useStore();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [validation, setValidation] = useState<ProjectValidation | null>(null);

  const pick = async (): Promise<void> => {
    const result = await call('dialog:pickDirectory', { title: 'Choose a Git repository' });
    if (result.ok && result.data) {
      setPath(result.data);
      const check = await call('projects:validatePath', { localPath: result.data });
      setValidation(check.ok ? check.data : null);
    }
  };

  return (
    <div className="stack">
      <Field label="Repository folder" hint="Must already be a Git repository.">
        <div className="row">
          <input
            className="input input--mono"
            value={path}
            placeholder="C:\path\to\repository"
            onChange={(e) => setPath(e.target.value)}
            onBlur={async () => {
              if (!path.trim()) return;
              const check = await call('projects:validatePath', { localPath: path.trim() });
              setValidation(check.ok ? check.data : null);
            }}
          />
          <button type="button" className="btn btn--sm" onClick={() => void pick()}>
            Browse…
          </button>
        </div>
      </Field>

      <Field label="Display name" hint="Defaults to the folder name.">
        <input className="input" value={name} placeholder="(optional)" onChange={(e) => setName(e.target.value)} />
      </Field>

      {validation
        ? [
            ...validation.problems.map((p) => (
              <Notice key={p} tone="error">
                {p}
              </Notice>
            )),
            ...validation.warnings.map((w) => (
              <Notice key={w} tone="warn">
                {w}
              </Notice>
            ))
          ]
        : null}

      <button
        type="button"
        className="btn btn--primary"
        disabled={!path.trim() || validation?.ok === false}
        onClick={() =>
          void perform('add-existing', 'Could not add the project', async () => {
            const project = await expect('projects:addExisting', {
              localPath: path.trim(),
              ...(name.trim() ? { name: name.trim() } : {})
            });
            setPath('');
            setName('');
            setValidation(null);
            await refreshProjects();
            selectProject(project.id);
            notify({ tone: 'success', title: `Added ${project.name}` });
          })
        }
      >
        <Scope kind="read" /> Add project
      </button>
    </div>
  );
}

function CreateNewForm(): React.JSX.Element {
  const { perform, notify, refreshProjects, selectProject, settings } = useStore();
  // The configured projects root is the default; an explicit choice overrides it.
  const [chosenParent, setChosenParent] = useState<string | null>(null);
  const parent = chosenParent ?? settings?.projectsRoot ?? '';
  const setParent = setChosenParent;
  const [name, setName] = useState('');

  return (
    <div className="stack">
      <Notice tone="info">
        Agent Relay creates only the child folder you name here. Git is not initialised until you
        explicitly confirm it.
      </Notice>

      <Field label="Parent folder">
        <div className="row">
          <input
            className="input input--mono"
            value={parent}
            placeholder="C:\path\to\parent"
            onChange={(e) => setParent(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--sm"
            onClick={async () => {
              const result = await call('dialog:pickDirectory', { title: 'Choose a parent folder' });
              if (result.ok && result.data) setParent(result.data);
            }}
          >
            Browse…
          </button>
        </div>
      </Field>

      <Field label="Project name" hint="Becomes the folder name and the default repository name.">
        <input className="input" value={name} placeholder="my-project" onChange={(e) => setName(e.target.value)} />
      </Field>

      <button
        type="button"
        className="btn btn--primary"
        disabled={!parent.trim() || !name.trim()}
        onClick={() =>
          void perform('create-new', 'Could not create the project', async () => {
            const project = await expect('projects:createNew', {
              parentDirectory: parent.trim(),
              name: name.trim()
            });
            setName('');
            await refreshProjects();
            selectProject(project.id);
            notify({
              tone: 'success',
              title: `Created ${project.name}`,
              body: 'Initialise Git from the project panel when you are ready.'
            });
          })
        }
      >
        <Scope kind="local" /> Create folder
      </button>
    </div>
  );
}
