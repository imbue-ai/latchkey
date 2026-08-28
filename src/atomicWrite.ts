/**
 * Atomic file write: writes to a temporary file in the same directory,
 * then renames into place. rename() is atomic on POSIX when source and
 * destination are on the same filesystem, which is guaranteed here since
 * the temp file is a sibling of the target.
 *
 * This prevents readers from ever seeing a half-written file.
 *
 * Symlinked targets are resolved first, so writing to a symlink replaces the
 * contents of the file it points at instead of replacing the symlink itself.
 */

import { randomBytes, type BinaryLike } from 'node:crypto';
import { readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MAXIMUM_SYMLINK_HOPS = 32;

export class AtomicWriteError extends Error {
  constructor(
    message: string,
    public readonly targetPath: string
  ) {
    super(message);
    this.name = 'AtomicWriteError';
  }
}

/**
 * Follow symlinks to the final path that should actually be written.
 * Works for dangling symlinks too, so a link pointing at a not-yet-existing
 * file creates that file rather than clobbering the link.
 */
function resolveSymlinkTarget(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    // The file (or something it points at) does not exist yet.
  }

  let currentPath = filePath;
  for (let hop = 0; hop < MAXIMUM_SYMLINK_HOPS; hop++) {
    let linkTarget: string;
    try {
      linkTarget = readlinkSync(currentPath);
    } catch {
      // Not a symlink: this is the path to write.
      return currentPath;
    }
    currentPath = resolve(dirname(currentPath), linkTarget);
  }

  throw new AtomicWriteError(`Too many symbolic links while resolving ${filePath}`, filePath);
}

export function writeFileAtomic(
  targetPath: string,
  content: string | BinaryLike,
  options: { mode?: number; encoding?: BufferEncoding } = {}
): void {
  const filePath = resolveSymlinkTarget(targetPath);
  const directory = dirname(filePath);
  const suffix = randomBytes(6).toString('hex');
  const tempPath = join(directory, `.tmp.${suffix}`);

  try {
    writeFileSync(tempPath, content, {
      encoding: options.encoding ?? 'utf-8',
      mode: options.mode,
    });
    renameSync(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on failure (best-effort)
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw new AtomicWriteError(
      `Failed to atomically write ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath
    );
  }
}
