// find_open_times and book against a fake Ascend: the sim's rules, each visit kind's column and length, the refusals
// in the sim's order, and the read-back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNDER_16_NOT_SEEN, book, findOpenTimes, local, midnight, newAppointment, offerable, type Slot } from '../src/booking.ts';
import { CREATED, type Caller } from '../src/patients.ts';

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

test('a registered patient in pain: a Limited visit in days 0-6, the earliest first; not in pain, from day 7', () => {
  const slots = [slot('2026-11-19', '15:30'), slot('2026-11-20', '09:00'), slot('2026-11-21', '13:30'),
    slot('2026-11-22', '09:00'), slot('2026-11-25', '16:00'), slot('2026-11-26', '09:00'), slot('2026-12-01', '08:30')];
  const pain = offerable(slots, NOW, 'limited', true).map((x) => `${x.opening.start} ${x.opening.days_out}`);
  assert.deepEqual(pain, ['2026-11-20T09:00 1', '2026-11-21T13:30 2', '2026-11-25T16:00 6']);
  assert.deepEqual(offerable(slots, NOW, 'limited').map((x) => x.opening.start), ['2026-11-26T09:00', '2026-12-01T08:30']);
  assert.deepEqual(offerable(slots, NOW, 'filling', true).map((x) => x.opening.start), ['2026-11-26T09:00', '2026-12-01T08:30']);
});

const COLUMNS = [{ id: 47, name: 'EXTRA' }, { id: 49, name: 'SRP/FILLS' }, { id: 50, name: 'NEW PATIENTS' }, { id: 51, name: 'CROWN PREP' }];
const COL_NAME: Record<number, string> = { 47: 'EXTRA', 49: 'SRP/FILLS', 50: 'NEW PATIENTS' };
const CARRIERS = [
  { name: 'CareSource OH Medicaid (Delta) [DOS Beginning 1/1/2026]', carrierInsurancePlans: [{ id: 301, planName: 'OHIO CareSource Medicaid adult' }] },
  { name: 'DentaQuest', carrierInsurancePlans: [{ id: 302, planName: 'Humana Healthy Horizon' }, { id: 303, planName: 'OHIO Amerihealth Medicaid Adult' }] },
  { name: 'Delta Dental of Ohio', carrierInsurancePlans: [{ id: 304, planName: 'PPO' }] },
];
const plan = (cip: number, order = 1, endDate?: number) =>
  ({ subscriberInsurancePlan: { carrierInsurancePlan: { id: cip } }, responsibilities: [{ paymentResponsibilityOrder: order }], ...(endDate ? { endDate } : {}) });
const CARESOURCE = [plan(301)];

type Opts = { history?: unknown[]; missed?: unknown[]; mangle?: (a: any) => void; tajSlots?: boolean; plans?: unknown[];
  dob?: number; providers?: unknown[] };
