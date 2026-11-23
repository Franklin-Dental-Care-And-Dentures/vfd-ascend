// find_open_times and book, with the spec sim's rules and results (vfd-agent sim/spec_sim.py _offerable,
// t_find_open_times, t_book): no Sundays; last start 16:00 on a weekday and 13:30 on a Saturday (decision 1147); a
// registered patient in pain gets a Limited visit in days 0-6, the earliest first (1735, 1708); every other visit from
// day 7, days 7-21 the aim and a later day only when none of them is open (1077, 1842); a New Patient exam's Saturdays
// and Mondays in days 7-21 first (1708, 1079); the opening to offer first at the top.
//
// Where each visit goes (decisions 2188, 2191, 1729): a New Patient exam in NEW PATIENTS, 30 minutes, on Dr. Taj's
// openings and any open doctor's only when she has none (Dr. Rai); a Limited visit in EXTRA, 30 minutes; a filling in
// SRP/FILLS, 30 minutes; an extraction in SRP/FILLS, 60 minutes; either open doctor for those three. Cleanings, SRP,
// crowns, partials, dentures, seats and deliveries are a message this release, never a booking (1812).
//
// book refuses, in the sim's order: a visit that is a message; a record without one of the five plans alone, unless
// the visit is the self-pay New Patient exam (1864, 1865); three strikes in force (1716); a patient this link has just
// registered, unless the visit is the New Patient exam (1708); a patient under 16 never seen here (1725, 2251); a start
// that is not an opening the rules allow.
//
// Under 16 (decisions 1725, 2251, 2252): a registered patient under 16 who has been seen here before (a past visit
// marked Complete) gets Dr. Rai's openings only, from find_open_times and book; one never seen is not booked.
//
// Ascend's calls: GET /bootstrap/operatory and /bootstrap/provider (ids, read at call time), GET
// /v3/availableAppointments (dates as epoch ms, lists comma-joined, as Ascend's Search for Openings sends them),
// POST /appointmentREST/appointmentWithPatientLite with { isAppointmentEmpty, appointment, patient, primaryContact }
// (the shape Ascend's appointment editor saves; appointment = the Appointment model's own toJSON), then GET
// /appointmentREST?patientId to read the visit back. Nothing here prints or keeps patient data.
import { CREATED, ageOn, type Caller } from './patients.ts';
import { coverage, insuranceAllows } from './insurance.ts';
import { COUNT_FROM, STRIKES_REFUSE, dobOf, strikeDates, strikesInForce } from './lookup.ts';

