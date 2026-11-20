// cancel, reschedule and set_status, with the spec sim's rules and results (vfd-agent sim/spec_sim.py _visit, _close,
// t_cancel, t_reschedule, t_set_status):
// - only an upcoming visit (Scheduled = UNCONFIRMED, Confirmed = CONFIRMED) is changed;
// - cancel: 24 hours' notice or more = Canceled by Office (CANCELLEDBYOFF, never a strike, decision 1150); under 24
//   hours = Broken, a strike, only with caller_confirmed after the caller has heard the policy and their count (1716,
//   1719);
// - reschedule: the visit kind stays; the old visit follows cancel's notice rule; under 24 hours a move that would make
//   the third strike is refused (2.2.2 step 4; with notice a visit is moved at three, 1862); the new start must be an
//   opening the rules allow for the kind. The link moves only a visit it would book itself (its column and length are
//   one of the four bookable kinds); anything else is refused, for a message to the front desk. The new visit is saved
//   and read back before the old one is closed, so a failed save never leaves the caller with no visit;
// - set_status: Confirmed only; a visit with a lab case is not confirmed until the case is in (2.2.4);
// - note_on_appointment: the caller's words added to the visit's note, after any note already there, marked as
//   Vida's; the same save as a status write with only the note changed, then read back.
// Ascend: GET /appointmentREST/{id} (the visit, with patientId and labCase when one is attached), then the status
// write of status.ts. Nothing here prints or keeps patient data.
import { KINDS, local, openings, place } from './booking.ts';
import { COUNT_FROM, STRIKES_REFUSE, strikeDates, strikesInForce } from './lookup.ts';
import type { Caller } from './patients.ts';
import { existingAppointmentJson, setStatus } from './status.ts';

export const NOTICE_HOURS = 24;
const UPCOMING: Record<string, string> = { UNCONFIRMED: 'Scheduled', CONFIRMED: 'Confirmed' };
const WORDS: Record<string, string> = { ...UPCOMING, NOSHOW: 'No Show', BROKEN: 'Broken', CANCELLEDBYOFF: 'Canceled by Office',
  COMPLETE: 'Complete' };
const REASON_CANCEL = 'Canceled by the patient on a call with Vida';
const REASON_MOVE = 'Moved by the patient on a call with Vida';

const refuse = (reason: string) => ({ ok: false, refused: true, reason });

// The visit kind of an existing visit, from its column and length; null when it is not one the link books.
export function kindOf(columnName: string, minutes: number): string | null {
  for (const [kind, k] of Object.entries(KINDS)) if (k.column.test(columnName.trim()) && k.minutes === minutes) return kind;
  return null;
}

async function visit(s: Caller, id: string): Promise<{ v?: any; err?: Record<string, unknown> }> {
  if (!/^\d+$/.test(id)) return { err: { ok: false, error: `no appointment ${id}` } };
  let v: any;
  try {
    v = (await s.call('GET', `/appointmentREST/${id}`)).json;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return { err: { ok: false, error: `no appointment ${id}` } };
    throw e;
  }
  if (!v?.id) return { err: { ok: false, error: `no appointment ${id}` } };
  if (!UPCOMING[v.status]) return { err: refuse(`the visit is ${WORDS[v.status] ?? v.status}, not an upcoming visit`) };
  return { v };
}

const patientOf = (v: any) => String(v.patientId ?? v.patient?.id ?? '');
const hoursBefore = (v: any, nowMs: number) => (v.startDateTime - nowMs) / 3600000;
const strikesNow = async (s: Caller, pid: string, nowMs: number) =>
  strikesInForce(await strikeDates(s, pid), local(nowMs).date, COUNT_FROM)[0];

