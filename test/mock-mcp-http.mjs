// Minimal Streamable-HTTP MCP server used by the test suite.
// POST /mcp with JSON-RPC; answers as application/json and tracks Mcp-Session-Id.
import http from 'node:http';

const PORT = Number(process.env.PORT || 15762);
let session = null;

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.headers['mcp-session-id']) session = req.headers['mcp-session-id'];
    let msg;
    try { msg = JSON.parse(body || '{}'); } catch { res.writeHead(400); return res.end(); }
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    if (session) res.setHeader('Mcp-Session-Id', session);
    res.setHeader('Content-Type', 'application/json');
    const { method, params } = msg;
    if (method === 'initialize') {
      session = session || 'sess-' + Math.random().toString(16).slice(2);
      res.setHeader('Mcp-Session-Id', session);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock-http-mcp', version: '1.0.0' } } }));
    } else if (method === 'tools/list') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'hping', description: 'HTTP echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] } }));
    } else if (method === 'tools/call') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `http-pong: ${params?.arguments?.msg ?? ''}` }] } }));
    } else {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } }));
    }
  });
}).listen(PORT, () => console.log(`mock http mcp on ${PORT}`));
