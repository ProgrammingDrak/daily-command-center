"use strict";

// Every day-reading transport prepares the same dated repeat instances before
// taking its snapshot or cursor. The responsibility store owns idempotency.
module.exports = function createDayPreparation({ blockDB, respStore, getTodayStr, APP_TIME_ZONE }) {
  return async function prepareScheduledDay(date, userId, workspaceId) {
    await blockDB.ensureDayRoot(date, userId, workspaceId);
    await respStore.catchUpScheduledRepeats({ userId, workspaceId, throughDate: getTodayStr(), targetTimeZone: APP_TIME_ZONE });
    await respStore.materializeScheduledRepeatsForDate({ date, userId, workspaceId, targetTimeZone: APP_TIME_ZONE, strict: true });
  };
};
