import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/**
 * Safe handling of MDD's own files: installation, configuration, artifacts and local markers.
 * This is filesystem hygiene for what MDD writes itself, not a restriction on what actors may
 * read or change in the user's project.
 */
export function scopedPath(root: string, value: unknown, directory = false): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f*?]/.test(value)) throw new Error('Invalid scoped path.');
  const path = resolve(root, value);
  const rel = relative(resolve(root), path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || (!directory && !rel)) throw new Error('Path is outside the approved root.');
  let current = parse(path).root;
  const parts = relative(current, path).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes(':') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw new Error('Unsafe scoped path component.');
    current = join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (directory) throw new Error('Working directory does not exist.');
      continue;
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      throw new Error('Linked or nonregular scoped path.');
    }
  }
  return path;
}

export function fileDigest(path: string): string {
  if (!fs.existsSync(path)) return 'absent';
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576) throw new Error('Installation file is unsafe or exceeds 1 MiB.');
    return createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally { fs.closeSync(fd); }
}
