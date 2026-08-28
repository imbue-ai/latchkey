import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomic, AtomicWriteError } from '../src/atomicWrite.js';

describe('writeFileAtomic', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'latchkey-atomic-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write content to the target file', () => {
    const filePath = join(tempDir, 'test.txt');
    writeFileAtomic(filePath, 'hello world');
    expect(readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('should overwrite an existing file', () => {
    const filePath = join(tempDir, 'test.txt');
    writeFileAtomic(filePath, 'first');
    writeFileAtomic(filePath, 'second');
    expect(readFileSync(filePath, 'utf-8')).toBe('second');
  });

  it('should set file permissions via mode option', () => {
    const filePath = join(tempDir, 'secure.txt');
    writeFileAtomic(filePath, 'secret', { mode: 0o600 });
    const permissions = statSync(filePath).mode & 0o777;
    expect(permissions).toBe(0o600);
  });

  it('should not leave temporary files on success', () => {
    const filePath = join(tempDir, 'test.txt');
    writeFileAtomic(filePath, 'hello');
    const files = readdirSync(tempDir);
    expect(files).toEqual(['test.txt']);
  });

  it('should not leave temporary files on write failure', () => {
    // Try writing to a path where the directory doesn't exist
    const filePath = join(tempDir, 'nonexistent-dir', 'test.txt');
    expect(() => {
      writeFileAtomic(filePath, 'hello');
    }).toThrow(AtomicWriteError);
    // The parent dir of tempDir still exists, check no temp files leaked into tempDir
    const files = readdirSync(tempDir);
    expect(files).toEqual([]);
  });

  it('should throw AtomicWriteError on failure', () => {
    const filePath = join(tempDir, 'nonexistent-dir', 'test.txt');
    expect(() => {
      writeFileAtomic(filePath, 'hello');
    }).toThrow(AtomicWriteError);
  });

  it('should include the target path in the error', () => {
    const filePath = join(tempDir, 'nonexistent-dir', 'test.txt');
    try {
      writeFileAtomic(filePath, 'hello');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicWriteError);
      expect((error as AtomicWriteError).targetPath).toBe(filePath);
    }
  });

  it('should handle unicode content', () => {
    const filePath = join(tempDir, 'unicode.txt');
    const content = '{"key": "Héllo Wörld 日本語"}';
    writeFileAtomic(filePath, content);
    expect(readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('should handle empty content', () => {
    const filePath = join(tempDir, 'empty.txt');
    writeFileAtomic(filePath, '');
    expect(readFileSync(filePath, 'utf-8')).toBe('');
  });

  it('should handle large content', () => {
    const filePath = join(tempDir, 'large.txt');
    const content = 'x'.repeat(1_000_000);
    writeFileAtomic(filePath, content);
    expect(readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('should write through a symlink instead of replacing it', () => {
    const realPath = join(tempDir, 'real.txt');
    const linkPath = join(tempDir, 'link.txt');
    writeFileSync(realPath, 'original', 'utf-8');
    symlinkSync(realPath, linkPath);

    writeFileAtomic(linkPath, 'updated');

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(realPath, 'utf-8')).toBe('updated');
  });

  it('should follow a chain of symlinks', () => {
    const realPath = join(tempDir, 'real.txt');
    const middleLinkPath = join(tempDir, 'middle.txt');
    const outerLinkPath = join(tempDir, 'outer.txt');
    writeFileSync(realPath, 'original', 'utf-8');
    symlinkSync(realPath, middleLinkPath);
    symlinkSync(middleLinkPath, outerLinkPath);

    writeFileAtomic(outerLinkPath, 'updated');

    expect(lstatSync(outerLinkPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(middleLinkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(realPath, 'utf-8')).toBe('updated');
  });

  it('should create the target of a dangling symlink', () => {
    const realPath = join(tempDir, 'not-yet-there.txt');
    const linkPath = join(tempDir, 'link.txt');
    symlinkSync(realPath, linkPath);

    writeFileAtomic(linkPath, 'created');

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(realPath, 'utf-8')).toBe('created');
  });

  it('should write through a symlink pointing into another directory', () => {
    const otherDir = join(tempDir, 'other');
    mkdirSync(otherDir);
    const realPath = join(otherDir, 'real.txt');
    const linkPath = join(tempDir, 'link.txt');
    writeFileSync(realPath, 'original', 'utf-8');
    symlinkSync('other/real.txt', linkPath);

    writeFileAtomic(linkPath, 'updated', { mode: 0o600 });

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(realPath, 'utf-8')).toBe('updated');
    expect(readdirSync(tempDir).sort()).toEqual(['link.txt', 'other']);
  });

  it('should not corrupt the target file if rename would fail', () => {
    // Write initial content
    const filePath = join(tempDir, 'existing.txt');
    writeFileAtomic(filePath, 'original');

    // Make the target a directory so rename fails
    const dirPath = join(tempDir, 'target-is-dir');
    mkdirSync(dirPath);

    expect(() => {
      writeFileAtomic(dirPath, 'new content');
    }).toThrow(AtomicWriteError);

    // Original file should be untouched
    expect(readFileSync(filePath, 'utf-8')).toBe('original');
  });
});
