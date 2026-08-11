/**
 * Real MCP client worker for tools/yaapi-rca.sh — see issue #245.
 *
 * This exists so the "real client" arms of the reproduction are driven by the
 * @modelcontextprotocol/sdk this repository actually depends on, rather than by a
 * hand-written emulation of it. The SDK owns initialization, protocol negotiation,
 * the post-initialize SSE stream, request ids, shutdown semantics and response
 * schema validation. The shell script owns only concurrency and result collection.
 *
 * Usage:  node tools/yaapi-rca-client.mjs <url> <fresh|initonly> <ops>
 *
 * Emits one line per event on stdout:
 *   SESSION <id>        a session was established (the shell releases it after the
 *                       arm finishes; note the SDK's close() does NOT send DELETE)
 *   RESULT OK
 *   RESULT FAIL <INIT_|CALL_><token>
 *
 * Modes:
 *   fresh      connect -> callTool -> close, once per operation (what
 *              src/services/mcp/streamable-http-client.ts does per call)
 *   initonly   connect -> close, once per operation (handshake only)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, mode, opsRaw] = process.argv.slice(2);
const ops = Number.parseInt(opsRaw ?? '', 10);

if (!url || !['fresh', 'initonly'].includes(mode) || !Number.isInteger(ops) || ops < 1) {
  process.stderr.write('usage: yaapi-rca-client.mjs <url> <fresh|initonly> <ops>\n');
  process.exit(2);
}

/** Map an SDK/transport error onto the shell script's result vocabulary. */
function token(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/<!DOCTYPE html/i.test(message) || /Server error/i.test(message)) return 'HTML500';
  const status = message.match(/\((?:HTTP )?(\d{3})\)/) ?? message.match(/status (\d{3})/i);
  if (status) return `HTTP${status[1]}`;
  if (/abort/i.test(message)) return 'ABORTED';
  if (/timed? ?out/i.test(message)) return 'TIMEOUT';
  // Zod rejections from CallToolResultSchema / InitializeResultSchema land here.
  if (/invalid|expected|schema/i.test(message)) return 'BADRESULT';
  return 'ERROR';
}

for (let i = 0; i < ops; i++) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'yaapi-rca', version: '4.0' });
  let phase = 'INIT';
  try {
    // connect() performs the whole lifecycle: initialize, protocol-version
    // negotiation and validation, notifications/initialized, and the SSE stream.
    await client.connect(transport);
    if (transport.sessionId) process.stdout.write(`SESSION ${transport.sessionId}\n`);
    phase = 'CALL';
    if (mode === 'fresh') {
      // callTool validates against CallToolResultSchema by default, so a malformed
      // result is a failure here rather than something this file has to re-check.
      const result = await client.callTool({
        name: 'list_versions',
        arguments: { language: 'English' },
      });
      process.stdout.write(result.isError ? 'RESULT FAIL CALL_TOOLERR\n' : 'RESULT OK\n');
    } else {
      process.stdout.write('RESULT OK\n');
    }
  } catch (error) {
    process.stdout.write(`RESULT FAIL ${phase}_${token(error)}\n`);
  } finally {
    // Mirrors the repo client: close() only. It aborts the transport and sends no
    // DELETE, which is why sessions are reported above for post-arm cleanup.
    try {
      await client.close();
    } catch (error) {
      process.stderr.write(`close failed: ${error instanceof Error ? error.message : error}\n`);
    }
  }
}
