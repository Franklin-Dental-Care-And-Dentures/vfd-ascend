// The MCP tool server Vida's engine dials (vfd-agent engine/tools/sim.go): streamable HTTP at /mcp, stateless, JSON
// responses, every request with "Authorization: Bearer <key>".
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, callTool } from './tools.ts';

function keyOk(header: string | undefined, key: string): boolean {
  const want = Buffer.from(`Bearer ${key}`);
  const got = Buffer.from(header ?? '');
  return got.length === want.length && timingSafeEqual(got, want);
}

export function startServer(opts: { host: string; port: number; key: string }): Promise<HttpServer> {
  if (opts.key.length < 16) throw new Error('the link key is missing or too short');
  const http = createServer(async (req, res) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!keyOk(req.headers.authorization, opts.key)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    const mcp = new Server({ name: 'vfd-ascend', version: '0.1.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
      const meta = (r.params._meta ?? {}) as { caller_id?: string };
      let out;
      try {
        out = await callTool(r.params.name, (r.params.arguments ?? {}) as Record<string, unknown>, meta);
      } catch (e) {
        out = { ok: false, error: String((e as Error).message ?? e).split('\n')[0].slice(0, 300) };
      }
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end();
      console.error('mcp request failed:', String((e as Error).message).split('\n')[0]);
    }
  });
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve(http));
  });
}
