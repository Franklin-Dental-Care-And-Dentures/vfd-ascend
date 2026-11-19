// The tools Vida's engine calls, exactly as the spec sim serves them (contract/sim-tool-schemas.json, exported from
// vfd-agent sim/spec_sim.py), plus sim_clock as the practice's now. Results are JSON text; a refusal or an error is
// an {"ok": false, ...} result, never a protocol error, as in the sim.
//
// Each Ascend tool is switched on here only once it is built and proven on made-up test patients (decision 2166);
// until then it answers "not built yet".
import { readFileSync } from 'node:fs';
import { TZ } from './config.ts';
import { book, findOpenTimes } from './booking.ts';
import { findPatient, strikeCount } from './lookup.ts';
import { createPatient, type Caller, type NewPatient } from './patients.ts';

export type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type Result = Record<string, unknown>;
export type Handler = (args: Record<string, unknown>, meta: { caller_id?: string }) => Promise<Result>;

type ContractTool = { function: { name: string; description: string; parameters: Record<string, unknown> } };
const contract: { tools: ContractTool[] } =
  JSON.parse(readFileSync(new URL('../contract/sim-tool-schemas.json', import.meta.url), 'utf8'));

export const ASCEND_TOOLS: Tool[] = contract.tools.map((t) => ({
  name: t.function.name, description: t.function.description, inputSchema: t.function.parameters,
}));

export const SIM_CLOCK: Tool = {
  name: 'sim_clock',
  description: "The practice's now (YYYY-MM-DDTHH:MM, Eastern).",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const TOOLS: Tool[] = [...ASCEND_TOOLS, SIM_CLOCK];

// The practice's now, to the minute, in Eastern time.
export function practiceNow(d = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export const HANDLERS = new Map<string, Handler>([
  ['sim_clock', async () => ({ now: practiceNow() })],
]);

// Switch on the Ascend tools that are built and proven, over the one signed-in session.
export function useAscend(s: Caller): void {
  HANDLERS.set('create_patient', async (a) => createPatient(s, a as unknown as NewPatient, practiceNow().slice(0, 10)));
  HANDLERS.set('find_open_times', async (a) => findOpenTimes(s, a));
  HANDLERS.set('book', async (a) => book(s, a));
  HANDLERS.set('find_patient', async (a) => findPatient(s, a));
  HANDLERS.set('strike_count', async (a) => strikeCount(s, a));
}

export async function callTool(name: string, args: Record<string, unknown>, meta: { caller_id?: string } = {}):
    Promise<Result> {
  const h = HANDLERS.get(name);
  if (h) return h(args, meta);
  if (ASCEND_TOOLS.some((t) => t.name === name)) {
    return { ok: false, error: `${name} is not built yet in the Ascend link` };
  }
  return { ok: false, error: `unknown tool ${name}` };
}
