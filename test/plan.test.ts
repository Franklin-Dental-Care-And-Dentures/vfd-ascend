// The card's treatment_plan and due, named only by the office's own recall lists (decision 2197).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dueKind, kindsByCode, OFF_LIST, planKinds } from '../src/plan.ts';
import { midnight } from '../src/booking.ts';

// The office's lists as read live on 2026-11-19 (CHECK 51562), trimmed.
const LISTS = [
  { type: 'Fillings', procedures: [{ adaCode: 'D2330' }, { adaCode: 'D2391' }] },
  { type: 'extraction', procedures: [{ adaCode: 'D7140' }] },
  { type: 'PROPHY', procedures: [{ adaCode: 'D1110' }] },
  { type: 'PERIO', procedures: [{ adaCode: 'D4910' }] },
  { type: 'crown seat', procedures: [{ adaCode: 'D2740' }] },
  { type: 'SRP', procedures: [] },
  { type: 'BITEWINGS', procedures: [{ adaCode: 'D0274' }] },
];
const BY = kindsByCode(LISTS);
const P = (id: number, code: string, more: Record<string, unknown> = {}) =>
  ({ id, status: 'TREATMENT_PLAN', code, txCaseId: null, visitId: null, appointmentId: null, serviceDate: id, ...more });

test('codes are named only by the office lists that carry a Vida kind', () => {
  assert.deepEqual([...BY].sort(), [['D1110', 'cleaning'], ['D2330', 'filling'], ['D2391', 'filling'], ['D2740', 'seat'], ['D7140', 'extraction']]);
  assert.equal(kindsByCode([{ type: 'Fillings', procedures: [{ adaCode: 'D1' }] }, { type: 'extraction', procedures: [{ adaCode: 'D1' }] }]).get('D1'), OFF_LIST);
});

test('a planned procedure on none of the lists is off-list: silver filling, surgical extraction, root canal, perio, x-ray', () => {
  assert.deepEqual(planKinds([P(1, 'D2140'), P(2, 'D7210'), P(3, 'D3310'), P(4, 'D4910'), P(5, 'D0274'), P(6, 'D7140.1')], [], [], BY),
    [OFF_LIST, OFF_LIST, OFF_LIST, OFF_LIST, OFF_LIST, OFF_LIST]);
  assert.deepEqual(planKinds([P(1, 'D7140'), P(2, 'D2391')], [], [], BY), ['extraction', 'filling']);
});

test('only unbooked Planned procedures count; Rejected cases are left out', () => {
  const procs = [P(1, 'D7140', { status: 'COMPLETED' }), P(2, 'D2391', { appointmentId: 77 }), P(3, 'D1110', { txCaseId: 9, visitId: 90 }),
    P(4, 'D2330', { status: 'REFERRED' }), P(5, 'D2740', { txCaseId: 8, visitId: 80 })];
  assert.deepEqual(planKinds(procs, [{ id: 9, name: 'Case 1', optionStatus: 'REJECTED' }, { id: 8, name: 'Case 2', optionStatus: 'ACCEPTED' }],
    [{ id: 80, caseId: 8, visitIndex: 1 }, { id: 90, caseId: 9, visitIndex: 1 }], BY), ['seat']);
  assert.deepEqual(planKinds([], [], [], BY), []);
});

test('order as Ascend shows it: unassigned first, then cases by name, then visits by index; a mixed visit is off-list', () => {
  const procs = [
    P(10, 'D2391', { txCaseId: 2, visitId: 21 }), P(11, 'D2330', { txCaseId: 2, visitId: 21 }),
    P(12, 'D7140', { txCaseId: 2, visitId: 20 }),
    P(13, 'D1110', { txCaseId: 1, visitId: 11 }), P(14, 'D0274', { txCaseId: 1, visitId: 11 }),
    P(15, 'D7140', { serviceDate: 99 }),
  ];
  const cases = [{ id: 2, name: 'Case 10', optionStatus: 'CREATED' }, { id: 1, name: 'Case 2', optionStatus: 'PRESENTED' }];
  const visits = [{ id: 21, caseId: 2, visitIndex: 2 }, { id: 20, caseId: 2, visitIndex: 1 }, { id: 11, caseId: 1, visitIndex: 1 }];
  // unassigned D7140; Case 2 visit 1 (D1110 + bitewings: off-list); Case 10 visit 1 (D7140), visit 2 (two fillings)
  assert.deepEqual(planKinds(procs, cases, visits, BY), ['extraction', OFF_LIST, 'extraction', 'filling']);
});

test('due: the earliest cleaning or SRP whose day has come and no appointment holds', () => {
  const at = (d: string) => midnight(d) + 23 * 3600000;
  const today = '2026-11-19';
  assert.equal(dueKind([], today), null);
  assert.equal(dueKind([{ type: 'PROPHY', dueDate: at('2026-11-19'), appointmentId: null, scheduled: null }], today), 'cleaning');
  assert.equal(dueKind([{ type: 'PROPHY', dueDate: at('2026-11-20'), appointmentId: null, scheduled: null }], today), null);
  assert.equal(dueKind([{ type: 'PROPHY', dueDate: at('2026-10-01'), appointmentId: 5, scheduled: null }], today), null);
  assert.equal(dueKind([{ type: 'PROPHY', dueDate: at('2026-10-01'), appointmentId: null, scheduled: at('2026-12-01') }], today), null);
  assert.equal(dueKind([{ type: 'PERIO', dueDate: at('2026-01-01'), appointmentId: null, scheduled: null },
    { type: 'BITEWINGS', dueDate: at('2026-01-01'), appointmentId: null, scheduled: null }], today), null);
  assert.equal(dueKind([{ type: 'PROPHY', dueDate: at('2026-09-01'), appointmentId: null, scheduled: null },
    { type: 'SRP', dueDate: at('2026-06-01'), appointmentId: null, scheduled: null }], today), 'srp');
});
