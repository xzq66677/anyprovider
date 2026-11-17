/**
 * A deliberately awkward gateway, used by the test suite.
 *
 * It behaves like the real world: /models is incomplete, the bare
 * /chat/completions path 404s (so the /v1 variant must be found), one model
 * accepts reasoning_effort, another rejects every reasoning knob, and both
 * refuse oversized max_tokens with the real ceiling in the error message.
 */

import { createServer } from 'node:http';

const DEFAULT_MODELS = [
  { id: 'mock-think', context_length: 262144 },
  { id: 'mock-plain' }, // no metadata, no reasoning support
];

export function startMock({
  key = 'sk-test',
  models = DEFAULT_MODELS,
  ceiling = 65536,
  authRequired = true,
  port = 0,
} = {}) {
  const knobs = ['reasoning_effort', 'thinking', 'reasoning', 'enable_thinking', 'chat_template_kwargs'];

  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (authRequired && (req.headers.authorization || '') !== `Bearer ${key}`) {
      return send(401, { error: { message: 'invalid api key' } });
    }

    if (req.method === 'GET' && req.url.endsWith('/models')) {
      return send(200, { object: 'list', data: models });
    }

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: { message: 'bad json' } }); }
      if (!Array.isArray(body.messages)) return send(404, { error: { message: 'not found' } });

      const isThink = body.model === 'mock-think';
      const used = knobs.filter((k) => k in body);
      if (used.length && !isThink) {
        return send(400, { error: { message: `Unrecognized request argument supplied: ${used[0]}` } });
      }
      if (typeof body.max_tokens === 'number' && body.max_tokens > ceiling) {
        return send(400, {
          error: { message: `max_tokens is too large: ${body.max_tokens}. This model supports at most ${ceiling} completion tokens.` },
        });
      }

      send(200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '323' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}/v1`,
        root: `http://127.0.0.1:${actual}`,
        key,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
