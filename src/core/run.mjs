/**
 * Turn an adapter's plan into actual file operations.
 *
 * Safety policy (also documented in the README):
 *   merge:    we understand the file — merge it, keeping a timestamped backup
 *   create:   only when the file does not exist, otherwise downgrade to a suggestion
 *   suggest:  always write next to the real file, never over it
 */

import { existsSync } from 'node:fs';
import { applyWrites, suggestionPath } from './apply.mjs';

/**
 * @param {{writes: {path: string, text: string, mode?: string}[], notes?: string[], snippet?: string|null}} plan
 * @param {{dryRun?: boolean, force?: boolean, log?: (s: string) => void}} options
 */
export function executePlan(plan, { dryRun = false, force = false, log = () => {} } = {}) {
  const resolved = [];
  const notes = [...(plan.notes || [])];

  for (const write of plan.writes || []) {
    const mode = write.mode || 'merge';
    const exists = existsSync(write.path);

    if (mode === 'merge' || force || (mode === 'create' && !exists)) {
      resolved.push({ path: write.path, text: write.text });
      continue;
    }

    const alt = suggestionPath(write.path);
    notes.push(`${write.path} already exists and cannot be merged safely — writing ${alt} instead.`);
    resolved.push({ path: alt, text: write.text });
  }

  const results = applyWrites(resolved, { dryRun, log });
  return { results, notes };
}