function fakeAscend(opts: Opts = {}) {
  const calls: string[] = [];
  const asked: { operatory: string; duration: string; providers: string; from: string }[] = [];
  let saved: any = null;
  const s: Caller = {
    async call(method, path, body) {
      calls.push(`${method} ${path.split('?')[0]}`);
      if (path === '/bootstrap/operatory') return { status: 200, json: COLUMNS };
      if (path === '/bootstrap/provider') return { status: 200, json: opts.providers ?? [{ id: 1, lastName: 'Rai', isSchedulingEligible: true }, { id: 2, lastName: 'Taj', isSchedulingEligible: true }, { id: 3, lastName: 'Taj' }] };
      if (path === '/bootstrap/location') return { status: 200, json: [{ id: 700 }] };
      if (path === '/bootstrap/insuranceCarrier') return { status: 200, json: CARRIERS };
      if (path === '/patientInsurancePlanREST/900') return { status: 200, json: opts.plans ?? CARESOURCE };
      if (path.startsWith('/missedAppointment?patientIds=900')) return { status: 200, json: opts.missed ?? [] };
      if (path.startsWith('/v3/availableAppointments')) {
        const q = new URLSearchParams(path.split('?')[1]);
        const op = Number(q.get('operatories'));
        const from = Number(q.get('startDate'));
        const to = Number(q.get('endDate'));
        const provs = (q.get('providers') ?? '').split(',').map(Number);
        asked.push({ operatory: COL_NAME[op], duration: q.get('duration')!, providers: q.get('providers')!, from: local(from).date });
        const all = [slot('2026-11-20', '09:00', 1, op), slot('2026-11-23', '14:00', 2, op), slot('2026-12-01', '08:30', 1, op),
          slot('2026-12-03', '10:00', 1, op), ...(opts.tajSlots === false ? [] : [slot('2026-12-05', '09:00', 2, op)])];
        return { status: 200, json: { slots: all.filter((x) => x.start >= from && x.start <= to && provs.includes(x.provider.id)) } };
      }
      if (path === '/patient/900') return { status: 200, json: { id: 900, ...(opts.dob === undefined ? {} : { dateOfBirth: opts.dob }), relationships: { primaryContact: { id: 900 } } } };
      if (path.startsWith('/appointmentREST?patientId=900')) {
        if (!saved) return { status: 200, json: opts.history ?? [] };
        const a = { ...structuredClone(saved.appointment), id: 4242 };
        opts.mangle?.(a);
        return { status: 200, json: [...(opts.history ?? []), a] };
      }
      if (method === 'POST' && path === '/appointmentREST/appointmentWithPatientLite') { saved = body; return { status: 200, json: {} }; }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { s, calls, asked, saved: () => saved };
}
const posted = (f: { calls: string[] }) => f.calls.includes('POST /appointmentREST/appointmentWithPatientLite');

test("find_open_times: a New Patient exam gets Dr. Taj's openings in NEW PATIENTS", async () => {
  const f = fakeAscend();
  const r: any = await findOpenTimes(f.s, { visit_kind: 'new_patient' }, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.openings.map((o: any) => o.start), ['2026-12-05T09:00']);
  assert.deepEqual(f.asked[0], { operatory: 'NEW PATIENTS', duration: '30', providers: '2', from: '2026-11-26' });
  const am: any = await findOpenTimes(f.s, { visit_kind: 'new_patient', day: '2026-12-01', time_of_day: 'afternoon' }, NOW);
  assert.deepEqual(am.openings, []);
});

test('find_open_times: each kind in its column and length, either doctor; a message kind is refused', async () => {
  const f = fakeAscend();
  const pain: any = await findOpenTimes(f.s, { visit_kind: 'limited', in_pain: true }, NOW);
  assert.deepEqual(pain.openings.map((o: any) => o.start), ['2026-11-20T09:00', '2026-11-23T14:00']);
  assert.deepEqual(f.asked.at(-1), { operatory: 'EXTRA', duration: '30', providers: '1,2', from: '2026-11-19' });
  const fill: any = await findOpenTimes(f.s, { visit_kind: 'filling' }, NOW);
  assert.deepEqual(fill.openings.map((o: any) => o.start), ['2026-12-01T08:30', '2026-12-03T10:00', '2026-12-05T09:00']);
  assert.deepEqual(f.asked.at(-1), { operatory: 'SRP/FILLS', duration: '30', providers: '1,2', from: '2026-11-26' });
  await findOpenTimes(f.s, { visit_kind: 'extraction', in_pain: true }, NOW);
  assert.deepEqual(f.asked.at(-1), { operatory: 'SRP/FILLS', duration: '60', providers: '1,2', from: '2026-11-26' });
  assert.deepEqual(await findOpenTimes(f.s, { visit_kind: 'crown' }, NOW),
    { ok: false, refused: true, reason: 'crown is a message in this release, not a booking (decision 1812)' });
  assert.equal(((await findOpenTimes(f.s, { visit_kind: 'whitening' }, NOW)) as any).ok, false);
});

test("book: the slot the opening came from, the form's shape, then read back", async () => {
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

test('book: a pain Limited in EXTRA, a filling at 30 and an extraction at 60 in SRP/FILLS, with visit history', async () => {
  const hist = [{ id: 1, status: 'COMPLETE', startDateTime: at('2026-10-01', '09:00') }];
  const lim = fakeAscend({ history: hist });
  assert.deepEqual(await book(lim.s, { patient_id: '900', start: '2026-11-20T09:00', visit_kind: 'limited', in_pain: true }, NOW),
    { ok: true, appointment_id: '4242', start: '2026-11-20T09:00', visit_kind: 'limited' });
  assert.deepEqual([lim.saved().appointment.operatory, lim.saved().appointment.duration, lim.saved().appointment.provider], [{ id: 47 }, 30, { id: 1 }]);
  const fill = fakeAscend({ history: hist });
  assert.equal(((await book(fill.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'filling' }, NOW)) as any).ok, true);
  assert.deepEqual([fill.saved().appointment.operatory, fill.saved().appointment.duration], [{ id: 49 }, 30]);
  const ext = fakeAscend({ history: hist });
  assert.equal(((await book(ext.s, { patient_id: '900', start: '2026-12-03T10:00', visit_kind: 'extraction' }, NOW)) as any).ok, true);
  const e = ext.saved().appointment;
  assert.deepEqual([e.operatory, e.duration, e.endDateTime - e.startDateTime], [{ id: 49 }, 60, 3600000]);
  // a pain Limited is not booked from day 7 on, nor a filling in days 0-6
  const late = fakeAscend();
  assert.equal(((await book(late.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'limited', in_pain: true }, NOW)) as any).refused, true);
  assert.equal(((await book(late.s, { patient_id: '900', start: '2026-11-20T09:00', visit_kind: 'filling' }, NOW)) as any).refused, true);
  assert.ok(!posted(late));
});

const INSURANCE = 'the record shows something other than one of the five plans alone: the self-pay visit only (decisions 1864, 1865)';

test('book: anything but one of the five plans alone books only the self-pay New Patient exam', async () => {
  for (const plans of [[], [plan(304)], [plan(301), plan(302, 2)], [plan(301, 1, at('2026-01-01', '00:00'))]]) {
    const f = fakeAscend({ plans });
    assert.deepEqual(await book(f.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'filling' }, NOW),
      { ok: false, refused: true, reason: INSURANCE });
    assert.ok(!posted(f));
    const np = fakeAscend({ plans });
    assert.equal(((await book(np.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'new_patient' }, NOW)) as any).ok, true);
  }
  const ok = fakeAscend({ plans: [plan(303), plan(304, 2, at('2026-06-01', '00:00'))] });   // the second has ended
  assert.equal(((await book(ok.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'filling' }, NOW)) as any).ok, true);
});

