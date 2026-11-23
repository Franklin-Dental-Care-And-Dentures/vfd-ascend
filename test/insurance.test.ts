// The card's insurance and other_coverage from the Ascend record, and which visits the record may book.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { midnight } from '../src/booking.ts';
import { coverageOf, insuranceAllows, planKey } from '../src/insurance.ts';

const NOW = Date.parse('2026-11-19T21:00:00Z');

test("the office's carriers and plans, read live 2026-11-19, map to the five plans or 'other'", () => {
  const seen: [string, string][] = [
    ['CareSource OH Medicaid (Delta) [DOS Beginning 1/1/2026] OHIO CareSource Medicaid adult', 'caresource'],
    ['CareSource OH Medicaid (Delta) [DOS Beginning 1/1/2026] CareSource OH Dental Medicaid (Delta)', 'caresource'],
    ['DentaQuest Humana Healthy Horizon', 'humana'],
    ['DentaQuest OHIO Amerihealth Medicaid Adult', 'amerihealth'],
    ['Envolve Dental - Ohio Envolve Dental, Inc. - Ohio', 'buckeye'],
    ['Medicaid OH- Molina HealthCare Molina Healthcare', 'molina'],
    ['Medicaid of Ohio Ohio Medicaid', 'other'],
    ['Delta Dental of Ohio', 'other'],
    ['United HealthCare Community Plan', 'other'],
    ['Humana Medicare Advantage', 'medicare'],
  ];
  for (const [name, key] of seen) assert.equal(planKey(name), key, name);
});

const names = new Map([[1, 'DentaQuest Humana Healthy Horizon'], [2, 'Delta Dental of Ohio'], [3, 'Medicare Part C'], [4, 'Medicaid OH- Molina HealthCare Molina Healthcare']]);
const plan = (id: number, order?: number, endDate?: number) => ({ subscriberInsurancePlan: { carrierInsurancePlan: { id } },
  ...(order ? { responsibilities: [{ paymentResponsibilityOrder: order }, { paymentResponsibilityOrder: 9 }] } : {}), ...(endDate ? { endDate } : {}) });

test('coverage: the primary plan, a second plan in force as other coverage, ended plans left out', () => {
  assert.deepEqual(coverageOf([], names, NOW), { insurance: null, other_coverage: null });
  assert.deepEqual(coverageOf([plan(1)], names, NOW), { insurance: 'humana', other_coverage: null });
  assert.deepEqual(coverageOf([plan(2, 2), plan(1, 1)], names, NOW), { insurance: 'humana', other_coverage: 'other' });
  assert.deepEqual(coverageOf([plan(1, 1), plan(3, 2)], names, NOW), { insurance: 'humana', other_coverage: 'medicare' });
  assert.deepEqual(coverageOf([plan(1, 1), plan(4, 2)], names, NOW), { insurance: 'humana', other_coverage: 'other' });
  assert.deepEqual(coverageOf([plan(1, 1), plan(1, 2)], names, NOW), { insurance: 'humana', other_coverage: null });
  assert.deepEqual(coverageOf([plan(2, 1, midnight('2026-11-18')), plan(1, 2)], names, NOW), { insurance: 'humana', other_coverage: null });
  assert.deepEqual(coverageOf([plan(1, 1, midnight('2026-11-19'))], names, NOW), { insurance: 'humana', other_coverage: null });
  // a plan whose carrier is not in the office's list still reads by its own names
  assert.deepEqual(coverageOf([{ subscriberInsurancePlan: { carrierInsurancePlan: { id: 99, planName: 'Buckeye', insuranceCarrier: { name: 'Envolve' } } } }], names, NOW),
    { insurance: 'buckeye', other_coverage: null });
});

test('which visits a record may book (decisions 1864, 1865)', () => {
  assert.equal(insuranceAllows({ insurance: 'molina', other_coverage: null }, 'extraction'), true);
  for (const c of [{ insurance: null, other_coverage: null }, { insurance: 'other', other_coverage: null },
    { insurance: 'medicare', other_coverage: null }, { insurance: 'caresource', other_coverage: 'medicare' }]) {
    assert.equal(insuranceAllows(c, 'filling'), false);
    assert.equal(insuranceAllows(c, 'new_patient'), true);
  }
});

// Decision 2233: a dual plan's name is not one of the five, even with one of their names in it.
test('a dual plan reads other; Medicare reads medicare; the five alone as before', async () => {
  const { planKey } = await import('../src/insurance.ts');
  for (const n of ['Humana Gold Plus HMO', 'CareSource MyCare Ohio', 'Molina Dual Options', 'AmeriHealth Caritas VIP Care Plus',
    'Buckeye D-SNP', 'Humana Special Needs Plan']) assert.equal(planKey(n), 'other', n);
  assert.equal(planKey('CareSource Medicare Advantage'), 'medicare');
  assert.equal(planKey('CareSource OH Medicaid (Delta) OHIO CareSource Medicaid adult'), 'caresource');
  assert.equal(planKey('DentaQuest Humana Healthy Horizon'), 'humana');
  assert.equal(planKey('Envolve Dental - Ohio'), 'buckeye');
});
