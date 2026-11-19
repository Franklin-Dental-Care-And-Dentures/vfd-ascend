// find_open_times and book for the New Patient exam, the first visit kind built (decision 2185: the NEW PATIENTS
// column, whichever doctor the open time belongs to). The rules and results are the spec sim's (vfd-agent
// sim/spec_sim.py _offerable, t_find_open_times, t_book): no Sundays; last start 16:00 on a weekday and 13:30 on a
// Saturday (decision 1147); from day 7, days 7-21 the aim and a later day only when none of them is open (1077, 1842);
// a New Patient exam's Saturdays and Mondays in days 7-21 first (1708, 1079); the opening to offer first at the top.
//
// Ascend's calls: GET /bootstrap/operatory and /bootstrap/provider (ids, read at call time), GET
// /v3/availableAppointments (dates as epoch ms, lists comma-joined, as Ascend's Search for Openings sends them),
// POST /appointmentREST/appointmentWithPatientLite with { isAppointmentEmpty, appointment, patient, primaryContact }
// (the shape Ascend's appointment editor saves), then GET /appointmentREST?patientId to read the visit back.
// Other visit kinds, and booking a patient who has any visit history (the strike count is not built yet), answer
// "not built yet". Nothing here prints or keeps patient data.
import type { Caller } from './patients.ts';

export const TZ = 'America/New_York';
export const WINDOW_FIRST_DAY = 7;
export const WINDOW_AIM_LAST_DAY = 21;
export const WINDOW_SEARCH_LAST_DAY = 60;
export const WEEKDAY_LAST_START = '16:00';
export const SATURDAY_LAST_START = '13:30';
export const NOON = '12:00';
const DURATION = 30;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export type Slot = { start: number; end: number; operatory: { id: number; name?: string }; provider: { id: number } };
export type Opening = { start: string; date: string; time: string; weekday: string; days_out: number };

// Epoch ms -> the practice's local date, time and weekday.
export function local(ms: number): { date: string; time: string; dow: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(ms))
    .map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

