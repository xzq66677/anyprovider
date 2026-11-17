/**
 * Interactive input for the wizard.
 *
 * Two hard-won rules baked in:
 *  1. sequential questions must NOT use `rl.question` directly — piped or pasted
 *     input arrives before the next question is registered and is silently lost,
 *     so we keep our own line queue;
 *  2. masking by overriding `_writeToOutput` breaks the callback outside a TTY,
 *     so masking uses raw keypress mode and only on a real terminal.
 */

import readline from 'node:readline';

export function createPrompt({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output });
  const queue = [];
  let waiter = null;

  rl.on('line', (line) => {
    if (waiter) { const w = waiter; waiter = null; w(line); } else queue.push(line);
  });
  rl.on('SIGINT', () => { output.write('\n'); process.exit(130); });

  const isTTY = !!input.isTTY;

  function nextLine() {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => { waiter = resolve; });
  }

  /**
   * @param {string} question
   * @param {string} [fallback] shown in brackets, returned when the answer is empty
   */
  async function ask(question, fallback = '') {
    output.write(fallback ? `${question} [${fallback}] ` : `${question} `);
    const answer = String(await nextLine()).trim();
    return answer || fallback;
  }

  /** Masked input: raw mode on a terminal, plain read otherwise. */
  function askHidden(question) {
    if (!isTTY) return ask(question);
    return new Promise((resolve) => {
      output.write(question);
      const chars = [];
      const wasRaw = input.isRaw;
      rl.pause();
      readline.emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();

      const finish = (value) => {
        input.removeListener('keypress', onKey);
        try { input.setRawMode(!!wasRaw); } catch { /* terminal may be gone */ }
        rl.resume();
        output.write('\n');
        resolve(value);
      };

      const onKey = (str, key = {}) => {
        if (key.name === 'return' || key.name === 'enter') return finish(chars.join('').trim());
        if (key.name === 'backspace') { chars.pop(); return; }
        if (key.ctrl && key.name === 'c') { output.write('\n'); process.exit(130); }
        if (str && !key.ctrl && !key.meta) chars.push(str);
      };

      input.on('keypress', onKey);
    });
  }

  /** Space/comma separated multi-select over `options`; empty = all. */
  async function askMulti(question, options) {
    const answer = await ask(question);
    if (!answer) return options.map((o) => o.value);
    const picked = new Set();
    for (const part of answer.split(/[\s,，]+/).filter(Boolean)) {
      const index = Number(part);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) picked.add(options[index - 1].value);
      else if (options.some((o) => o.value === part)) picked.add(part);
    }
    return [...picked];
  }

  async function confirm(question, fallback = false) {
    const suffix = fallback ? '(Y/n)' : '(y/N)';
    const answer = (await ask(`${question} ${suffix}`)).toLowerCase();
    if (!answer) return fallback;
    return ['y', 'yes', '是', '好', '嗯'].includes(answer);
  }

  return {
    isTTY,
    ask,
    askHidden,
    askMulti,
    confirm,
    /** Wait for a keypress so a double-clicked window does not vanish. */
    async pause(question) { if (isTTY) await ask(question); },
    close() { rl.close(); },
  };
}