test("book refuses in the sim's order: message, insurance, three strikes, just registered, not an opening", async () => {
  const f = fakeAscend({ plans: [] });
  assert.deepEqual(await book(f.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'denture' }, NOW),
    { ok: false, refused: true, reason: 'denture is a message in this release, not a booking (decision 1812)' });
  assert.equal(((await book(f.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'whitening' }, NOW)) as any).ok, false);
  assert.deepEqual(await book(f.s, { patient_id: 'x', start: '2026-12-01T08:30', visit_kind: 'filling' }, NOW), { ok: false, error: 'no patient x' });
  const strikes = [at('2026-03-02', '09:00'), at('2026-06-10', '09:00'), at('2026-10-01', '09:00')]
    .map((t, i) => ({ id: 10 + i, appointmentId: i, status: i === 1 ? 'BROKEN' : 'NOSHOW', startDateTime: t }));
  const three = fakeAscend({ missed: strikes });
  for (const kind of ['filling', 'new_patient']) {
    assert.deepEqual(await book(three.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: kind }, NOW),
      { ok: false, refused: true, reason: 'three strikes in force: no booking (decision 1716)' });
  }
  const two = fakeAscend({ missed: strikes.slice(1) });
  assert.equal(((await book(two.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'filling' }, NOW)) as any).ok, true);
  CREATED.add('900');
  try {
    const n = fakeAscend();
    assert.deepEqual(await book(n.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'filling' }, NOW),
      { ok: false, refused: true, reason: 'a new patient is booked for the New Patient exam only (1708)' });
    assert.equal(((await book(n.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'new_patient' }, NOW)) as any).ok, true);
  } finally { CREATED.delete('900'); }
  const g = fakeAscend();
  assert.deepEqual(await book(g.s, { patient_id: '900', start: '2026-12-06T09:00', visit_kind: 'new_patient' }, NOW),
    { ok: false, refused: true, reason: 'not an opening the window and hours rules allow for this visit' });
  assert.ok(![f, three, g].some(posted));
});

// What Ascend's own Appointment model sent for a new New Patient visit (toJSON in the signed-in page, 16:20 ET).
const MODEL_JSON = {"startDateTime":1796149800000,"endDateTime":1796151600000,"duration":30,"provider":{"id":19000000026581},"operatory":{"id":19000000006656},"location":{"id":19000000000764},"patient":{"id":19000015200389},"patientLite":{"id":19000015200389},"id":"NEW","title":"Appointment","status":"UNCONFIRMED","procedures":[],"patientProcedures":[],"visits":[],"isAppointmentEmpty":false,"dueDates":[],"missedAppointments":[],"isLabCaseEnabled":false};

test("the visit is exactly what Ascend's own Appointment model sends", () => {
  const sl: Slot = { start: 1796149800000, end: 1796151600000, operatory: { id: 19000000006656 }, provider: { id: 19000000026581 } };
  assert.deepEqual(newAppointment(sl, 19000000000764, 19000015200389), MODEL_JSON);
  assert.deepEqual(newAppointment(sl, 19000000000764, 19000015200389, 60), { ...MODEL_JSON, endDateTime: 1796149800000 + 3600000, duration: 60 });
});