export const TZ = 'America/New_York';
export const WINDOW_FIRST_DAY = 7;
export const WINDOW_AIM_LAST_DAY = 21;
export const WINDOW_SEARCH_LAST_DAY = 60;
export const WEEKDAY_LAST_START = '16:00';
export const SATURDAY_LAST_START = '13:30';
export const NOON = '12:00';
export const PAIN_LAST_DAY = 6;
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
export function offerable(slots: Slot[], nowMs: number, kind: string, inPain = false): { opening: Opening; slot: Slot }[] {
  const today = local(nowMs).date;
  const seen = new Set<string>();
  const out: [boolean, string, { opening: Opening; slot: Slot }][] = [];
  for (const s of [...slots].sort((a, b) => a.start - b.start)) {
    const { date, time, dow } = local(s.start);
    const start = `${date}T${time}`;
    const off = daysBetween(today, date);
    const last = dow === 6 ? SATURDAY_LAST_START : WEEKDAY_LAST_START;
    const inside = kind === 'limited' && inPain ? off >= 0 && off <= PAIN_LAST_DAY : off >= WINDOW_FIRST_DAY;
    if (dow === 0 || time > last || s.start <= nowMs || !inside || seen.has(start)) continue;
    seen.add(start);   // one opening per start time; the first slot (by Ascend's order) is the one booked
    const first = kind === 'new_patient' && (dow === 6 || dow === 1) && off <= WINDOW_AIM_LAST_DAY;
    out.push([!first, start, { opening: { start, date, time, weekday: WEEKDAYS[dow], days_out: off }, slot: s }]);
  }
  out.sort((a, b) => (Number(a[0]) - Number(b[0])) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return out.map((x) => x[2]);
}

// Dr. Rai (decision 2188): new patients go to Dr. Taj; the doctor is found by last name among the bookable ones.
export const NEW_PATIENT_DOCTOR = /^taj$/i;

// Under 16 (decisions 1725, 2251, 2252): seen before -> Dr. Rai's openings only, never another doctor's; never seen ->
// no booking. The doctor is found by last name among the bookable ones, as Dr. Taj is.
export const MINOR_AGE = 16;
export const MINOR_DOCTOR = /^rai$/i;
export const UNDER_16_NOT_SEEN = 'under 16 and never seen here: not booked (decisions 1725, 2251)';

export type Kind = { column: RegExp; minutes: number; doctor?: RegExp };
export const KINDS: Record<string, Kind> = {
  new_patient: { column: /^new patients?$/i, minutes: 30, doctor: NEW_PATIENT_DOCTOR },
  limited: { column: /^extra$/i, minutes: 30 },
  filling: { column: /^srp\/fills$/i, minutes: 30 },
  extraction: { column: /^srp\/fills$/i, minutes: 60 },
};
export const MESSAGE_ONLY = ['cleaning', 'srp', 'crown', 'partial', 'denture', 'seat', 'delivery'];
export const VISIT_KINDS = [...Object.keys(KINDS), ...MESSAGE_ONLY];

type Column = { operatory: number; providers: number[]; preferred?: number; minutes: number };

async function columnAndDoctors(s: Caller, kind: string, only?: RegExp): Promise<Column> {
  const k = KINDS[kind];
  const ops: any[] = (await s.call('GET', '/bootstrap/operatory')).json as any[] ?? [];
  const col = ops.filter((o) => k.column.test(String(o.name ?? '').trim()));
  if (col.length !== 1) throw new Error(`expected one ${k.column.source} column, found ${col.length}`);
  const provs: any[] = (await s.call('GET', '/bootstrap/provider')).json as any[] ?? [];
  const named = (re: RegExp) => (p: any) => re.test(String(p.lastName ?? '').trim());
  const eligible = provs.filter((p) => p.isSchedulingEligible);
  const providers = (only ? eligible.filter(named(only)) : eligible).map((p) => p.id);
  if (!providers.length) throw new Error(only ? `no bookable doctor matching ${only.source} in Ascend` : 'no bookable doctor in Ascend');
  const pick = !only && k.doctor ? eligible.find(named(k.doctor)) : undefined;
  return { operatory: col[0].id, providers, preferred: pick ? pick.id : undefined, minutes: k.minutes };
}

async function slotsBetween(s: Caller, col: Column, from: string, to: string): Promise<Slot[]> {
  const q = new URLSearchParams({ startDate: String(midnight(from)), endDate: String(midnight(addDays(to, 1)) - 1),
    preferredTimes: 'EARLYMORNING,LATEMORNING,EARLYAFTERNOON,LATEAFTERNOON',
    preferredDays: 'MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY', duration: String(col.minutes),
    operatories: String(col.operatory), providers: col.providers.join(',') });
  const r = await s.call('GET', `/v3/availableAppointments?${q}`);
  return (((r.json as any)?.slots ?? []) as Slot[])
    .filter((x) => x?.operatory?.id === col.operatory && col.providers.includes(x?.provider?.id));
}

// The openings for a visit kind; a New Patient exam's on Dr. Taj's first, any open doctor's only when she has none.
// only: one doctor's openings and no other's (a patient under 16, Dr. Rai).
export async function openings(s: Caller, kind: string, inPain: boolean, nowMs: number, only?: RegExp) {
  const col = await columnAndDoctors(s, kind, only);
  if (col.preferred !== undefined) {
    const hers = await search(s, { ...col, providers: [col.preferred] }, kind, inPain, nowMs);
    if (hers.length) return { col, found: hers };
  }
  return { col, found: await search(s, col, kind, inPain, nowMs) };
}

// A pain Limited: days 0-6 only. Every other visit: days 7-21; when none is open there, the earliest after day 21
// (searched to day 60).
async function search(s: Caller, col: Column, kind: string, inPain: boolean, nowMs: number) {
  const today = local(nowMs).date;
  if (kind === 'limited' && inPain) return offerable(await slotsBetween(s, col, today, addDays(today, PAIN_LAST_DAY)), nowMs, kind, true);
  let found = offerable(await slotsBetween(s, col, addDays(today, WINDOW_FIRST_DAY), addDays(today, WINDOW_AIM_LAST_DAY)), nowMs, kind);
  if (!found.length) {
    found = offerable(await slotsBetween(s, col, addDays(today, WINDOW_AIM_LAST_DAY + 1), addDays(today, WINDOW_SEARCH_LAST_DAY)), nowMs, kind);
  }
  return found;
}

export function newAppointment(slot: Slot, location: number, patient: number, minutes = 30) {
  return {
    startDateTime: slot.start, endDateTime: slot.start + minutes * 60000, duration: minutes,
    provider: { id: slot.provider.id }, operatory: { id: slot.operatory.id }, location: { id: location },
    patient: { id: patient }, patientLite: { id: patient }, id: 'NEW', title: 'Appointment', status: 'UNCONFIRMED',
    procedures: [], patientProcedures: [], visits: [], isAppointmentEmpty: false, dueDates: [], missedAppointments: [],
    isLabCaseEnabled: false,
  };
}

const kindError = () => ({ ok: false, error: `visit_kind must be one of ${VISIT_KINDS.join(', ')}` });
const refuse = (reason: string) => ({ ok: false, refused: true, reason });
const messageOnly = (kind: string) => refuse(`${kind} is a message in this release, not a booking (decision 1812)`);

export async function findOpenTimes(s: Caller, a: Record<string, any>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  if (!VISIT_KINDS.includes(a.visit_kind)) return kindError();
  if (MESSAGE_ONLY.includes(a.visit_kind)) return messageOnly(a.visit_kind);
  // A registered patient under 16 seen before: Dr. Rai's openings only. One never seen is refused at book, not here,
  // so moving a visit staff already booked goes on as before.
  let only: RegExp | undefined;
  const pid = String(a.patient_id ?? '');
  if (/^\d+$/.test(pid)) {
    const p = (await s.call('GET', `/patient/${pid}`)).json as any;
    if (p?.id && (await minorRule(s, p, nowMs)) === 'only') only = MINOR_DOCTOR;
  }
  let opens = (await openings(s, a.visit_kind, Boolean(a.in_pain), nowMs, only)).found.map((x) => x.opening);
  if (a.day) opens = opens.filter((o) => o.date === a.day);
  if (a.time_of_day === 'morning') opens = opens.filter((o) => o.time < NOON);
  else if (a.time_of_day === 'afternoon') opens = opens.filter((o) => o.time >= NOON);
  return { ok: true, openings: opens };
}

const rowsOf = (j: any): any[] => (Array.isArray(j) ? j : j?.appointments ?? []);

// Seen here before: a past visit marked Complete.
export function seenBefore(visits: any[], nowMs: number): boolean {
  return visits.some((v) => v?.status === 'COMPLETE' && typeof v?.startDateTime === 'number' && v.startDateTime < nowMs);
}

// The under-16 rule for a registered patient: 'any' doctor (16 or older, or no date of birth on the record), Dr. Rai
// 'only' (under 16 and seen before), or 'not_seen' (under 16 and never seen: no booking).
export async function minorRule(s: Caller, p: any, nowMs: number): Promise<'any' | 'only' | 'not_seen'> {
  const dob = dobOf(p?.dateOfBirth);
  if (!dob || ageOn(dob.split('-').map(Number) as [number, number, number], local(nowMs).date) >= MINOR_AGE) return 'any';
  return seenBefore(rowsOf((await s.call('GET', `/appointmentREST?patientId=${p.id}`)).json), nowMs) ? 'only' : 'not_seen';
}

// Save one visit at a slot exactly as Ascend's own Appointment model sends a new one (its toJSON, read in the
// signed-in page at 16:20 ET 2026-11-19: a fuller body with the read-only flags got HTTP 500 and saved nothing), then
// read it back. The rules are book's; this is only the write.
export async function place(s: Caller, p: any, slot: Slot, minutes: number): Promise<Record<string, unknown>> {
  const pid = String(p.id);
  const loc = ((await s.call('GET', '/bootstrap/location')).json as any[]) ?? [];
  if (loc.length !== 1) return { ok: false, error: `expected one Ascend location, found ${loc.length}` };
  const appointment = newAppointment(slot, loc[0].id, p.id, minutes);
  const body = { isAppointmentEmpty: false, appointment, patient: { id: p.id },
    primaryContact: { id: p.relationships?.primaryContact?.id ?? p.id } };
  // A canceled or missed visit stays in the list at its old start, so the new one is the row that was not there before.
  const had = new Set(rowsOf((await s.call('GET', `/appointmentREST?patientId=${pid}`)).json).map((x) => String(x.id)));
  await s.call('POST', '/appointmentREST/appointmentWithPatientLite', body);

  const list = rowsOf((await s.call('GET', `/appointmentREST?patientId=${pid}`)).json);
  const got = list.find((x) => !had.has(String(x.id)) && x.startDateTime === slot.start && x.operatory?.id === slot.operatory.id);
  if (!got) return { ok: false, error: 'saved, but the visit was not found on read-back' };
  const bad = [['provider', got.provider?.id, slot.provider.id], ['duration', got.duration, minutes],
    ['status', got.status, 'UNCONFIRMED']].filter(([, x, y]) => x !== y).map(([n]) => n);
  if (bad.length) return { ok: false, error: `saved, but the read-back differs in: ${bad.join(', ')}`, appointment_id: String(got.id) };
  return { ok: true, appointment_id: String(got.id) };
}

export async function book(s: Caller, a: Record<string, any>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const pid = String(a.patient_id ?? '');
  const p = /^\d+$/.test(pid) ? (await s.call('GET', `/patient/${pid}`)).json as any : null;
  if (!p?.id) return { ok: false, error: `no patient ${pid}` };
  const kind = a.visit_kind;
  if (!VISIT_KINDS.includes(kind)) return kindError();
  if (MESSAGE_ONLY.includes(kind)) return messageOnly(kind);
  if (!insuranceAllows(await coverage(s, pid, nowMs), kind)) {
    return refuse('the record shows something other than one of the five plans alone: the self-pay visit only (decisions 1864, 1865)');
  }
  if (strikesInForce(await strikeDates(s, pid), local(nowMs).date, COUNT_FROM)[0] >= STRIKES_REFUSE) {
    return refuse('three strikes in force: no booking (decision 1716)');
  }
  if (CREATED.has(pid) && kind !== 'new_patient') return refuse('a new patient is booked for the New Patient exam only (1708)');
  const minor = await minorRule(s, p, nowMs);
  if (minor === 'not_seen') return refuse(UNDER_16_NOT_SEEN);

  const { col, found } = await openings(s, kind, Boolean(a.in_pain), nowMs, minor === 'only' ? MINOR_DOCTOR : undefined);
  const match = found.find((x) => x.opening.start === a.start);
  if (!match) return refuse('not an opening the window and hours rules allow for this visit');
  const r = await place(s, p, match.slot, col.minutes);
  return r.ok ? { ok: true, appointment_id: r.appointment_id, start: a.start, visit_kind: kind } : r;
}
