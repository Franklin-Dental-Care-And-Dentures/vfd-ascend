// find_open_times and book (New Patient exam) against a fake Ascend: the sim's rules, and the read-back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { book, findOpenTimes, local, midnight, newAppointment, offerable, type Slot } from '../src/booking.ts';
import type { Caller } from '../src/patients.ts';

const NOW = Date.parse('2026-11-19T21:00:00Z');   // Thu 2026-11-19 16:00 Eastern
const at = (date: string, time: string) => midnight(date) + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60000;
const slot = (date: string, time: string, provider = 1, operatory = 50): Slot =>
  ({ start: at(date, time), end: at(date, time) + 1800000, operatory: { id: operatory, name: 'NEW PATIENTS' }, provider: { id: provider } });

test('local time and midnight are Eastern, across the DST change', () => {
  assert.deepEqual(local(at('2026-12-01', '08:30')), { date: '2026-12-01', time: '08:30', dow: 2 });
  assert.equal(new Date(midnight('2026-12-01')).toISOString(), '2026-12-01T05:00:00.000Z');
  assert.equal(new Date(midnight('2026-07-01')).toISOString(), '2026-07-01T04:00:00.000Z');
});

test('the rules: day 7 on, no Sunday, last start 16:00 weekday / 13:30 Saturday, Saturdays and Mondays first', () => {
  const got = offerable([
    slot('2026-11-25', '09:00'),          // day 6: too soon
    slot('2026-12-01', '08:30'),          // Tue day 12
    slot('2026-12-01', '16:30'),          // after 16:00
    slot('2026-12-05', '13:30'),          // Sat at the last start
    slot('2026-12-05', '14:00'),          // Sat after 13:30
    slot('2026-12-06', '09:00'),          // Sunday
    slot('2026-12-07', '09:00', 2),       // Mon day 18
    slot('2026-12-07', '09:00', 1),       // same start, the other doctor: one opening
    slot('2026-12-14', '09:00'),          // Mon day 25: past the aim, not first
  ], NOW, 'new_patient').map((x) => `${x.opening.start} ${x.opening.weekday} ${x.opening.days_out}`);
  assert.deepEqual(got, ['2026-12-05T13:30 Saturday 16', '2026-12-07T09:00 Monday 18', '2026-12-01T08:30 Tuesday 12',
    '2026-12-14T09:00 Monday 25']);
});