test("when Dr. Taj has no opening, any open doctor's, Saturdays and Mondays first then earliest", async () => {
  const f = fakeAscend({ tajSlots: false });
  const r: any = await findOpenTimes(f.s, { visit_kind: 'new_patient' }, NOW);
  assert.deepEqual(r.openings.map((o: any) => o.start), ['2026-12-01T08:30', '2026-12-03T10:00']);
});

test('a canceled visit at the same start and column is not taken for the new one on read-back', async () => {
  const f = fakeAscend({ history: [{ id: 1, status: 'CANCELLEDBYOFF', startDateTime: at('2026-12-05', '09:00'), operatory: { id: 50 }, provider: { id: 2 }, duration: 30 }] });
  assert.deepEqual(await book(f.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'new_patient' }, NOW),
    { ok: true, appointment_id: '4242', start: '2026-12-05T09:00', visit_kind: 'new_patient' });
});

test('a read-back that differs is not success', async () => {
  const f = fakeAscend({ mangle: (a) => { a.provider = { id: 1 }; } });
  const r: any = await book(f.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'new_patient' }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /read-back differs in: provider/);
});

// Under 16 (decisions 1725, 2251, 2252): seen before -> Dr. Rai's openings only; never seen -> not booked.
const KID = Date.parse('2012-01-01T00:00:00Z');          // 14 on 2026-11-19
const SIXTEEN = Date.parse('2010-11-19T00:00:00Z');      // 16 on 2026-11-19
const SEEN = [{ id: 1, status: 'COMPLETE', startDateTime: at('2026-10-01', '09:00') }];

test("under 16 and seen before: Dr. Rai's openings only, from find_open_times and book", async () => {
  const f = fakeAscend({ dob: KID, history: SEEN });
  const r: any = await findOpenTimes(f.s, { visit_kind: 'filling', patient_id: '900' }, NOW);
  assert.deepEqual(r.openings.map((o: any) => o.start), ['2026-12-01T08:30', '2026-12-03T10:00']);
  assert.deepEqual(f.asked.at(-1), { operatory: 'SRP/FILLS', duration: '30', providers: '1', from: '2026-11-26' });
  assert.deepEqual(await book(f.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'filling' }, NOW),
    { ok: false, refused: true, reason: 'not an opening the window and hours rules allow for this visit' });   // Dr. Taj's
  assert.ok(!posted(f));
  assert.equal(((await book(f.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'filling' }, NOW)) as any).ok, true);
  assert.deepEqual(f.saved().appointment.provider, { id: 1 });
  const pain = fakeAscend({ dob: KID, history: SEEN });
  const p: any = await findOpenTimes(pain.s, { visit_kind: 'limited', in_pain: true, patient_id: '900' }, NOW);
  assert.deepEqual(p.openings.map((o: any) => o.start), ['2026-11-20T09:00']);
});

test('under 16 and never seen: book refuses; find_open_times still answers, so a visit staff booked can move', async () => {
  for (const history of [[], [{ id: 2, status: 'NOSHOW', startDateTime: at('2026-10-01', '09:00') }],
    [{ id: 3, status: 'UNCONFIRMED', startDateTime: at('2026-12-10', '09:00') }]]) {
    const f = fakeAscend({ dob: KID, history });
    assert.deepEqual(await book(f.s, { patient_id: '900', start: '2026-12-01T08:30', visit_kind: 'filling' }, NOW),
      { ok: false, refused: true, reason: UNDER_16_NOT_SEEN });
    assert.ok(!posted(f));
    const r: any = await findOpenTimes(f.s, { visit_kind: 'filling', patient_id: '900' }, NOW);
    assert.equal(r.ok, true);
    assert.equal(f.asked.at(-1)!.providers, '1,2');
  }
});

test('16 today, or no date of birth on the record: any open doctor, as before', async () => {
  for (const dob of [SIXTEEN, undefined]) {
    const f = fakeAscend({ dob });
    await findOpenTimes(f.s, { visit_kind: 'filling', patient_id: '900' }, NOW);
    assert.equal(f.asked.at(-1)!.providers, '1,2');
    assert.equal(((await book(f.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'filling' }, NOW)) as any).ok, true);
  }
});

test('under 16 and seen before, with no bookable Dr. Rai: nothing offered and nothing booked', async () => {
  const f = fakeAscend({ dob: KID, history: SEEN, providers: [{ id: 2, lastName: 'Taj', isSchedulingEligible: true }] });
  await assert.rejects(findOpenTimes(f.s, { visit_kind: 'filling', patient_id: '900' }, NOW), /no bookable doctor matching/);
  await assert.rejects(book(f.s, { patient_id: '900', start: '2026-12-05T09:00', visit_kind: 'filling' }, NOW), /no bookable doctor matching/);
  assert.ok(!posted(f));
});
