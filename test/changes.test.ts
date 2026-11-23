// cancel, reschedule and set_status against a fake Ascend, with the sim's rules and results.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { midnight } from '../src/booking.ts';
import { cancel, confirm, kindOf, noteOnAppointment, reschedule } from '../src/changes.ts';
import type { Caller } from '../src/patients.ts';

const NOW = Date.parse('2026-11-19T21:00:00Z');   // Thu 2026-11-19 16:00 Eastern
const at = (date: string, time: string) => midnight(date) + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60000;
const COLS = [{ id: 47, name: 'EXTRA' }, { id: 49, name: 'SRP/FILLS' }, { id: 50, name: 'NEW PATIENTS' }, { id: 51, name: 'CROWN PREP' }];
const v = (id: number, op: number, start: number, duration: number, status = 'UNCONFIRMED', extra = {}) =>
  ({ id, version: 1, patientId: 900, patient: { id: 900 }, operatory: { id: op }, provider: { id: 1 }, location: { id: 700 },
    startDateTime: start, endDateTime: start + duration * 60000, duration, status, ...extra });

// Visit 73 (No Show) is one strike in force; strikes adds more before it.
function fake(opts: { strikes?: number; dob?: number; seen?: boolean; rai?: boolean } = {}) {
  const writes: string[] = [];
  let n = 5000;
  const visits = new Map<number, any>([
    [71, v(71, 49, at('2026-12-01', '09:00'), 60)],                    // extraction, 12 days out
    [72, v(72, 47, at('2026-11-20', '09:00'), 30)],                    // limited, 17 hours out
    [73, v(73, 49, at('2026-11-10', '09:00'), 30, 'NOSHOW')],
    [74, v(74, 51, at('2026-12-02', '09:00'), 30)],                    // crown prep: not a link visit
    [75, v(75, 49, at('2026-12-03', '09:00'), 30, 'CONFIRMED', { labCase: { id: 1 } })],
    ...(opts.seen ? [[76, v(76, 49, at('2026-10-01', '09:00'), 30, 'COMPLETE')]] as [number, any][] : []),
  ]);
  const missed: any[] = Array.from({ length: opts.strikes ?? 0 }, (_, i) =>
    ({ id: 90 + i, appointmentId: 900 + i, status: 'NOSHOW', startDateTime: at(`2026-0${i + 3}-02`, '09:00') }));
  const s: Caller = {
    async call(method, path, body: any) {
      const m = /^\/appointmentREST\/(\d+)$/.exec(path);
      if (method === 'GET' && m) {
        if (!visits.has(Number(m[1]))) throw Object.assign(new Error(`GET ${path}: HTTP 404`), { status: 404 });
        return { status: 200, json: structuredClone(visits.get(Number(m[1]))) };
      }
      if (path.startsWith('/appointmentREST?patientId=900')) return { status: 200, json: [...visits.values()].map((x) => structuredClone(x)) };
      if (path.startsWith('/missedAppointment?patientIds=900')) return { status: 200, json: missed };
      if (path === '/patient/900') return { status: 200, json: { id: 900, ...(opts.dob === undefined ? {} : { dateOfBirth: opts.dob }), relationships: { primaryContact: { id: 900 } } } };
      if (path === '/bootstrap/operatory') return { status: 200, json: COLS };
      if (path === '/bootstrap/provider') return { status: 200, json: [{ id: 1, lastName: 'Rai', isSchedulingEligible: true }, { id: 2, lastName: 'Taj', isSchedulingEligible: true }] };
      if (path === '/bootstrap/location') return { status: 200, json: [{ id: 700 }] };
      if (path.startsWith('/v3/availableAppointments')) {
        const q = new URLSearchParams(path.split('?')[1]);
        const op = Number(q.get('operatories')), from = Number(q.get('startDate')), to = Number(q.get('endDate'));
        const d = Number(q.get('duration'));
        const provs = (q.get('providers') ?? '').split(',').map(Number);
        const all = [at('2026-11-23', '10:00'), at('2026-12-04', '10:00'), at('2026-12-08', '14:00')]
          .map((t) => ({ start: t, end: t + d * 60000, operatory: { id: op }, provider: { id: 2 } }));
        if (opts.rai) all.push({ start: at('2026-12-04', '10:00'), end: at('2026-12-04', '10:00') + d * 60000, operatory: { id: op }, provider: { id: 1 } });
        return { status: 200, json: { slots: all.filter((x) => x.start >= from && x.start <= to && provs.includes(x.provider.id)) } };
      }
      if (method === 'POST' && path === '/appointmentREST/appointmentWithPatientLite') {
        const a = body.appointment;
        if (a.id === 'NEW') { n += 1; visits.set(n, { ...a, id: n, patientId: 900 }); writes.push(`new ${n} op ${a.operatory.id} ${a.duration} min`); }
        else {
          const was = visits.get(a.id);
          visits.set(a.id, { ...was, status: a.status, ...(a.note !== undefined ? { note: a.note } : {}) });
          writes.push(a.note !== was.note ? `note ${a.id}` : `status ${a.id} ${a.status}`);
          if (body.missedAppointment) missed.push({ id: 100 + missed.length, appointmentId: a.id, status: a.status, startDateTime: a.startDateTime });
        }
        return { status: 200, json: {} };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { s, writes, visits };
}

test('the visit kind of an existing visit: only the four the link books', () => {
  assert.equal(kindOf('NEW PATIENTS', 30), 'new_patient');
  assert.equal(kindOf('EXTRA', 30), 'limited');
  assert.equal(kindOf('SRP/FILLS', 30), 'filling');
  assert.equal(kindOf('SRP/FILLS', 60), 'extraction');
  assert.equal(kindOf('SRP/FILLS', 90), null);
  assert.equal(kindOf('CROWN PREP', 30), null);
});

test('cancel: 24 hours or more is Canceled by Office, no strike', async () => {
  const f = fake();
  assert.deepEqual(await cancel(f.s, { appointment_id: '71' }, NOW), { ok: true, status: 'Canceled by Office', strike_added: false });
  assert.deepEqual(f.writes, ['status 71 CANCELLEDBYOFF']);
});

test('cancel: under 24 hours needs the caller to confirm, then Broken and a strike', async () => {
  const f = fake();
  assert.deepEqual(await cancel(f.s, { appointment_id: '72' }, NOW), { ok: false, needs_confirmation: true, under_24_hours: true, strike_count: 1 });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await cancel(f.s, { appointment_id: '72', caller_confirmed: true }, NOW),
    { ok: true, status: 'Broken', strike_added: true, strike_count: 2 });
  assert.deepEqual(f.writes, ['status 72 BROKEN']);
});

test('only an upcoming visit is changed; an unknown id is an error', async () => {
  const f = fake();
  const noShow = { ok: false, refused: true, reason: 'the visit is No Show, not an upcoming visit' };
  assert.deepEqual(await cancel(f.s, { appointment_id: '73' }, NOW), noShow);
  assert.deepEqual(await reschedule(f.s, { appointment_id: '73', new_start: '2026-12-04T10:00' }, NOW), noShow);
  assert.deepEqual(await confirm(f.s, { appointment_id: '73', status: 'Confirmed' }, NOW), noShow);
  assert.deepEqual(await cancel(f.s, { appointment_id: '99' }, NOW), { ok: false, error: 'no appointment 99' });
  assert.deepEqual(await cancel(f.s, { appointment_id: 'x' }, NOW), { ok: false, error: 'no appointment x' });
  assert.deepEqual(f.writes, []);
});

test('reschedule with notice: the same kind at a new opening, saved before the old visit is closed', async () => {
  const f = fake();
  assert.deepEqual(await reschedule(f.s, { appointment_id: '71', new_start: '2026-12-04T10:00' }, NOW),
    { ok: true, old_status: 'Canceled by Office', strike_added: false, appointment_id: '5001', start: '2026-12-04T10:00', visit_kind: 'extraction' });
  assert.deepEqual(f.writes, ['new 5001 op 49 60 min', 'status 71 CANCELLEDBYOFF']);
});

test('reschedule under 24 hours: confirm first; Broken; refused when it would be the third strike', async () => {
  const f = fake();
  assert.deepEqual(await reschedule(f.s, { appointment_id: '72', new_start: '2026-12-04T10:00' }, NOW),
    { ok: false, needs_confirmation: true, under_24_hours: true, strike_count: 1 });
  const r: any = await reschedule(f.s, { appointment_id: '72', new_start: '2026-12-04T10:00', caller_confirmed: true }, NOW);
  assert.deepEqual([r.ok, r.old_status, r.strike_added, r.visit_kind], [true, 'Broken', true, 'limited']);
  assert.deepEqual(f.writes, ['new 5001 op 47 30 min', 'status 72 BROKEN']);
  const g = fake({ strikes: 1 });
  assert.deepEqual(await reschedule(g.s, { appointment_id: '72', new_start: '2026-12-04T10:00', caller_confirmed: true }, NOW),
    { ok: false, refused: true, reason: 'three strikes reached: no new booking (2.2.2 step 4)' });
  // with notice, a visit is moved at two strikes in force (1862)
  assert.equal(((await reschedule(g.s, { appointment_id: '71', new_start: '2026-12-04T10:00' }, NOW)) as any).ok, true);
});

test('reschedule refuses a visit the link does not book, and a start that is not an opening', async () => {
  const f = fake();
  assert.deepEqual(await reschedule(f.s, { appointment_id: '74', new_start: '2026-12-04T10:00' }, NOW),
    { ok: false, refused: true, reason: 'not a visit the link moves: a message for the front desk' });
  assert.deepEqual(await reschedule(f.s, { appointment_id: '71', new_start: '2026-11-23T10:00' }, NOW),
    { ok: false, refused: true, reason: 'not an opening the window and hours rules allow for this visit' });
  assert.deepEqual(f.writes, []);
});

test('set_status: Confirmed only, and not while a lab case is attached', async () => {
  const f = fake();
  assert.deepEqual(await confirm(f.s, { appointment_id: '71', status: 'Confirmed' }, NOW), { ok: true, status: 'Confirmed' });
  assert.deepEqual(f.writes, ['status 71 CONFIRMED']);
  assert.deepEqual(await confirm(f.s, { appointment_id: '74', status: 'Canceled' }, NOW),
    { ok: false, refused: true, reason: 'the agent may only set Confirmed' });
  assert.deepEqual(await confirm(f.s, { appointment_id: '75', status: 'Confirmed' }, NOW),
    { ok: false, refused: true, reason: 'a visit that waits on the lab is not confirmed until the case is in (2.2.4)' });
});

test('note_on_appointment: the caller\'s words after any note there, marked as Vida\'s, status unchanged', async () => {
  const f = fake();
  assert.deepEqual(await noteOnAppointment(f.s, { appointment_id: '72', note: 'Pain lower left since Monday.' }), { ok: true });
  assert.equal(f.visits.get(72).note, 'Vida: Pain lower left since Monday.');
  assert.deepEqual(await noteOnAppointment(f.s, { appointment_id: '72', note: 'Running 10 minutes late.' }), { ok: true });
  assert.equal(f.visits.get(72).note, 'Vida: Pain lower left since Monday.\nVida: Running 10 minutes late.');
  assert.equal(f.visits.get(72).status, 'UNCONFIRMED');
  assert.deepEqual(f.writes, ['note 72', 'note 72']);
  assert.deepEqual(await noteOnAppointment(f.s, { appointment_id: '72', note: '  ' }), { ok: false, error: 'note is empty' });
  assert.deepEqual(await noteOnAppointment(f.s, { appointment_id: '73', note: 'x' }),
    { ok: false, refused: true, reason: 'the visit is No Show, not an upcoming visit' });
});

// Decision 2253: a patient under 16 seen before moves only to one of Dr. Rai's openings; one never seen moves as before.
test("reschedule for a patient under 16 seen before: Dr. Rai's openings only", async () => {
  const KID = Date.parse('2012-01-01T00:00:00Z');   // 14 on 2026-11-19
  const f = fake({ dob: KID, seen: true, rai: true });
  const r: any = await reschedule(f.s, { appointment_id: '71', new_start: '2026-12-04T10:00' }, NOW);
  assert.equal(r.ok, true);
  assert.equal(f.visits.get(Number(r.appointment_id)).provider.id, 1);
  const g = fake({ dob: KID, seen: true, rai: true });
  const t: any = await reschedule(g.s, { appointment_id: '71', new_start: '2026-12-08T14:00' }, NOW);   // Dr. Taj's only
  assert.equal(t.refused, true);
  assert.deepEqual(g.writes, []);
  const h = fake({ dob: KID });
  assert.equal(((await reschedule(h.s, { appointment_id: '71', new_start: '2026-12-08T14:00' }, NOW)) as any).ok, true);
});