function fakeAscend(opts: { history?: unknown[]; mangle?: (a: any) => void } = {}) {
  const calls: string[] = [];
  let saved: any = null;
  const s: Caller = {
    async call(method, path, body) {
      calls.push(`${method} ${path.split('?')[0]}`);
      if (path === '/bootstrap/operatory') return { status: 200, json: [{ id: 49, name: 'SRP/FILLS' }, { id: 50, name: 'NEW PATIENTS' }] };
      if (path === '/bootstrap/provider') return { status: 200, json: [{ id: 1, isSchedulingEligible: true }, { id: 2, isSchedulingEligible: true }, { id: 3 }] };
      if (path === '/bootstrap/location') return { status: 200, json: [{ id: 700 }] };
      if (path.startsWith('/v3/availableAppointments')) {
        const q = new URLSearchParams(path.split('?')[1]);
        assert.equal(q.get('operatories'), '50');
        assert.equal(q.get('providers'), '1,2');
        const from = Number(q.get('startDate'));
        return { status: 200, json: { slots: [slot('2026-12-01', '08:30', 1), slot('2026-12-05', '09:00', 2)].filter((x) => x.start >= from) } };
      }
      if (path === '/patient/900') return { status: 200, json: { id: 900, relationships: { primaryContact: { id: 900 } } } };
      if (path.startsWith('/appointmentREST?patientId=900')) {
        if (!saved) return { status: 200, json: opts.history ?? [] };
        const a = { ...structuredClone(saved.appointment), id: 4242 };
        opts.mangle?.(a);
        return { status: 200, json: [a] };
      }
      if (method === 'POST' && path === '/appointmentREST/appointmentWithPatientLite') { saved = body; return { status: 200, json: {} }; }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { s, calls, saved: () => saved };
}

test('find_open_times gives the sim\'s openings, Saturday first; other kinds are not built yet', async () => {
  const f = fakeAscend();
  const r: any = await findOpenTimes(f.s, { visit_kind: 'new_patient' }, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.openings.map((o: any) => o.start), ['2026-12-05T09:00', '2026-12-01T08:30']);
  assert.deepEqual(await findOpenTimes(f.s, { visit_kind: 'filling' }, NOW),
    { ok: false, error: 'find_open_times for filling is not built yet in the Ascend link' });
  const am: any = await findOpenTimes(f.s, { visit_kind: 'new_patient', day: '2026-12-01', time_of_day: 'afternoon' }, NOW);
  assert.deepEqual(am.openings, []);
});

test('book: the slot the opening came from, the form\'s shape, then read back', async () => {
  const f = fakeAscend();
  const r = await book(f.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'new_patient' }, NOW);
  assert.deepEqual(r, { ok: true, appointment_id: '4242', start: '2026-12-05T09:00', visit_kind: 'new_patient' });
  const b = f.saved();
  assert.equal(b.isAppointmentEmpty, false);
  assert.deepEqual(b.patient, { id: 900 });
  assert.deepEqual(b.primaryContact, { id: 900 });
  assert.equal(b.appointment.startDateTime, at('2026-12-05', '09:00'));
  assert.equal(b.appointment.endDateTime - b.appointment.startDateTime, 1800000);
  assert.deepEqual([b.appointment.provider, b.appointment.operatory, b.appointment.location], [{ id: 2 }, { id: 50 }, { id: 700 }]);
  assert.equal(b.appointment.status, 'UNCONFIRMED');
});

// What Ascend's own Appointment model sent for a new New Patient visit (toJSON in the signed-in page, 16:20 ET).
const MODEL_JSON = {"startDateTime":1796149800000,"endDateTime":1796151600000,"duration":30,"provider":{"id":19000000026581},"operatory":{"id":19000000006656},"location":{"id":19000000000764},"patient":{"id":19000015200389},"patientLite":{"id":19000015200389},"id":"NEW","title":"Appointment","status":"UNCONFIRMED","procedures":[],"patientProcedures":[],"visits":[],"isAppointmentEmpty":false,"dueDates":[],"missedAppointments":[],"isLabCaseEnabled":false};

test("the visit is exactly what Ascend's own Appointment model sends", () => {
  const sl: Slot = { start: 1796149800000, end: 1796151600000, operatory: { id: 19000000006656 }, provider: { id: 19000000026581 } };
  assert.deepEqual(newAppointment(sl, 19000000000764, 19000015200389), MODEL_JSON);
});

test('book refuses an opening the rules do not allow, and waits on the strike count for a patient with history', async () => {
  const f = fakeAscend();
  assert.deepEqual(await book(f.s, { patient_id: '900', start: '2026-12-06T09:00', visit_kind: 'new_patient' }, NOW),
    { ok: false, refused: true, reason: 'not an opening the window and hours rules allow for this visit' });
  const g = fakeAscend({ history: [{ id: 1 }] });
  assert.deepEqual(await book(g.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'new_patient' }, NOW),
    { ok: false, error: 'booking a patient with visit history (the strike count) is not built yet in the Ascend link' });
  assert.ok(!f.calls.includes('POST /appointmentREST/appointmentWithPatientLite'));
  assert.ok(!g.calls.includes('POST /appointmentREST/appointmentWithPatientLite'));
});

test('a read-back that differs is not success', async () => {
  const f = fakeAscend({ mangle: (a) => { a.provider = { id: 1 }; } });
  const r: any = await book(f.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'new_patient' }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /read-back differs in: provider/);
});
