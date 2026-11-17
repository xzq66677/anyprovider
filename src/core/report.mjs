/**
 * Human-readable reporting shared by the CLI and the wizard.
 */

import { bullet, dim, green, note, say, table, yellow } from './format.mjs';

export function printDiscovery(discovery) {
  say('');
  say(`  ${dim('base URL')}  ${discovery.baseUrl}`);
  say(`  ${dim('format  ')}  ${discovery.format || dim('unknown')}`);
  say(`  ${dim('models  ')}  ${discovery.models.length} (from ${discovery.modelsEndpoint || 'manual list'})`);
  if (discovery.providerReasoning) {
    say(`  ${dim('reasoning')} ${green(discovery.providerReasoning)}`);
  } else {
    say(`  ${dim('reasoning')} ${yellow('none accepted')}`);
  }
}

export function printModels(models) {
  say('');
  table(
    ['#', 'model id', 'context', 'max out', 'reasoning'],
    models.map((m, i) => [
      String(i + 1),
      m.id,
      String(m.contextWindow),
      String(m.maxOutputTokens),
      m.reasoning || '-',
    ]),
  );
}

export function printNotes(notes = []) {
  if (!notes.length) return;
  say('');
  for (const line of notes) bullet(line.startsWith('  ') ? dim(line.trim()) : dim(line));
}

export function printSnippet(snippet) {
  if (!snippet) return;
  say('');
  say(dim('  --- snippet ---'));
  for (const line of snippet.split('\n')) say(`  ${line}`);
}

export function printResults(results) {
  say('');
  for (const r of results) {
    const action = r.dryRun ? 'would write' : 'wrote';
    say(`  ${green('✓')} ${action} ${r.path}${r.dryRun ? '' : ` ${dim(`(${r.bytes} bytes)`)}`}`);
    if (r.backedUp) note(`    backup: ${r.backedUp}`);
  }
}
