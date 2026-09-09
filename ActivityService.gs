/**
 * ActivityService.gs
 * ה-Live Feed. אין WebSocket אמיתי ב-Apps Script Web App, לכן הלקוח מבצע
 * Polling קליל (כל 15-20 שניות) ומביא רק אירועים חדשים לפי Timestamp אחרון שראה.
 */

function logActivity(message, weekId) {
  appendRow(SHEET_NAMES.ACTIVITY_LOG, {
    EventId: generateId('evt'),
    Message: message,
    WeekId: weekId,
    Timestamp: nowIso()
  });
  cacheRemove('activity_feed_' + weekId);
}

/** מחזיר את האירועים האחרונים לשבוע, החדשים ביותר קודם */
function getActivityFeed(weekId, sinceTimestamp, limit) {
  var events = readSheet(SHEET_NAMES.ACTIVITY_LOG).filter(function (e) { return e.WeekId === weekId; });
  if (sinceTimestamp) {
    events = events.filter(function (e) { return new Date(e.Timestamp) > new Date(sinceTimestamp); });
  }
  events.sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); });
  return events.slice(0, limit || 30).map(function (e) {
    return { eventId: e.EventId, message: e.Message, timestamp: e.Timestamp };
  });
}
