/**
 * Dev utility: run the mock gateway on a fixed port so you can exercise the CLI
 * and the wizard by hand.
 *
 *   node test/serve-mock.mjs [port]            # prints the base URL
 *   node src/cli.mjs --base http://127.0.0.1:47915/v1 --key sk-test --target env
 *
 * Mock credentials: key `sk-test`, models `mock-think` (reasoning) and
 * `mock-plain` (rejects every reasoning knob), token ceiling 65536.
 */

import { startMock } from './mock-gateway.mjs';

const port = Number(process.argv[2] || 47915);
const mock = await startMock({ port });

// startMock picks an ephemeral port; rebind is unnecessary for local use, so we
// simply report whatever we got and keep the process alive.
console.log(`mock gateway: ${mock.url}`);
console.log(`key         : ${mock.key}`);
console.log('press Ctrl+C to stop');

process.on('SIGINT', async () => { await mock.close(); process.exit(0); });