// Midnight at the start of a practice-local date, as epoch ms (Eastern, DST-safe to the hour).
export function midnight(date: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  for (const h of [4, 5]) { const t = guess + h * 3600000; if (local(t).time === '00:00' && local(t).date === date) return t; }
  throw new Error(`no midnight for ${date}`);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// The rules over Ascend's open slots: the openings to offer, first at the top, each with the slot it came from.
export function offerable(slots: Slot[], nowMs: number, kind: string): { opening: Opening; slot: Slot }[] {
  const today = local(nowMs).date;
  const seen = new Set<string>();
  const out: [boolean, string, { opening: Opening; slot: Slot }][] = [];
  for (const s of [...slots].sort((a, b) => a.start - b.start)) {
    const { date, time, dow } = local(s.start);
    const start = `${date}T${time}`;
    const off = daysBetween(today, date);
    const last = dow === 6 ? SATURDAY_LAST_START : WEEKDAY_LAST_START;
    if (dow === 0 || time > last || s.start <= nowMs || off < WINDOW_FIRST_DAY || seen.has(start)) continue;
    seen.add(start);   // one opening per start time; the first slot (by Ascend's order) is the one booked
    const first = kind === 'new_patient' && (dow === 6 || dow === 1) && off <= WINDOW_AIM_LAST_DAY;
    out.push([!first, start, { opening: { start, date, time, weekday: WEEKDAYS[dow], days_out: off }, slot: s }]);
  }
  out.sort((a, b) => (Number(a[0]) - Number(b[0])) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return out.map((x) => x[2]);
}

async function columnAndDoctors(s: Caller): Promise<{ operatory: number; providers: number[] }> {
  const ops: any[] = (await s.call('GET', '/bootstrap/operatory')).json as any[] ?? [];
  const np = ops.filter((o) => /^new patients?$/i.test(String(o.name ?? '').trim()));
  if (np.length !== 1) throw new Error(`expected one NEW PATIENTS column, found ${np.length}`);
  const provs: any[] = (await s.call('GET', '/bootstrap/provider')).json as any[] ?? [];
  const providers = provs.filter((p) => p.isSchedulingEligible).map((p) => p.id);
  if (!providers.length) throw new Error('no bookable doctor in Ascend');
  return { operatory: np[0].id, providers };
}

async function slotsBetween(s: Caller, col: { operatory: number; providers: number[] }, from: string, to: string): Promise<Slot[]> {
  const q = new URLSearchParams({ startDate: String(midnight(from)), endDate: String(midnight(addDays(to, 1)) - 1),
    preferredTimes: 'EARLYMORNING,LATEMORNING,EARLYAFTERNOON,LATEAFTERNOON',
    preferredDays: 'MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY', duration: String(DURATION),
    operatories: String(col.operatory), providers: col.providers.join(',') });
  const r = await s.call('GET', `/v3/availableAppointments?${q}`);
  return (((r.json as any)?.slots ?? []) as Slot[]).filter((x) => x?.operatory?.id === col.operatory);
}

// Openings in days 7-21; when none is open there, the earliest after day 21 (searched to day 60).
async function openings(s: Caller, kind: string, nowMs: number) {
  const col = await columnAndDoctors(s);
  const today = local(nowMs).date;
  let found = offerable(await slotsBetween(s, col, addDays(today, WINDOW_FIRST_DAY), addDays(today, WINDOW_AIM_LAST_DAY)), nowMs, kind);
  if (!found.length) {
    found = offerable(await slotsBetween(s, col, addDays(today, WINDOW_AIM_LAST_DAY + 1), addDays(today, WINDOW_SEARCH_LAST_DAY)), nowMs, kind);
  }
  return found;
}

const notBuilt = (what: string) => ({ ok: false, error: `${what} is not built yet in the Ascend link` });

export async function findOpenTimes(s: Caller, a: Record<string, any>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  if (a.visit_kind !== 'new_patient') return notBuilt(`find_open_times for ${a.visit_kind}`);
  let opens = (await openings(s, a.visit_kind, nowMs)).map((x) => x.opening);
  if (a.day) opens = opens.filter((o) => o.date === a.day);
  if (a.time_of_day === 'morning') opens = opens.filter((o) => o.time < NOON);
  else if (a.time_of_day === 'afternoon') opens = opens.filter((o) => o.time >= NOON);
  return { ok: true, openings: opens };
}

export async function book(s: Caller, a: Record<string, any>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  if (a.visit_kind !== 'new_patient') return notBuilt(`book for ${a.visit_kind}`);
  const pid = String(a.patient_id ?? '');
  if (!/^\d+$/.test(pid)) return { ok: false, error: `no patient ${pid}` };
  const p = (await s.call('GET', `/patient/${pid}`)).json as any;
  if (!p?.id) return { ok: false, error: `no patient ${pid}` };
  const hist = (await s.call('GET', `/appointmentREST?patientId=${pid}`)).json as any;
  const before: any[] = Array.isArray(hist) ? hist : hist?.appointments ?? [];
  if (before.length) return notBuilt('booking a patient with visit history (the strike count)');

  const match = (await openings(s, a.visit_kind, nowMs)).find((x) => x.opening.start === a.start);
  if (!match) {
    return { ok: false, refused: true, reason: 'not an opening the window and hours rules allow for this visit' };
  }
  const loc = ((await s.call('GET', '/bootstrap/location')).json as any[]) ?? [];
  if (loc.length !== 1) return { ok: false, error: `expected one Ascend location, found ${loc.length}` };
  const slot = match.slot;
  const appointment = {
    startDateTime: slot.start, endDateTime: slot.start + DURATION * 60000, duration: DURATION,
    provider: { id: slot.provider.id }, operatory: { id: slot.operatory.id }, location: { id: loc[0].id },
    status: 'UNCONFIRMED', confirmed: null, needsFollowup: false, ASAP: false, needsPremedicate: false, pinned: false,
    bookedOnline: false, note: '', other: '', title: '', reason: '', productionAmount: 0,
    patient: { id: p.id }, patientLite: { id: p.id }, patientId: p.id,
    visits: [], patientProcedures: [], procedures: [], communications: [], dueDates: [], missedAppointments: [],
    isPatientFailed: false, isLabCaseEnabled: false, isAppointmentEmpty: false,
  };
  const body = { isAppointmentEmpty: false, appointment, patient: { id: p.id },
    primaryContact: { id: p.relationships?.primaryContact?.id ?? p.id } };
  await s.call('POST', '/appointmentREST/appointmentWithPatientLite', body);

  const after = (await s.call('GET', `/appointmentREST?patientId=${pid}`)).json as any;
  const list: any[] = Array.isArray(after) ? after : after?.appointments ?? [];
  const got = list.find((x) => x.startDateTime === slot.start && x.operatory?.id === slot.operatory.id);
  if (!got) return { ok: false, error: 'saved, but the visit was not found on read-back' };
  const bad = [['provider', got.provider?.id, slot.provider.id], ['duration', got.duration, DURATION],
    ['status', got.status, 'UNCONFIRMED']].filter(([, x, y]) => x !== y).map(([n]) => n);
  if (bad.length) return { ok: false, error: `saved, but the read-back differs in: ${bad.join(', ')}`, appointment_id: String(got.id) };
  return { ok: true, appointment_id: String(got.id), start: a.start, visit_kind: a.visit_kind };
}
