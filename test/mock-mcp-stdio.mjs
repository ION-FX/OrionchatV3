// Minimal stdio MCP server used by the test suite: newline-delimited JSON-RPC 2.0.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification — nothing to answer
  const { method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-stdio-mcp', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: [{ name: 'ping', description: 'Echo a message back', inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }] },
    });
  } else if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `pong: ${params?.arguments?.msg ?? ''}` }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } });
  }
});
