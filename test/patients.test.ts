// create_patient against a fake Ascend: the sim's rules and result, Ascend's formats, and the read-back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageOn, createPatient, digits, dobEpoch, dobFromEpoch, dobTyped, newPatientBody, parseDay, readBackDiff,
  type Caller } from '../src/patients.ts';

const TODAY = '2026-11-19';
const TEST = { first_name: 'Test', last_name: 'Testerson', date_of_birth: '1980-01-01', phone: '(513) 555-1111',
  gender: 'male' as const, street: '123 Main Street', city: 'Cincinnati', state: 'oh', zip: '45231' };

// A fake Ascend that answers the calls create_patient makes and echoes a POSTed patient back on read.
function fakeAscend(opts: { dupRows?: unknown[]; mangle?: (p: any) => void; locations?: number } = {}) {
  const calls: string[] = [];
  let saved: any = null;
  const s: Caller = {
    async call(method, path, body) {
      calls.push(`${method} ${path.split('?')[0]}`);
      if (path.startsWith('/patient/potentialDuplicates')) return { status: 200, json: opts.dupRows ?? [] };
      if (path === '/settings/patient/billingType') return { status: 200, json: [{ id: 7, isDefault: false }, { id: 8, isDefault: true }] };
      if (path === '/bootstrap/location') return { status: 200, json: Array.from({ length: opts.locations ?? 1 }, (_, i) => ({ id: 500 + i })) };
      if (method === 'POST' && path === '/patient') { saved = { ...(body as any), id: 900 }; return { status: 200, json: { patientId: 900 } }; }
      if (path === '/patient/900') { const p = structuredClone(saved); opts.mangle?.(p); return { status: 200, json: p }; }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { s, calls, saved: () => saved };
}

test('formats: phone digits, date parsing, epoch at UTC midnight, the date as the form types it', () => {
  assert.equal(digits('(513) 555-1111'), '5135551111');
  assert.equal(digits('1-513-555-1111'), '5135551111');
  assert.deepEqual(parseDay('1980-01-01'), [1980, 1, 1]);
  assert.equal(parseDay('1980-02-30'), null);
  assert.equal(parseDay('01/01/1980'), null);
  assert.equal(dobEpoch([1980, 1, 1]), 315532800000);
  assert.equal(dobFromEpoch(315532800000), '1980-01-01');
  assert.equal(dobTyped([1980, 1, 1]), '01/01/1980');
  assert.equal(ageOn([2010, 11, 20], TODAY), 15);
  assert.equal(ageOn([2010, 11, 19], TODAY), 16);
});

test('the body has the form fields: NEW, default billing type, the one location, 10-digit mobile, 2-letter state', () => {
  const b: any = newPatientBody(TEST, [1980, 1, 1], { billingType: 8, location: 500 });
  assert.equal(b.status, 'NEW');
  assert.equal(b.gender, 'M');
  assert.equal(b.dateOfBirth, 315532800000);
  assert.deepEqual(b.phones, [{ sequence: 1, type: 'MOBILE', number: '5135551111' }]);
  assert.deepEqual(b.patientAddress, { address1: '123 Main Street', city: 'Cincinnati', state: 'OH', postalCode: '45231' });
  assert.deepEqual(b.billingType, { id: 8 });
  assert.deepEqual(b.preferredLocation, { id: 500 });
  assert.equal(b.contactMethod, 'CALL_ME');
});

test('a new patient: duplicate check, then create, then read back; patient_id as text', async () => {
  const f = fakeAscend();
  const r = await createPatient(f.s, TEST, TODAY);
  assert.deepEqual(r, { ok: true, patient_id: '900' });
  assert.deepEqual(f.calls, ['GET /patient/potentialDuplicates', 'GET /settings/patient/billingType',
    'GET /bootstrap/location', 'POST /patient', 'GET /patient/900']);
});

test('the same name and date of birth comes back as the existing patient and nothing is created', async () => {
  const f = fakeAscend({ dupRows: [{ id: 42, firstName: 'TEST', lastName: 'testerson', dateOfBirth: 315532800000, phone: '5135551111' }] });
  const r: any = await createPatient(f.s, TEST, TODAY);
  assert.equal(r.ok, false);
  assert.equal(r.duplicate, true);
  assert.equal(r.existing.patient_id, '42');
  assert.ok(!f.calls.includes('POST /patient'));
});

test('a similar patient with another date of birth is not a duplicate', async () => {
  const f = fakeAscend({ dupRows: [{ id: 42, firstName: 'Test', lastName: 'Testerson', dateOfBirth: 315619200000 }] });
  assert.deepEqual(await createPatient(f.s, TEST, TODAY), { ok: true, patient_id: '900' });
});

test('refusals and errors, as the sim gives them, before anything is written', async () => {
  const f = fakeAscend();
  assert.deepEqual(await createPatient(f.s, { ...TEST, date_of_birth: '2012-01-01' }, TODAY),
    { ok: false, refused: true, reason: 'under 16: not registered or booked (2.3.3)' });
  assert.deepEqual(await createPatient(f.s, { ...TEST, phone: '555-1111' }, TODAY), { ok: false, error: 'phone must have 10 digits' });
  assert.deepEqual(await createPatient(f.s, { ...TEST, date_of_birth: '01/01/1980' }, TODAY),
    { ok: false, error: 'date_of_birth must be YYYY-MM-DD' });
  assert.ok(!f.calls.includes('POST /patient'));
});

test('a read-back that differs is not success, and names the field', async () => {
  const f = fakeAscend({ mangle: (p) => { p.phones = [{ sequence: 1, type: 'MOBILE', number: '5135550000' }]; } });
  const r: any = await createPatient(f.s, TEST, TODAY);
  assert.equal(r.ok, false);
  assert.match(r.error, /read-back differs in: phone/);
  assert.equal(r.patient_id, '900');
});

test('more than one location stops before any write', async () => {
  const f = fakeAscend({ locations: 2 });
  assert.deepEqual(await createPatient(f.s, TEST, TODAY), { ok: false, error: 'expected one Ascend location, found 2' });
  assert.ok(!f.calls.includes('POST /patient'));
});

test('readBackDiff ignores fields Ascend fills in itself', () => {
  const sent: any = newPatientBody(TEST, [1980, 1, 1], { billingType: 8, location: 500 });
  const got = { ...structuredClone(sent), id: 900, status: 'ACTIVE', chartNumber: 'X1',
    patientAddress: { ...sent.patientAddress, id: 3, address2: null } };
  assert.deepEqual(readBackDiff(sent, got), []);
});
