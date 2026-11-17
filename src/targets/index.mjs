import zcode from './zcode.mjs';
import opencode from './opencode.mjs';
import claudeCode from './claude-code.mjs';
import cline from './cline.mjs';
import continueTarget from './continue.mjs';
import litellm from './litellm.mjs';
import aider from './aider.mjs';
import env from './env.mjs';

/** Order matters only for the wizard menu and for `--target all`. */
export const TARGETS = [
  zcode,
  opencode,
  claudeCode,
  cline,
  continueTarget,
  litellm,
  aider,
  env,
];

export const TARGET_IDS = TARGETS.map((t) => t.id);

export function getTarget(id) {
  const found = TARGETS.find((t) => t.id === id || t.id === String(id).toLowerCase());
  if (!found) {
    throw new Error(`unknown target "${id}" — available: ${TARGET_IDS.join(', ')}`);
  }
  return found;
}

export function resolveTargets(list) {
  if (!list || list === 'all') return TARGETS;
  return String(list)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(getTarget);
}
