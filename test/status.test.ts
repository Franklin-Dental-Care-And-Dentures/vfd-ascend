// The existing-visit JSON equals what Ascend's own Appointment model sent for the made-up Test Testerson's visit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existingAppointmentJson } from '../src/status.ts';

const MODEL = {"id":19000078170210,"created":1795132329250,"startDateTime":1796481000000,"endDateTime":1796482800000,"provider":{"id":19000000026608},"operatory":{"id":19000000006656},"needsFollowup":false,"ASAP":false,"needsPremedicate":false,"status":"UNCONFIRMED","title":"Appointment","reason":"","duration":30,"patient":{"id":19000015200389},"patientLite":{"id":19000015200389},"location":{"id":19000000000764},"productionAmount":0,"visits":[],"patientProcedures":[],"procedures":[],"communications":[],"dueDates":[],"bookedOnline":false,"missedAppointments":[],"pinned":false,"isAppointmentEmpty":false,"isPatientFailed":false,"isLabCaseEnabled":false};

test("an existing visit is sent as Ascend's model serialises it", () => {
  const row = { ...structuredClone(MODEL), version: 0, patientId: 19000015200389, note: null, other: null, followedUp: null,
    reminded: null, confirmed: null, insuranceEligibilityVerified: null, secondaryProvider: null, leftMessage: null, pinnedOn: null,
    provider: { id: 19000000026608, name: 'x' }, patient: { id: 19000015200389, patientSmsThread: 1 } } as any;
  delete row.isAppointmentEmpty; delete row.isPatientFailed; delete row.isLabCaseEnabled;
  assert.deepEqual(existingAppointmentJson(row), MODEL);
});
