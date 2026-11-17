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

/**
 * Can this target consume what the gateway speaks?
 * `protocols` is a declaration every adapter must honour, otherwise a chat-only
 * harness silently gets a config written for an anthropic gateway.
 */
export function supportsProtocol(target, protocol) {
  if (!protocol) return false;
  if (!Array.isArray(target.protocols) || !target.protocols.length) return true;
  return target.protocols.includes(protocol);
}
