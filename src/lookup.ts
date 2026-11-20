// find_patient and strike_count, with the spec sim's rules and results (vfd-agent sim/spec_sim.py t_find_patient,
// _score, _card, t_strike_count; vfd_agent/specgen/patients.py strikes_in_force, year_after).
// - find_patient: at least two of full name, date of birth, phone; a record matches when two of them match.
//   Ascend: GET /patient/smartIndex?term (by last name and by phone), then each match's visits.
// - strike_count: No Show and Broken visits (Canceled by Office never counts, decision 1150); every strike since the
//   last strike-free 12 months (1751); a strike before the count-from day is not counted (1861: a setting,
//   VFD_STRIKES_COUNT_FROM, unset = every strike counts); a strike on February 29 clears on March 1 (1868); three
//   strikes in force block booking (1716). Ascend: GET /appointmentREST?patientId and /missedAppointment?patientIds.
// - the card's insurance and other_coverage: from the record (insurance.ts); treatment_plan and due: from the record,
//   named by the office's own recall lists (plan.ts, decision 2197). Nothing here prints or keeps patient data.
import { digits, dobFromEpoch, type Caller } from './patients.ts';
import { local } from './booking.ts';
import { coverage } from './insurance.ts';
import { planAndDue } from './plan.ts';

export const STRIKES_REFUSE = 3;
export const COUNT_FROM = process.env.VFD_STRIKES_COUNT_FROM ?? '';
const STRIKE = new Set(['NOSHOW', 'BROKEN']);
const UPCOMING: Record<string, string> = { UNCONFIRMED: 'Scheduled', CONFIRMED: 'Confirmed' };
const KIND_BY_COLUMN: Record<string, string> = { 'NEW PATIENTS': 'new_patient', EXTRA: 'limited' };

const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.trim() !== '' && a.trim().toLowerCase() === b.trim().toLowerCase();

export function dobOf(v: unknown): string | null {
  if (typeof v === 'number') return dobFromEpoch(v);
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

export function yearAfter(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  if (m === 2 && day === 29) return `${y + 1}-03-01`;
  return `${y + 1}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The count in force and the day the slate is clean, from the strike dates (YYYY-MM-DD).
export function strikesInForce(dates: string[], today: string, countFrom = ''): [number, string | null] {
  const ds = [...dates].filter((d) => !countFrom || d >= countFrom).sort();
  if (!ds.length || today >= yearAfter(ds[ds.length - 1])) return [0, null];
  let n = 1;
  while (n < ds.length && ds[ds.length - n] < yearAfter(ds[ds.length - n - 1])) n += 1;
  return [n, yearAfter(ds[ds.length - 1])];
}

const rowsOf = (j: any): any[] => (Array.isArray(j) ? j : j?.appointments ?? j?.missedAppointments ?? j?.results ?? []);

// The patient's missed visits that are strikes, one per visit, dated by the visit's day (Eastern).
export async function strikeDates(s: Caller, pid: string): Promise<string[]> {
  const a = rowsOf((await s.call('GET', `/appointmentREST?patientId=${pid}`)).json);
  const m = rowsOf((await s.call('GET', `/missedAppointment?patientIds=${pid}`)).json);
  const seen = new Map<string, string>();
  for (const r of [...a, ...m]) {
    if (!STRIKE.has(String(r?.status)) || typeof r?.startDateTime !== 'number') continue;
    seen.set(String(r.appointmentId ?? r.appointment?.id ?? r.id), local(r.startDateTime).date);
  }
  return [...seen.values()];
}

export async function strikeCount(s: Caller, a: Record<string, any>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const pid = String(a.patient_id ?? '');
  const p = /^\d+$/.test(pid) ? (await s.call('GET', `/patient/${pid}`)).json as any : null;
  if (!p?.id) return { ok: false, error: `no patient ${pid}` };
  const dates = await strikeDates(s, pid);
  const [n, until] = strikesInForce(dates, local(nowMs).date, COUNT_FROM);
  return { ok: true, count: n, blocked: n >= STRIKES_REFUSE, blocked_until: until && n >= STRIKES_REFUSE ? until : null,
    clean_slate_on: until, strikes: dates.sort().map((d) => ({ date: d })) };
}

async function card(s: Caller, r: any, nowMs: number) {
  const pid = String(r.id);
  const visits = rowsOf((await s.call('GET', `/appointmentREST?patientId=${pid}`)).json)
    .filter((v) => UPCOMING[v?.status] && typeof v?.startDateTime === 'number' && v.startDateTime > nowMs)
    .sort((x, y) => x.startDateTime - y.startDateTime);
  const cols = new Map<number, string>(((((await s.call('GET', '/bootstrap/operatory')).json) as any[]) ?? []).map((o) => [o.id, String(o.name ?? '')]));
  const cov = await coverage(s, pid, nowMs);
  const pd = await planAndDue(s, pid, nowMs);
  return {
    patient_id: pid, first_name: r.firstName, last_name: r.lastName, date_of_birth: dobOf(r.dateOfBirth),
    phone: r.phone ? digits(r.phone) : null, insurance: cov.insurance, other_coverage: cov.other_coverage,
    upcoming: visits.map((v) => { const t = local(v.startDateTime); const col = cols.get(v.operatory?.id) ?? '';
      return { id: String(v.id), start: `${t.date}T${t.time}`, visit_kind: KIND_BY_COLUMN[col] ?? null, column: col,
        status: UPCOMING[v.status], lab: Boolean(v.labCase) }; }),
    treatment_plan: pd.treatment_plan, due: pd.due,
  };
}

export async function findPatient(s: Caller, a: Record<string, any>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const name = Boolean(a.first_name && a.last_name);
  if (Number(name) + Number(Boolean(a.date_of_birth)) + Number(Boolean(a.phone)) < 2) {
    return { ok: false, error: 'give at least two of: full name, date of birth, phone' };
  }
  const terms = [name ? String(a.last_name).trim() : '', a.phone ? digits(a.phone) : ''].filter(Boolean);
  const rows = new Map<string, any>();
  for (const t of terms) {
    const q = new URLSearchParams({ term: t, startFrom: '0', showInactive: 'false' });
    for (const r of rowsOf((await s.call('GET', `/patient/smartIndex?${q}`)).json)) if (r?.id) rows.set(String(r.id), r);
  }
  const score = (r: any) => Number(same(r.firstName, a.first_name) && same(r.lastName, a.last_name))
    + Number(Boolean(a.date_of_birth) && dobOf(r.dateOfBirth) === String(a.date_of_birth).trim())
    + Number(Boolean(a.phone) && digits(r.phone) === digits(a.phone));
  const hits = [...rows.values()].filter((r) => score(r) >= 2);
  const matches = [];
  for (const r of hits) matches.push(await card(s, r, nowMs));
  return { ok: true, matches };
}
