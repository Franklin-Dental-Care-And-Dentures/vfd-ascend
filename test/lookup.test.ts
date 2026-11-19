// find_patient and strike_count against a fake Ascend, with the sim's rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dobOf, findPatient, strikeCount, strikesInForce, yearAfter } from '../src/lookup.ts';
import { midnight } from '../src/booking.ts';
import type { Caller } from '../src/patients.ts';

const NOW = Date.parse('2026-11-19T21:00:00Z');
const day = (d: string, h = 10) => midnight(d) + h * 3600000;

test('the strike rules: 12 strike-free months clear the slate, the count-from day, February 29', () => {
  assert.equal(yearAfter('2025-02-28'), '2026-02-28');
  assert.equal(yearAfter('2024-02-29'), '2025-03-01');
  assert.deepEqual(strikesInForce([], '2026-11-19'), [0, null]);
  assert.deepEqual(strikesInForce(['2025-11-20'], '2026-11-19'), [1, '2026-11-20']);
  assert.deepEqual(strikesInForce(['2025-11-19'], '2026-11-19'), [0, null]);
  // a chain: each strike under 12 months after the one before keeps the older one in force
  assert.deepEqual(strikesInForce(['2024-01-10', '2024-12-01', '2025-11-01'], '2026-11-19'), [0, null]);
  assert.deepEqual(strikesInForce(['2025-01-10', '2025-12-01', '2026-11-01'], '2026-11-19'), [3, '2027-11-01']);
  assert.deepEqual(strikesInForce(['2024-06-01', '2025-12-01', '2026-11-01'], '2026-11-19'), [2, '2027-11-01']);
  assert.deepEqual(strikesInForce(['2025-01-10', '2025-12-01', '2026-11-01'], '2026-11-19', '2025-06-01'), [2, '2027-11-01']);
});

test('dates of birth as Ascend gives them: epoch, ISO or MM/DD/YYYY', () => {
  assert.equal(dobOf(315532800000), '1980-01-01');
  assert.equal(dobOf('1980-01-01T00:00:00Z'), '1980-01-01');
  assert.equal(dobOf('1/1/1980'), '1980-01-01');
  assert.equal(dobOf(null), null);
});

function fake(opts: { visits?: any[]; missed?: any[] } = {}) {
  const calls: string[] = [];
  const s: Caller = {
    async call(method, path) {
      calls.push(`${method} ${path}`);
      if (path.startsWith('/patient/smartIndex')) {
        const t = new URLSearchParams(path.split('?')[1]).get('term');
        const rows = [{ id: 900, firstName: 'Test', lastName: 'Testerson', dateOfBirth: 315532800000, phone: '5135551111' },
          { id: 901, firstName: 'Tess', lastName: 'Testerson', dateOfBirth: 315619200000, phone: '5135552222' }];
        return { status: 200, json: rows.filter((r) => r.lastName === t || r.phone === t) };
      }
      if (path === '/patient/900') return { status: 200, json: { id: 900 } };
      if (path.startsWith('/appointmentREST?patientId=900')) return { status: 200, json: opts.visits ?? [] };
      if (path.startsWith('/missedAppointment?patientIds=900')) return { status: 200, json: opts.missed ?? [] };
      if (path === '/bootstrap/operatory') return { status: 200, json: [{ id: 50, name: 'NEW PATIENTS' }, { id: 49, name: 'SRP/FILLS' }] };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { s, calls };
}

test('find_patient: two of name, birth date, phone; a card with upcoming visits; fields not read named', async () => {
  const f = fake({ visits: [
    { id: 7, status: 'UNCONFIRMED', startDateTime: day('2026-12-05', 14), operatory: { id: 50 } },
    { id: 8, status: 'COMPLETE', startDateTime: day('2026-10-01'), operatory: { id: 49 } },
    { id: 9, status: 'CONFIRMED', startDateTime: day('2026-12-10', 15), operatory: { id: 49 } }] });
  assert.deepEqual(await findPatient(f.s, { last_name: 'Testerson', phone: '5135551111' }, NOW),
    { ok: false, error: 'give at least two of: full name, date of birth, phone' });
  const r: any = await findPatient(f.s, { first_name: 'test', last_name: 'TESTERSON', phone: '(513) 555-1111' }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.matches.length, 1);
  const c = r.matches[0];
  assert.equal(c.patient_id, '900');
  assert.equal(c.date_of_birth, '1980-01-01');
  assert.deepEqual(c.upcoming.map((u: any) => [u.id, u.start, u.visit_kind, u.status]),
    [['7', '2026-12-05T14:00', 'new_patient', 'Scheduled'], ['9', '2026-12-10T15:00', null, 'Confirmed']]);
  assert.deepEqual(c.not_read, ['insurance', 'other_coverage', 'treatment_plan', 'due']);
  const byDob: any = await findPatient(f.s, { first_name: 'Test', last_name: 'Testerson', date_of_birth: '1980-01-01' }, NOW);
  assert.deepEqual(byDob.matches.map((m: any) => m.patient_id), ['900']);
});

test('strike_count: No Show and Broken count once each; Canceled by Office never', async () => {
  const f = fake({
    visits: [{ id: 1, status: 'NOSHOW', startDateTime: day('2026-03-02') }, { id: 2, status: 'COMPLETE', startDateTime: day('2026-04-01') }],
    missed: [{ id: 11, appointmentId: 1, status: 'NOSHOW', startDateTime: day('2026-03-02') },
      { id: 12, appointmentId: 3, status: 'BROKEN', startDateTime: day('2026-06-10') },
      { id: 13, appointmentId: 4, status: 'CANCELLEDBYOFF', startDateTime: day('2026-07-10') }] });
  const r: any = await strikeCount(f.s, { patient_id: '900' }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.blocked, false);
  assert.equal(r.clean_slate_on, '2027-06-10');
  assert.deepEqual(r.strikes, [{ date: '2026-03-02' }, { date: '2026-06-10' }]);
  assert.deepEqual(await strikeCount(fake().s, { patient_id: '900' }, NOW),
    { ok: true, count: 0, blocked: false, blocked_until: null, clean_slate_on: null, strikes: [] });
});