export async function cancel(s: Caller, a: Record<string, any>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const { v, err } = await visit(s, String(a.appointment_id ?? ''));
  if (err) return err;
  const pid = patientOf(v);
  if (hoursBefore(v, nowMs) >= NOTICE_HOURS) {
    const r = await setStatus(s, pid, String(v.id), 'CANCELLEDBYOFF', REASON_CANCEL, nowMs);
    return r.ok ? { ok: true, status: 'Canceled by Office', strike_added: false } : r;
  }
  if (!a.caller_confirmed) {
    return { ok: false, needs_confirmation: true, under_24_hours: true, strike_count: await strikesNow(s, pid, nowMs) };
  }
  const r = await setStatus(s, pid, String(v.id), 'BROKEN', REASON_CANCEL, nowMs);
  return r.ok ? { ok: true, status: 'Broken', strike_added: true, strike_count: await strikesNow(s, pid, nowMs) } : r;
}

export async function reschedule(s: Caller, a: Record<string, any>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const { v, err } = await visit(s, String(a.appointment_id ?? ''));
  if (err) return err;
  const pid = patientOf(v);
  const under = hoursBefore(v, nowMs) < NOTICE_HOURS;
  const n = await strikesNow(s, pid, nowMs);
  if (under && !a.caller_confirmed) return { ok: false, needs_confirmation: true, under_24_hours: true, strike_count: n };
  if (under && n + 1 >= STRIKES_REFUSE) return refuse('three strikes reached: no new booking (2.2.2 step 4)');
  const cols = new Map<number, string>((((await s.call('GET', '/bootstrap/operatory')).json as any[]) ?? []).map((o) => [o.id, String(o.name ?? '')]));
  const kind = kindOf(cols.get(v.operatory?.id) ?? '', Number(v.duration));
  if (!kind) return refuse('not a visit the link moves: a message for the front desk');
  const { col, found } = await openings(s, kind, false, nowMs);
  const match = found.find((x) => x.opening.start === a.new_start);
  if (!match) return refuse('not an opening the window and hours rules allow for this visit');

  const p = (await s.call('GET', `/patient/${pid}`)).json as any;
  const made = await place(s, p, match.slot, col.minutes);
  if (!made.ok) return made;
  const status = under ? 'BROKEN' : 'CANCELLEDBYOFF';
  const closed = await setStatus(s, pid, String(v.id), status, REASON_MOVE, nowMs);
  if (!closed.ok) {
    return { ok: false, error: `the new visit was booked, but the old one was not closed: ${closed.error}`, appointment_id: made.appointment_id };
  }
  return { ok: true, old_status: WORDS[status], strike_added: under, appointment_id: made.appointment_id, start: a.new_start,
    visit_kind: kind };
}

export async function confirm(s: Caller, a: Record<string, any>, nowMs = Date.now()): Promise<Record<string, unknown>> {
  const { v, err } = await visit(s, String(a.appointment_id ?? ''));
  if (err) return err;
  if (a.status !== 'Confirmed') return refuse('the agent may only set Confirmed');
  if (v.labCase) return refuse('a visit that waits on the lab is not confirmed until the case is in (2.2.4)');
  const r = await setStatus(s, patientOf(v), String(v.id), 'CONFIRMED', '', nowMs);
  return r.ok ? { ok: true, status: 'Confirmed' } : r;
}

export const NOTE_MARK = 'Vida: ';

export async function noteOnAppointment(s: Caller, a: Record<string, any>): Promise<Record<string, unknown>> {
  const { v, err } = await visit(s, String(a.appointment_id ?? ''));
  if (err) return err;
  const words = String(a.note ?? '').trim();
  if (!words) return { ok: false, error: 'note is empty' };
  const note = `${v.note ? `${v.note}\n` : ''}${NOTE_MARK}${words}`;
  const pid = patientOf(v);
  const p = (await s.call('GET', `/patient/${pid}`)).json as any;
  await s.call('POST', '/appointmentREST/appointmentWithPatientLite', { isAppointmentEmpty: false,
    appointment: { ...existingAppointmentJson(v), note }, patient: { id: Number(pid) },
    primaryContact: { id: p?.relationships?.primaryContact?.id ?? Number(pid) } });
  const back = (await s.call('GET', `/appointmentREST/${v.id}`)).json as any;
  if (back?.note !== note) return { ok: false, error: 'saved, but the note was not found on read-back' };
  if (back?.status !== v.status) return { ok: false, error: 'saved, but the visit status changed on read-back' };
  return { ok: true };
}
