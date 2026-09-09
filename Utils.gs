/**
 * Utils.gs
 * פונקציות עזר כלליות המשמשות את כל שאר השירותים.
 * אין כאן שום Business Logic ספציפי לתחרות - רק כלים גנריים.
 */

var SHEET_NAMES = {
  CONFIG: 'CONFIG',
  USERS: 'USERS',
  TEAMS: 'TEAMS',
  AGENTS: 'AGENTS',
  TEAM_LEADERS: 'TEAM_LEADERS',
  CALL_REVIEWS: 'CALL_REVIEWS',
  WEEKLY_ROUNDS: 'WEEKLY_ROUNDS',
  MANAGER_TASKS: 'MANAGER_TASKS',
  MANAGER_TASK_RESULTS: 'MANAGER_TASK_RESULTS',
  BONUSES: 'BONUSES',
  BADGES: 'BADGES',
  BADGE_AWARDS: 'BADGE_AWARDS',
  WEEKLY_RESULTS: 'WEEKLY_RESULTS',
  HALL_OF_FAME: 'HALL_OF_FAME',
  ACTIVITY_LOG: 'ACTIVITY_LOG',
  AUDIT_LOG: 'AUDIT_LOG',
  LEAVE_REASONS: 'LEAVE_REASONS',
  OFFERS: 'OFFERS'
};

/** מחזיר את ה-Spreadsheet הפעיל (מחובר לסקריפט) */
function getDb() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** מזהה ייחודי קצר, בשימוש לכל רשומה חדשה */
function generateId(prefix) {
  var rand = Math.random().toString(36).substring(2, 8);
  var ts = new Date().getTime().toString(36);
  return (prefix || 'id') + '_' + ts + rand;
}

/** ISO week id בפורמט YYYY-Www, לפי תאריך נתון (ברירת מחדל: היום) */
function getWeekId(date) {
  var d = date ? new Date(date) : new Date();
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + (weekNo < 10 ? '0' + weekNo : weekNo);
}

/** טווח תאריכים (ראשון-שבת) עבור weekId נתון, לשימוש בטיימר/תצוגה */
function getWeekRange(weekId) {
  var parts = weekId.split('-W');
  var year = parseInt(parts[0], 10);
  var week = parseInt(parts[1], 10);
  var jan4 = new Date(Date.UTC(year, 0, 4));
  var jan4Day = jan4.getUTCDay() || 7;
  var monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  var sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday, end: sunday };
}

/** מחזיר את ה-weekId הבא/הקודם ביחס לנתון */
function shiftWeekId(weekId, delta) {
  var range = getWeekRange(weekId);
  var d = new Date(range.start);
  d.setUTCDate(d.getUTCDate() + delta * 7);
  return getWeekId(d);
}

function nowIso() {
  return new Date().toISOString();
}

/** ולידציה בסיסית - זורק שגיאה קריאה למשתמש אם החוק לא מתקיים */
function assertField(value, fieldNameHebrew) {
  if (value === null || value === undefined || value === '') {
    throw new Error('שדה חובה חסר: ' + fieldNameHebrew);
  }
}

function clampScore(value, min, max) {
  var n = Number(value);
  if (isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** בדיקת "אמת" סלחנית לתאים בגיליון - true אמיתי, או המחרוזות 'TRUE'/'true' */
function isTrue(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** עוטף כל קריאת שרת בטיפול שגיאות אחיד, כך שהלקוח תמיד מקבל מבנה עקבי */
function safeRun(fn) {
  try {
    var result = fn();
    return { success: true, data: result };
  } catch (err) {
    console.error(err);
    return { success: false, error: err.message || 'שגיאה לא צפויה' };
  }
}
