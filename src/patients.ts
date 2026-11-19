// create_patient: register a new patient in Ascend the way Ascend's own form does, then read it back.
// Same rules and result as the spec sim (vfd-agent sim/spec_sim.py t_create_patient): phone 10 digits, date of birth
// YYYY-MM-DD, under 16 refused (2.3.3), and the duplicate check first - the same first name, last name and date of
// birth comes back as the existing patient and nothing is created (2.3.2).
//
// Ascend's calls (doc ascend-internal-calls-map 8.2, 8.8.4 item 6; Ascend's app code, read 2026-11-19):
// - GET /patient/potentialDuplicates?firstName&lastName&dateOfBirth (the form sends the date as typed, MM/DD/YYYY);
// - POST /patient with the form's fields: dateOfBirth is epoch ms at UTC midnight, phones[].number 10 digits,
//   state 2 letters, the default billing type and the one location (read at call time, never hard-coded);
// - GET /patient/{id} to read the record back before reporting success (decision 1174).
// Nothing here prints or keeps patient data; errors carry field names, never values.
import type { Reply } from './session.ts';

export const AGE_MIN = 16;
export const PLANS = ['caresource', 'humana', 'amerihealth', 'buckeye', 'molina', 'other'];

export type Caller = { call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> };

export type NewPatient = {
  first_name: string; last_name: string; date_of_birth: string; phone: string;
  gender?: 'female' | 'male'; street?: string; city?: string; state?: string; zip?: string; email?: string;
  plan?: string;
};

export const digits = (s: unknown) => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
};

const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.trim() !== '' && a.trim().toLowerCase() === b.trim().toLowerCase();

// YYYY-MM-DD -> [year, month, day], or null when it is not a real date.
export function parseDay(iso: unknown): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}

export const dobEpoch = ([y, m, d]: [number, number, number]) => Date.UTC(y, m - 1, d);
export const dobTyped = ([y, m, d]: [number, number, number]) =>
  `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
export const dobFromEpoch = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function ageOn([y, m, d]: [number, number, number], today: string): number {
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

export function newPatientBody(p: NewPatient, born: [number, number, number], ids: { billingType: number; location: number }) {
  const body: Record<string, unknown> = {
    firstName: p.first_name.trim(), lastName: p.last_name.trim(), dateOfBirth: dobEpoch(born), status: 'NEW',
    isDuplicated: false, chartNumberGenerationUnavailable: false, languageType: 'ENGLISH', contactMethod: 'CALL_ME',
    patientAmount: 100, paymentUnit: 'PERCENT', povertyLevel: 100, races: [], patientMedicalAlerts: [],
    billingType: { id: ids.billingType }, billingTypes: [{ id: ids.billingType }],
    preferredLocation: { id: ids.location },
    phones: [{ sequence: 1, type: 'MOBILE', number: digits(p.phone) }],
    patientAddress: {
      address1: p.street?.trim() || undefined, city: p.city?.trim() || undefined,
      state: p.state?.trim().toUpperCase() || undefined, postalCode: p.zip?.trim() || undefined,
    },
  };
  if (p.gender) body.gender = p.gender === 'female' ? 'F' : 'M';
  if (p.email?.trim()) body.primaryEmail = { address: p.email.trim() };
  return body;
}

// The fields read back from GET /patient/{id} that must equal what was sent; the names of any that differ.
export function readBackDiff(sent: Record<string, any>, got: Record<string, any>): string[] {
  const bad: string[] = [];
  const eq = (name: string, a: unknown, b: unknown) => { if ((a ?? null) !== (b ?? null)) bad.push(name); };
  eq('firstName', sent.firstName, got.firstName);
  eq('lastName', sent.lastName, got.lastName);
  eq('dateOfBirth', dobFromEpoch(sent.dateOfBirth), typeof got.dateOfBirth === 'number' ? dobFromEpoch(got.dateOfBirth) : null);
  eq('phone', sent.phones[0].number, (got.phones ?? []).find((x: any) => x?.sequence === 1 || x?.type === 'MOBILE')?.number);
  for (const k of ['address1', 'city', 'state', 'postalCode']) eq(`patientAddress.${k}`, sent.patientAddress[k], got.patientAddress?.[k]);
  if (sent.gender) eq('gender', sent.gender, got.gender);
  eq('preferredLocation', sent.preferredLocation.id, got.preferredLocation?.id);
  if (!['NEW', 'ACTIVE'].includes(got.status)) bad.push('status');
  return bad;
}

const card = (r: any) => ({
  patient_id: String(r.id), first_name: r.firstName, last_name: r.lastName,
  date_of_birth: typeof r.dateOfBirth === 'number' ? dobFromEpoch(r.dateOfBirth) : r.dateOfBirth ?? null,
  phone: r.phone ? digits(r.phone) : null,
});

export async function createPatient(s: Caller, p: NewPatient, today: string): Promise<Record<string, unknown>> {
  const born = parseDay(p.date_of_birth);
  if (!born) return { ok: false, error: 'date_of_birth must be YYYY-MM-DD' };
  if (digits(p.phone).length !== 10) return { ok: false, error: 'phone must have 10 digits' };
  if (p.plan !== undefined && p.plan !== null && !PLANS.includes(p.plan)) {
    return { ok: false, error: `plan must be one of ${PLANS.join(', ')}` };
  }
  if (!p.first_name?.trim() || !p.last_name?.trim()) return { ok: false, error: 'first_name and last_name are needed' };

  const q = new URLSearchParams({ firstName: p.first_name.trim(), lastName: p.last_name.trim(), dateOfBirth: dobTyped(born) });
  const dup = await s.call('GET', `/patient/potentialDuplicates?${q}`);
  const rows: any[] = Array.isArray(dup.json) ? dup.json : [];
  const match = rows.find((r) => same(r.firstName, p.first_name) && same(r.lastName, p.last_name)
    && typeof r.dateOfBirth === 'number' && dobFromEpoch(r.dateOfBirth) === dobFromEpoch(dobEpoch(born)));
  if (match) return { ok: false, duplicate: true, existing: card(match) };

  if (ageOn(born, today) < AGE_MIN) {
    return { ok: false, refused: true, reason: 'under 16: not registered or booked (2.3.3)' };
  }

  const bt = await s.call('GET', '/settings/patient/billingType');
  const billingType = (Array.isArray(bt.json) ? bt.json : []).find((b: any) => b.isDefault)?.id;
  const loc = await s.call('GET', '/bootstrap/location');
  const locs: any[] = Array.isArray(loc.json) ? loc.json : [];
  if (!billingType) return { ok: false, error: 'Ascend has no default billing type' };
  if (locs.length !== 1) return { ok: false, error: `expected one Ascend location, found ${locs.length}` };

  const body = newPatientBody(p, born, { billingType, location: locs[0].id });
  const made = await s.call('POST', '/patient', body);
  const j = made.json as any;
  const id = typeof j === 'number' ? j : j?.patientId ?? j?.id;
  if (!id) return { ok: false, error: 'Ascend did not return the new patient id' };

  const back = await s.call('GET', `/patient/${id}`);
  const bad = readBackDiff(body, (back.json ?? {}) as Record<string, any>);
  if (bad.length) return { ok: false, error: `saved, but the read-back differs in: ${bad.join(', ')}`, patient_id: String(id) };
  return { ok: true, patient_id: String(id) };
}
