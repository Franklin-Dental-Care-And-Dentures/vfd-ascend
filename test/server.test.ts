// The contract: the engine sees the sim's tools, names, arguments and result format, unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.ts';
import { practiceNow } from '../src/tools.ts';

const KEY = 'test-key-0123456789abcdef';
const contract = JSON.parse(readFileSync(new URL('../contract/sim-tool-schemas.json', import.meta.url), 'utf8'));
let http: HttpServer;
let url: URL;

before(async () => {
  http = await startServer({ host: '127.0.0.1', port: 0, key: KEY });
  url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
});
after(() => { http.close(); });

async function client(key = KEY) {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
}

const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]).text);

test("tools/list is the sim's eleven tools, schemas unchanged, plus sim_clock", async () => {
  const c = await client();
  const { tools } = await c.listTools();
  assert.equal(contract.tools.length, 11);
  assert.deepEqual(tools.map((t) => t.name), [...contract.tools.map((t: any) => t.function.name), 'sim_clock']);
  for (const t of contract.tools) {
    const served = tools.find((x) => x.name === t.function.name)!;
    assert.deepEqual(served.inputSchema, t.function.parameters, t.function.name);
    assert.equal(served.description, t.function.description);
  }
  await c.close();
});

test("sim_clock gives the practice's now in the engine's format", async () => {
  const c = await client();
  const r = text(await c.callTool({ name: 'sim_clock', arguments: {} }));
  assert.match(r.now, /^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
  await c.close();
});

test('a tool not built yet answers ok:false as a normal result, not a protocol error', async () => {
  const c = await client();
  const raw = await c.callTool({ name: 'book', arguments: { patient_id: 'x', start: '2026-12-01T09:00', visit_kind: 'filling' } });
  assert.notEqual((raw as { isError?: boolean }).isError, true);
  assert.deepEqual(text(raw), { ok: false, error: 'book is not built yet in the Ascend link' });
  await c.close();
});

test('no key or a wrong key is refused', async () => {
  for (const headers of [{}, { authorization: 'Bearer wrong-key-0123456789ab' }] as Record<string, string>[]) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal(r.status, 401);
  }
});

test('the practice day is Eastern', () => {
  assert.equal(practiceNow(new Date('2026-11-20T03:30:00Z')), '2026-11-19T22:30');
  assert.equal(practiceNow(new Date('2026-07-01T16:05:00Z')), '2026-07-01T12:05');
});
