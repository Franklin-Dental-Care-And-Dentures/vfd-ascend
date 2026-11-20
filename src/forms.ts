// send_forms, with the spec sim's rule (sim/spec_sim.py t_send_forms): the new-patient forms go only to the patient
// this link registered while running (decisions 1063, 1794); a resend or a forms question is a message, never a send.
//
// Ascend's own send (its locationFormController.sendFormsNow and the Request Forms dialog, origin requestAllDue):
// POST /patientForm/sendFormsNow/{patientId} as a form, fields channelType (SMS or EMAIL), smsNumber or
// emailAddress, origin. Ascend answers "There are no forms due for this patient" when none are due.
// The channel (decision 1492 item 7): a text to the record's mobile phone when the patient said yes to texts
// (smsAuthorizationStatus OPT_IN; OPT_OUT is no, INVALID is not supported by the carrier); otherwise an email to the
// record's primary email; otherwise nothing is sent. Nothing here prints or keeps patient data.
// Seen live (2026-11-19, Test Testerson): a text to a number his record does not mark for texts is refused HTTP 422,
// yet Ascend marks his due forms Sent with a Requested submission.
import { CREATED, digits, type Caller } from './patients.ts';

export type FormPoster = { form(path: string, fields: Record<string, string>): Promise<{ status: number; text: string }> };
export const NO_FORMS_DUE = 'There are no forms due for this patient';

export type Channel = { channelType: 'SMS'; smsNumber: string } | { channelType: 'EMAIL'; emailAddress: string };

// How the forms can reach the patient, from their Ascend record; null when neither a text nor an email can.
export function channelOf(p: any): Channel | null {
  const phones: any[] = Array.isArray(p?.phones) ? [...p.phones] : [];
  phones.sort((a, b) => Number(a?.sequence ?? 99) - Number(b?.sequence ?? 99));
  const mobile = phones.find((ph) => ph?.type === 'MOBILE' && ph?.smsAuthorizationStatus === 'OPT_IN' && digits(ph?.number).length === 10);
  if (mobile) return { channelType: 'SMS', smsNumber: digits(mobile.number) };
  const email = String(p?.primaryEmail?.address ?? '').trim();
  return email ? { channelType: 'EMAIL', emailAddress: email } : null;
}

// Ascend's own send to one channel. ok false when Ascend says no forms are due.
export async function sendFormsNow(s: FormPoster, pid: string, ch: Channel): Promise<Record<string, unknown>> {
  const fields: Record<string, string> = { origin: 'requestAllDue', channelType: ch.channelType,
    ...(ch.channelType === 'SMS' ? { smsNumber: ch.smsNumber } : { emailAddress: ch.emailAddress }) };
  let r: { status: number; text: string };
  try {
    r = await s.form(`/patientForm/sendFormsNow/${pid}`, fields);
  } catch (e) {
    // Ascend refused (seen live: HTTP 422 with no reason for a number not marked for texts); the caller is told to call
    // back in business hours (decision 1063). Ascend may still have marked the forms Sent.
    return { ok: false, error: `Ascend did not send the forms (${String((e as Error).message).split(':').pop()?.trim()})` };
  }
  let said = r.text;
  try { const j = JSON.parse(r.text); if (typeof j === 'string') said = j; } catch { /* plain text */ }
  if (said.includes(NO_FORMS_DUE)) return { ok: false, error: 'no forms are due for this patient' };
  return { ok: true, channel: ch.channelType === 'SMS' ? 'text' : 'email' };
}

export async function sendForms(s: Caller & FormPoster, a: Record<string, any>, created: Set<string> = CREATED):
    Promise<Record<string, unknown>> {
  const pid = String(a.patient_id ?? '');
  if (!created.has(pid)) {
    return { ok: false, refused: true, reason: 'forms go only to the patient just registered (decisions 1063, 1794)' };
  }
  const p = (await s.call('GET', `/patient/${pid}`)).json as any;
  if (!p?.id) return { ok: false, error: `no patient ${pid}` };
  const ch = channelOf(p);
  if (!ch) return { ok: false, error: 'no mobile phone that takes texts and no email on the record' };
  return sendFormsNow(s, pid, ch);
}
