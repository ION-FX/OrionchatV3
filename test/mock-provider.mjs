// Minimal OpenAI-compatible streaming provider for OrionChat tests.
// Behavior:
//   - plain chat  -> streams "MOCK-REPLY:<last user message>" as SSE chunks
//   - if tools are offered and no tool result is present yet, asks the caller
//     to invoke the first MCP-style tool (name contains "__") or the requested
//     "force_tool" system instruction, streaming args across two chunks
//   - reports usage in the final chunk
// PORT env overrides the port (default 4596).
import http from 'node:http';

const PORT = Number(process.env.PORT || 4596);

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body || '{}');
    const lastUser = [...(b.messages || [])].reverse().find((m) => m.role === 'user');
    const toolResult = (b.messages || []).some((m) => m.role === 'tool');
    const tools = (b.tools || []).map((t) => t.function || t);
    // vision requests arrive with multimodal content parts — use the text only
    const rawContent = lastUser?.content;
    const textContent = Array.isArray(rawContent)
      ? rawContent.filter((p) => p.type === 'text').map((p) => p.text).join(' ')
      : (rawContent || '');
    // pick the LAST namespaced tool so user-registered servers (added after
    // admin ones) can be exercised too
    const mcpTool = [...tools].reverse().find((t) => (t.name || '').includes('__'));
    const wantsForcedTool = textContent.includes('FORCE_TOOL');
    // "FORCE_TOOL:calculator" forces that specific builtin; plain FORCE_TOOL takes the first
    const forcedName = (textContent.match(/FORCE_TOOL:? ?([a-zA-Z0-9_]+)/) || [])[1] || '';
    const forcedTool = forcedName ? tools.find((t) => t.name === forcedName) : null;
    const wantsMcp = textContent.includes('CALL_MCP');
    const anyTool = forcedTool || tools[0];

    let content = '';
    let toolCalls = null;
    if (!toolResult && mcpTool && wantsMcp) {
      const args = JSON.stringify({ msg: textContent || 'ping' });
      toolCalls = [{ id: 'call_1', name: mcpTool.name, arguments: args }];
    } else if (!toolResult && wantsForcedTool && anyTool) {
      // fill every required property with the message text so builtins that
      // need input (knowledge_search, calculator…) actually exercise their path
      const args = {};
      for (const key of anyTool.inputSchema?.required || []) args[key] = textContent;
      toolCalls = [{ id: 'call_2', name: anyTool.name, arguments: JSON.stringify(args) }];
    } else {
      content = toolResult ? 'MOCK-AFTER-TOOL' : `MOCK-REPLY:${textContent}`;
    }

    // honor stream:false with a plain JSON completion
    if (!b.stream) {
      res.setHeader('Content-Type', 'application/json');
      const msg = { role: 'assistant', content };
      if (toolCalls) msg.tool_calls = toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));
      return res.end(JSON.stringify({
        choices: [{ message: msg, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: toolCalls ? 12 : 21, completion_tokens: toolCalls ? 5 : 14 },
      }));
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    if (toolCalls) {
      // stream tool-call arguments in fragments like real providers do
      const args = toolCalls[0].arguments;
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: toolCalls[0].id, type: 'function', function: { name: toolCalls[0].name, arguments: '' } }] } }] });
      if (args.length > 10) {
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 10) } }] } }] });
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] } }] });
      } else {
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] });
      }
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    } else {
      const mid = Math.ceil(content.length / 2);
      sse(res, { choices: [{ delta: { content: content.slice(0, mid) } }] });
      sse(res, { choices: [{ delta: { content: content.slice(mid) } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 14 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen(PORT, () => console.log(`mock-provider on ${PORT}`));
