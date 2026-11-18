import zcode from './zcode.mjs';
import opencode from './opencode.mjs';
import claudeCode from './claude-code.mjs';
import deepseekHarness from './deepseek-harness.mjs';
import cline from './cline.mjs';
import continueTarget from './continue.mjs';
import litellm from './litellm.mjs';
import aider from './aider.mjs';
import zed from './zed.mjs';
import vscodeCopilot from './vscode-copilot.mjs';
import windsurf from './windsurf.mjs';
import env from './env.mjs';

/** Order matters only for the wizard menu and for `--target all`. */
export const TARGETS = [
  zcode,
  opencode,
  claudeCode,
  deepseekHarness,
  cline,
  continueTarget,
  litellm,
  aider,
  zed,
  vscodeCopilot,
  windsurf,
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
 * Parse an interactive selection answer into target objects. Accepts 1-based
 * indexes, ids, and "all"/"a"; unknown tokens are ignored and order preserved.
 * Shared by the CLI prompt and the wizard so both understand the same syntax.
 */
export function parseTargetSelection(answer) {
  const picked = [];
  for (const part of String(answer || '').split(/[\s,，]+/).filter(Boolean)) {
    if (/^a(ll)?$/i.test(part)) { picked.push(...TARGETS); continue; }
    const t = /^\d+$/.test(part) ? TARGETS[Number(part) - 1] : TARGETS.find((x) => x.id === part);
    if (t && !picked.includes(t)) picked.push(t);
  }
  return picked;
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
