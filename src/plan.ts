// The patient card's treatment_plan and due, in the spec sim's terms (vfd-agent sim/spec_sim.py _card; engine
// forks.Record: Plan = the unbooked treatment-plan visits as visit kinds, the next one first; Due = '', 'cleaning'
// or 'srp'), read from the patient's Ascend record and named only by the office's own Ascend recall lists
// (decision 2197): a planned procedure is a filling only when its code is on the office's Fillings list, an
// extraction only when it is on the extraction list, and so on. A planned visit with any procedure on none of those
// lists is OFF_LIST: Vida books nothing for it and takes a message for the front desk (2197).
//
// Ascend's calls, as its own page makes them (CHECK 51562, proven on the made-up Test Testerson):
// - GET /recare/list: the office's recall lists, each {type, procedures[] {adaCode}} (practice setup).
// - GET /patient/{id}/treatment2/procedures: rows {id, status (TREATMENT_PLAN = Planned), code, txCaseId, visitId,
//   appointmentId, serviceDate}; a planned procedure on an appointment is already booked and is left out.
// - GET /patient/{id}/treatment2/case (rows {id, name, optionStatus}: a Rejected case is left out) and
//   /treatment2/visit (rows {id, caseId, visitIndex}), read only when a planned procedure sits in a case or visit.
//   Order as Ascend shows it: unassigned procedures first (Ascend sorts the Unassigned case first), then cases by
//   name, then visits by visitIndex.
// - GET /patient/{id}/recare/: rows {type, dueDate, appointmentId, scheduled}. Due = the earliest PROPHY (cleaning)
//   or SRP row whose due day has come and that no appointment holds.
// Nothing here prints or keeps patient data.
import type { Caller } from './patients.ts';
import { local } from './booking.ts';

export const OFF_LIST = 'other';

// The office's recall lists that name a Vida visit kind (the names on record, decision 1849).
export const KIND_BY_LIST: Record<string, string> = {
  Fillings: 'filling', extraction: 'extraction', PROPHY: 'cleaning', SRP: 'srp',
  'crown prep': 'crown', 'crown seat': 'seat', delivery: 'delivery',
};
export const DUE_BY_LIST: Record<string, string> = { PROPHY: 'cleaning', SRP: 'srp' };

const rows = (j: unknown): any[] => (Array.isArray(j) ? j : []);

// Procedure code -> visit kind, from the office's lists. A code on two lists with different kinds names neither.
export function kindsByCode(lists: any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lists) {
    const k = KIND_BY_LIST[String(l?.type ?? '')];
    if (!k) continue;
    for (const p of rows(l?.procedures)) {
      const c = String(p?.adaCode ?? '').trim();
      if (!c) continue;
      m.set(c, m.has(c) && m.get(c) !== k ? OFF_LIST : k);
    }
  }
  return m;
}

const cmp = (a: unknown, b: unknown): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'en', { numeric: true });

// The unbooked planned visits as visit kinds, the next one first.
export function planKinds(procs: any[], cases: any[], visits: any[], byCode: Map<string, string>): string[] {
  const rejected = new Set(cases.filter((c) => String(c?.optionStatus ?? '').toUpperCase() === 'REJECTED').map((c) => String(c.id)));
  const caseName = new Map(cases.map((c) => [String(c.id), String(c?.name ?? '')]));
  const visitIndex = new Map(visits.map((v) => [String(v.id), Number(v?.visitIndex ?? 0)]));
  const groups = new Map<string, any[]>();
  for (const p of procs) {
    if (p?.status !== 'TREATMENT_PLAN' || p.appointmentId != null) continue;
    if (p.txCaseId != null && rejected.has(String(p.txCaseId))) continue;
    const key = p.visitId != null ? `v${p.visitId}` : `p${p.id}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }
  const rank = (g: any[]): unknown[] => {
    const p = g[0];
    const inCase = p.txCaseId != null;
    return [inCase ? 1 : 0, inCase ? caseName.get(String(p.txCaseId)) ?? '' : '',
      p.visitId != null ? visitIndex.get(String(p.visitId)) ?? 0 : 0,
      Math.min(...g.map((x) => Number(x.serviceDate ?? 0))), Math.min(...g.map((x) => Number(x.id ?? 0)))];
  };
  return [...groups.values()].map((g) => ({ g, r: rank(g) }))
    .sort((a, b) => { for (let i = 0; i < a.r.length; i++) { const d = cmp(a.r[i], b.r[i]); if (d) return d; } return 0; })
    .map(({ g }) => {
      const ks = new Set(g.map((p) => byCode.get(String(p?.code ?? '').trim()) ?? OFF_LIST));
      return ks.size === 1 ? [...ks][0] : OFF_LIST;
    });
}

// The recall due: the earliest cleaning or SRP whose due day has come and no appointment holds; else null.
export function dueKind(recare: any[], today: string): string | null {
  const due = recare.filter((r) => DUE_BY_LIST[String(r?.type ?? '')] && typeof r?.dueDate === 'number'
    && r.appointmentId == null && r.scheduled == null && local(r.dueDate).date <= today)
    .sort((a, b) => a.dueDate - b.dueDate);
  return due.length ? DUE_BY_LIST[String(due[0].type)] : null;
}

export async function planAndDue(s: Caller, pid: string, nowMs: number):
    Promise<{ treatment_plan: string[]; due: string | null }> {
  const byCode = kindsByCode(rows((await s.call('GET', '/recare/list')).json));
  const procs = rows((await s.call('GET', `/patient/${pid}/treatment2/procedures`)).json);
  const open = procs.filter((p) => p?.status === 'TREATMENT_PLAN' && p.appointmentId == null);
  const cases = open.some((p) => p.txCaseId != null) ? rows((await s.call('GET', `/patient/${pid}/treatment2/case`)).json) : [];
  const visits = open.some((p) => p.visitId != null) ? rows((await s.call('GET', `/patient/${pid}/treatment2/visit`)).json) : [];
  const recare = rows((await s.call('GET', `/patient/${pid}/recare/`)).json);
  return { treatment_plan: planKinds(procs, cases, visits, byCode), due: dueKind(recare, local(nowMs).date) };
}
