// The patient card's insurance and other_coverage, read from the patient's Ascend record, in the spec sim's terms
// (vfd-agent sim/spec_sim.py _card; specgen/patients.py): insurance is one of the five plans (spec.PLANS),
// 'medicare', 'other' or null (none on the record); other_coverage is null, 'medicare' or 'other'. The plan is read
// from the record, never asked (decision 1713); anything but one of the five plans alone gets the self-pay offer
// (decisions 1864, 1865).
//
// Ascend's calls: GET /patientInsurancePlanREST/{patientId} (Ascend's own PatientInsurancePlanCollection url) and
// GET /bootstrap/insuranceCarrier (the office's carriers and their plans, for the names). A plan counts while it has
// not ended (Ascend's isExpired: endDate before today); its order is the newest responsibility's
// paymentResponsibilityOrder (1 primary, 2 secondary; Ascend's getPaymentResponsibilityOrder).
//
// The office's carriers and plans (read live on 2026-11-19) map by name: CareSource OH Medicaid (Delta);
// DentaQuest's Humana Healthy Horizon and OHIO Amerihealth Medicaid Adult; Envolve Dental - Ohio (Buckeye, as the
// pre-auth tracker names it, decision 993); Medicaid OH- Molina HealthCare. Delta Dental of Ohio, United HealthCare
// Community Plan and Medicaid of Ohio (Ohio Medicaid) are none of the five and read 'other'. A name with Medicare in
// it reads 'medicare' first. Nothing here prints or keeps patient data.
import type { Caller } from './patients.ts';
import { local, midnight } from './booking.ts';

export const PLAN_KEYS = ['caresource', 'humana', 'amerihealth', 'buckeye', 'molina'];

const BY_NAME: [RegExp, string][] = [
  [/medicare/i, 'medicare'],
  [/caresource/i, 'caresource'],
  [/humana/i, 'humana'],
  [/amerihealth/i, 'amerihealth'],
  [/buckeye|envolve/i, 'buckeye'],
  [/molina/i, 'molina'],
];

// A carrier and plan name -> one of the five plans, 'medicare' or 'other'.
export function planKey(name: string): string {
  for (const [re, key] of BY_NAME) if (re.test(name)) return key;
  return 'other';
}

export type Coverage = { insurance: string | null; other_coverage: string | null };

const orderOf = (p: any): number => {
  const r = Array.isArray(p?.responsibilities) ? p.responsibilities[0] : null;
  const n = Number(r?.paymentResponsibilityOrder ?? p?.paymentResponsibilityOrder ?? 1);
  return Number.isFinite(n) ? n : 1;
};

// The plans in force on the record -> the card's two fields. names: carrierInsurancePlan id -> 'carrier plan'.
export function coverageOf(plans: any[], names: Map<number, string>, nowMs: number): Coverage {
  const today = midnight(local(nowMs).date);
  const live = plans.filter((p) => p && !(typeof p.endDate === 'number' && p.endDate < today))
    .sort((a, b) => orderOf(a) - orderOf(b));
  if (!live.length) return { insurance: null, other_coverage: null };
  const keyOf = (p: any) => {
    const cip = p?.subscriberInsurancePlan?.carrierInsurancePlan ?? {};
    const own = `${cip?.insuranceCarrier?.name ?? ''} ${cip?.planName ?? ''}`.trim();
    return planKey(names.get(cip?.id) ?? own);
  };
  const keys = live.map(keyOf);
  const others = [...new Set(keys.slice(1))].filter((k) => k !== keys[0]);
  return { insurance: keys[0], other_coverage: others.includes('medicare') ? 'medicare' : others.length ? 'other' : null };
}

export async function carrierPlanNames(s: Caller): Promise<Map<number, string>> {
  const cars: any[] = ((await s.call('GET', '/bootstrap/insuranceCarrier')).json as any[]) ?? [];
  const out = new Map<number, string>();
  for (const c of Array.isArray(cars) ? cars : []) {
    for (const p of Array.isArray(c?.carrierInsurancePlans) ? c.carrierInsurancePlans : []) {
      if (p?.id !== undefined) out.set(p.id, `${c.name ?? ''} ${p.planName ?? ''}`.trim());
    }
  }
  return out;
}

export async function coverage(s: Caller, pid: string, nowMs = Date.now()): Promise<Coverage> {
  const j = (await s.call('GET', `/patientInsurancePlanREST/${pid}`)).json as any;
  const plans: any[] = Array.isArray(j) ? j : j?.patientInsurancePlans ?? [];
  if (!plans.length) return { insurance: null, other_coverage: null };
  return coverageOf(plans, await carrierPlanNames(s), nowMs);
}

// May this record book this visit? One of the five plans alone books anything; anything else books only the self-pay
// visit, the New Patient exam (spec.SELF_PAY_VISIT, decisions 1864, 1865).
export const SELF_PAY_VISIT = 'new_patient';
export const insuranceAllows = (c: Coverage, kind: string) =>
  kind === SELF_PAY_VISIT || (c.insurance !== null && PLAN_KEYS.includes(c.insurance) && !c.other_coverage);
