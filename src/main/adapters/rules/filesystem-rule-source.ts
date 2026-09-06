/**
 * Bounded, symlink-refusing access to rule files.
 *
 * The adapter returns bytes and relative paths only. Hashing, UTF-8 validation,
 * source identity and snapshot policy belong to the service above it.
 */

import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent
} from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { AgentRelayError } from '../../../shared/domain/errors';
import type {
  RuleSourceListing,
  RuleSourceReadResult,
  RuleSourceReader
} from '../../ports';
import { assertAbsolutePath, isInsideDirectory, isSamePath } from '../../services/path-safety';

const FIXED_PROJECT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md'
] as const;

const RULE_DIRECTORIES = ['.claude/rules', '.cursor/rules'] as const;
const RULE_EXTENSIONS = new Set(['.md', '.mdc']);

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

function normalizedRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    isAbsolute(value) ||
    // A colon is not meaningful in a repository-relative rule path and is a
    // drive/URL ambiguity on Windows.
    value.includes(':') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new AgentRelayError('UNSAFE_PATH', 'A rule file path must be a clean relative POSIX path.');
  }

  const normalized = posix.normalize(value);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized !== value
  ) {
    throw new AgentRelayError('UNSAFE_PATH', 'A rule file path may not traverse or change spelling.');
  }
  return normalized;
}

function nativePath(rootPath: string, rulePath: string): string {
  return join(rootPath, ...normalizedRelativePath(rulePath).split('/'));
}

function sourceRelative(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join('/');
}

function safelyInsideRealRoot(rootPath: string, candidatePath: string): boolean {
  const realRoot = realpathSync(rootPath);
  const realCandidate = realpathSync(candidatePath);
  return isSamePath(realRoot, realCandidate) || isInsideDirectory(realRoot, realCandidate);
}

/** Refuse a symlink in any path component below the configured root. */
function hasSymlink(rootPath: string, rulePath: string): boolean {
  let current = resolve(rootPath);
  for (const segment of normalizedRelativePath(rulePath).split('/')) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function omission(path: string, reason: RuleSourceListing['omitted'][number]['reason']) {
  return { path, reason } as const;
}

export class FilesystemRuleSourceReader implements RuleSourceReader {
  discoverProject(rootPath: string, maxEntries: number): RuleSourceListing {
    assertAbsolutePath(rootPath, 'Rule source root');
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new AgentRelayError('VALIDATION_FAILED', 'Rule discovery limit must be positive.');
    }

    const paths: string[] = [];
    const omitted: RuleSourceListing['omitted'][number][] = [];
    let visited = 0;
    let exhausted = false;

    for (const path of FIXED_PROJECT_FILES) {
      const candidate = nativePath(rootPath, path);
      try {
        if (hasSymlink(rootPath, path)) {
          omitted.push(omission(path, 'symlink'));
          continue;
        }
        const status = lstatSync(candidate);
        if (status.isFile()) paths.push(path);
        else omitted.push(omission(path, 'not_file'));
      } catch (error) {
        omitted.push(omission(path, errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable'));
      }
    }

    const walk = (directoryPath: string): void => {
      if (exhausted) return;
      let entries: Dirent[];
      try {
        const path = sourceRelative(rootPath, directoryPath);
        if (hasSymlink(rootPath, path)) {
          omitted.push(omission(path, 'symlink'));
          return;
        }
        if (!lstatSync(directoryPath).isDirectory()) {
          omitted.push(omission(`${path}/**`, 'not_file'));
          return;
        }
        entries = readdirSync(directoryPath, { withFileTypes: true });
      } catch (error) {
        const path = sourceRelative(rootPath, directoryPath);
        omitted.push(omission(`${path}/**`, errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable'));
        return;
      }

      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        visited += 1;
        if (visited > maxEntries) {
          exhausted = true;
          omitted.push(omission(`${sourceRelative(rootPath, directoryPath)}/**`, 'discovery_limit'));
          return;
        }
        const absolute = join(directoryPath, entry.name);
        const path = sourceRelative(rootPath, absolute);
        if (entry.isSymbolicLink()) {
          omitted.push(omission(path, 'symlink'));
        } else if (entry.isDirectory()) {
          walk(absolute);
        } else if (entry.isFile() && RULE_EXTENSIONS.has(posix.extname(entry.name).toLowerCase())) {
          paths.push(path);
        }
      }
    };

    for (const directory of RULE_DIRECTORIES) walk(nativePath(rootPath, directory));

    return {
      paths: [...new Set(paths)].sort(),
      omitted: [...omitted].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    };
  }

  read(rootPath: string, relativePath: string, maxBytes: number): RuleSourceReadResult {
    assertAbsolutePath(rootPath, 'Rule source root');
    const path = normalizedRelativePath(relativePath);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new AgentRelayError('VALIDATION_FAILED', 'Rule file byte limit must be positive.');
    }
    const candidate = nativePath(rootPath, path);

    try {
      const before = lstatSync(candidate);
      if (hasSymlink(rootPath, path)) return { ok: false, path, reason: 'symlink' };
      if (!before.isFile()) return { ok: false, path, reason: 'not_file' };
      if (!safelyInsideRealRoot(rootPath, candidate)) {
        return { ok: false, path, reason: 'outside_root' };
      }
      if (before.size > maxBytes) return { ok: false, path, reason: 'too_large' };

      const bytes = readFileSync(candidate);
      const after = statSync(candidate);
      if (bytes.byteLength > maxBytes) return { ok: false, path, reason: 'too_large' };
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        return { ok: false, path, reason: 'unreadable' };
      }
      if (!safelyInsideRealRoot(rootPath, candidate)) {
        return { ok: false, path, reason: 'outside_root' };
      }
      return { ok: true, path, bytes };
    } catch (error) {
      return {
        ok: false,
        path,
        reason: errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable'
      };
    }
  }
}
