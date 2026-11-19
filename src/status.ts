// Status writes on an existing visit (doc ascend-internal-calls-map 8.11, decision 1151): the same save as a booking,
// POST /appointmentREST/appointmentWithPatientLite, with appointment.status set; a missed status (NOSHOW, BROKEN,
// CANCELLEDBYOFF) also sends missedAppointment { reasonCancelled, cancelledOn }, and Ascend then makes the missed
// record the strike count reads. The appointment is sent as Ascend's own Appointment model serialises an existing
// visit (its toJSON, read in the signed-in page at 18:53 ET 2026-11-19): the GET row without version, patientId and
// empty values, links as { id }, plus the three flags. Then read back. Nothing here prints or keeps patient data.
import type { Caller } from './patients.ts';

export const MISSED = new Set(['NOSHOW', 'BROKEN', 'CANCELLEDBYOFF']);
const LINKS = ['provider', 'operatory', 'location', 'patient', 'patientLite', 'secondaryProvider'];
const DROP = new Set(['version', 'patientId']);

export function existingAppointmentJson(row: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (DROP.has(k) || v === null || v === undefined) continue;
    if (LINKS.includes(k)) out[k] = { id: (v as any).id };
    else if (k === 'communications') out[k] = (v as any[]).map((c) => ({ id: c.id }));
    else out[k] = v;
  }
  return { ...out, isAppointmentEmpty: false, isPatientFailed: false, isLabCaseEnabled: false };
}

const rowsOf = (j: any): any[] => (Array.isArray(j) ? j : j?.appointments ?? []);

export async function setStatus(s: Caller, patientId: string, appointmentId: string, status: string, reason: string, nowMs = Date.now()) {
  const row = rowsOf((await s.call('GET', `/appointmentREST?patientId=${patientId}`)).json).find((x) => String(x.id) === appointmentId);
  if (!row) return { ok: false, error: `no visit ${appointmentId}` };
  const p = (await s.call('GET', `/patient/${patientId}`)).json as any;
  const body: Record<string, unknown> = { isAppointmentEmpty: false, appointment: { ...existingAppointmentJson(row), status },
    patient: { id: Number(patientId) }, primaryContact: { id: p?.relationships?.primaryContact?.id ?? Number(patientId) } };
  if (MISSED.has(status)) body.missedAppointment = { reasonCancelled: reason, cancelledOn: nowMs };
  await s.call('POST', '/appointmentREST/appointmentWithPatientLite', body);
  const missed = rowsOf((await s.call('GET', `/missedAppointment?patientIds=${patientId}`)).json);
  const still = rowsOf((await s.call('GET', `/appointmentREST?patientId=${patientId}`)).json).find((x) => String(x.id) === appointmentId);
  const seen = MISSED.has(status)
    ? missed.some((m) => m.status === status && (String(m.appointmentId ?? m.appointment?.id ?? '') === appointmentId || m.startDateTime === row.startDateTime))
    : still?.status === status;
  return seen ? { ok: true, status } : { ok: false, error: `saved, but status ${status} was not found on read-back` };
}
