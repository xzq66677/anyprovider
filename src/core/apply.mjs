/**
 * Writing changes safely.
 *
 * Rules that the whole project follows:
 *  1. never write without a timestamped backup of an existing file;
 *  2. write to a temp file and rename, so a crash cannot leave a half config;
 *  3. if a target cannot merge into an existing file with certainty, write a
 *     sibling `*.anyprovider.<ext>` suggestion instead of touching it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

export function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
}

export function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
}

export function backupPath(path, when = new Date()) {
  return `${path}.bak-${timestamp(when)}`;
}

/**
 * @param {{path: string, text: string, note?: string}[]} writes
 * @param {{dryRun?: boolean, backup?: boolean, log?: (s: string) => void}} options
 * @returns {{path: string, bytes: number, backedUp: string|null, dryRun: boolean}[]}
 */
export function applyWrites(writes, options = {}) {
  const { dryRun = false, backup = true, log = () => {} } = options;
  const results = [];

  for (const write of writes) {
    const { path, text } = write;
    if (typeof text !== 'string') throw new Error(`target produced no text for ${path}`);
    const existed = existsSync(path);

    if (dryRun) {
      results.push({ path, bytes: Buffer.byteLength(text, 'utf8'), backedUp: null, dryRun: true, existed });
      log(`would write ${path} (${Buffer.byteLength(text, 'utf8')} bytes)${existed ? ', with backup' : ', new file'}`);
      continue;
    }

    mkdirSync(dirname(path), { recursive: true });

    let backedUp = null;
    if (existed && backup) {
      backedUp = backupPath(path);
      writeFileSync(backedUp, readFileSync(path));
      log(`backup ${backedUp}`);
    }

    const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
    log(`wrote ${path}`);
    results.push({ path, bytes: Buffer.byteLength(text, 'utf8'), backedUp, dryRun: false, existed });
  }

  return results;
}

/** For "cannot merge safely" targets: `<dir>/<name>.anyprovider.<ext>`. */
export function suggestionPath(path) {
  const dir = dirname(path);
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? `${base.slice(0, dot)}.anyprovider${base.slice(dot)}` : `${base}.anyprovider`;
  return join(dir, name);
}
