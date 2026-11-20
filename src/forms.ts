// send_forms, with the spec sim's rule (sim/spec_sim.py t_send_forms): the new-patient forms go only to the patient
// this link registered while running (decisions 1063, 1794); a resend or a forms question is a message, never a send.
//
// Ascend's own send, as its current forms window makes it (_sendFormV2, proven live 2026-11-19 on Test Testerson):
// POST /patientForm/fetchPatientChallengeUrl/{patientId} as a form with origin requestAllDue gives the patient's forms
// link {status enabled, url, smsUrl, emailUrl} (Ascend refuses it when no forms are due); then POST /v2/form/send
// {patientId, url, channelType, phoneNumberId | emailAddressId} answers {success}. The older
// /patientForm/sendFormsNow was refused (HTTP 422) yet marked the forms Sent, so it is not used.
// The channel (decision 1492 item 7): a text to the record's mobile phone when the patient said yes to texts
// (smsAuthorizationStatus OPT_IN; OPT_OUT is no, INVALID is not supported by the carrier); otherwise an email to the
// record's primary email; otherwise nothing is sent. Nothing here prints or keeps patient data.
import { CREATED, digits, type Caller } from './patients.ts';

export type FormPoster = { form(path: string, fields: Record<string, string>): Promise<{ status: number; text: string }> };

export type Channel = { channelType: 'SMS'; phoneNumberId: number } | { channelType: 'EMAIL'; emailAddressId: number };

// How the forms can reach the patient, from their Ascend record; null when neither a text nor an email can.
export function channelOf(p: any): Channel | null {
  const phones: any[] = Array.isArray(p?.phones) ? [...p.phones] : [];
  phones.sort((a, b) => Number(a?.sequence ?? 99) - Number(b?.sequence ?? 99));
  const mobile = phones.find((ph) => ph?.type === 'MOBILE' && ph?.smsAuthorizationStatus === 'OPT_IN' && ph?.id != null
    && digits(ph?.number).length === 10);
  if (mobile) return { channelType: 'SMS', phoneNumberId: Number(mobile.id) };
  const email = p?.primaryEmail;
  return email?.id != null && String(email?.address ?? '').trim() ? { channelType: 'EMAIL', emailAddressId: Number(email.id) } : null;
}

const why = (e: unknown) => String((e as Error).message).split(':').pop()?.trim();

// Ascend's own send to one channel: the forms link, then the send.
export async function sendFormsNow(s: Caller & FormPoster, pid: string, ch: Channel): Promise<Record<string, unknown>> {
  let link: any;
  try {
    link = JSON.parse((await s.form(`/patientForm/fetchPatientChallengeUrl/${pid}`, { origin: 'requestAllDue' })).text);
  } catch (e) {
    return { ok: false, error: `no forms are due for this patient, or Ascend refused the forms link (${why(e)})` };
  }
  const url = ch.channelType === 'SMS' ? link?.smsUrl ?? link?.url : link?.emailUrl ?? link?.url;
  if (link?.status !== 'enabled' || !url) return { ok: false, error: 'Ascend gave no forms link' };
  const body = { patientId: Number(pid), url, channelType: ch.channelType,
    ...(ch.channelType === 'SMS' ? { phoneNumberId: ch.phoneNumberId } : { emailAddressId: ch.emailAddressId }) };
  let sent: any;
  try { sent = (await s.call('POST', '/v2/form/send', body)).json; } catch (e) { return { ok: false, error: `Ascend did not send the forms (${why(e)})` }; }
  if (sent?.success !== true) return { ok: false, error: 'Ascend did not send the forms' };
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
