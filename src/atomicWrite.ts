/**
 * Atomic file write: writes to a temporary file in the same directory,
 * then renames into place. rename() is atomic on POSIX when source and
 * destination are on the same filesystem, which is guaranteed here since
 * the temp file is a sibling of the target.
 *
 * This prevents readers from ever seeing a half-written file.
 */

import { randomBytes, type BinaryLike } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class AtomicWriteError extends Error {
  constructor(
    message: string,
    public readonly targetPath: string
  ) {
    super(message);
    this.name = 'AtomicWriteError';
  }
}

export function writeFileAtomic(
  filePath: string,
  content: string | BinaryLike,
  options: { mode?: number; encoding?: BufferEncoding } = {}
): void {
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
