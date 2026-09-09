/**
 * AuthService.gs
 * הזדהות אמיתית עם קוד PIN אישי + Token חתום שהשרת מאמת בעצמו.
 *
 * למה זה הכרחי: בגרסה הקודמת getCurrentUser() קיבל userId מהלקוח וסמך עליו
 * בעיוורון - כל אחד יכול היה לשלוח userId של אחמ"ש/Admin ולעקוף הרשאות
 * לגמרי. עכשיו: התחברות דורשת PIN, והשרת מנפיק Token חתום (HMAC) עם תוקף
 * מוגבל. כל קריאה עתידית עוברת אימות חתימה בצד השרת - הלקוח לא יכול לזייף
 * טוקן בלי לדעת את ה-Secret שנשמר רק ב-Script Properties.
 *
 * לחיבור Google Workspace אמיתי בעתיד (רמת אבטחה גבוהה עוד יותר): אפשר
 * להוסיף בדיקה נוספת מול Session.getActiveUser().getEmail() בפריסה עם
 * גישה מוגבלת ל-Domain, כתנאי מקדים לפני login().
 */

var TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 שעות
var TOKEN_SEP = '.';

/** Secret ליצירת חתימות - נוצר אוטומטית בפעם הראשונה ונשמר ב-Script Properties, לא נחשף ללקוח אף פעם */
function getAuthSecret() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('AUTH_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('AUTH_SECRET', secret);
  }
  return secret;
}

function hmacHex(message) {
  var raw = Utilities.computeHmacSha256Signature(message, getAuthSecret());
  return raw.map(function (b) { return ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0'); }).join('');
}

function hashPin(pin) {
  return hmacHex('PIN:' + String(pin));
}

/** מנפיק Token חתום לזמן מוגבל עבור userId נתון */
function generateToken(userId) {
  var expiry = Date.now() + TOKEN_TTL_MS;
  var payload = userId + TOKEN_SEP + expiry;
  var sig = hmacHex('TOKEN:' + payload);
  return payload + TOKEN_SEP + sig;
}

/** מאמת טוקן בצד השרת - בודק חתימה ותוקף. זורק שגיאה אם משהו לא תקין. */
function verifyToken(token) {
  if (!token) throw new Error('נדרשת התחברות מחדש');
  var parts = String(token).split(TOKEN_SEP);
  if (parts.length !== 3) throw new Error('פג תוקף ההתחברות, יש להתחבר מחדש');
  var userId = parts[0], expiry = Number(parts[1]), sig = parts[2];
  var expected = hmacHex('TOKEN:' + userId + TOKEN_SEP + expiry);
  if (sig !== expected) throw new Error('אימות ההתחברות נכשל - נא להתחבר מחדש');
  if (Date.now() > expiry) throw new Error('פג תוקף ההתחברות, יש להתחבר מחדש');
  return userId;
}

/** רשימת המשתמשים להצגה במסך הכניסה (שם + תפקיד בלבד - לעולם לא PinHash) */
function getUsersForRoleSelection() {
  return readSheet(SHEET_NAMES.USERS).map(function (u) {
    return { userId: u.UserId, name: u.Name, role: u.Role, teamId: u.TeamId };
  });
}

/**
 * התחברות בפועל: מאמת PIN מול Hash שמור, ורק אם תקין מנפיק Token.
 * זו נקודת האימות היחידה שבה סיסמה נבדקת - מרגע זה, הזהות מוכחת ע"י הטוקן.
 */
function login(userId, pin) {
  var user = findById(SHEET_NAMES.USERS, 'UserId', userId);
  if (!user) throw new Error('משתמש לא נמצא');
  if (!user.PinHash || hashPin(pin) !== user.PinHash) {
    throw new Error('קוד PIN שגוי');
  }
  return {
    token: generateToken(userId),
    user: { userId: user.UserId, name: user.Name, role: user.Role, teamId: user.TeamId || null }
  };
}

/**
 * מחזיר את המשתמש הנוכחי מתוך Token חתום ומאומת - לא מתוך userId גולמי.
 * זו הפונקציה שכל שאר המערכת קוראת לה (ישירות דרך getCurrentUser, או
 * דרך requireRole) - כך שכל בדיקת הרשאה בכל קובץ מאובטחת אוטומטית.
 */
function getCurrentUser(token) {
  var userId = verifyToken(token);
  var user = findById(SHEET_NAMES.USERS, 'UserId', userId);
  if (!user) throw new Error('משתמש לא נמצא');
  return { userId: user.UserId, name: user.Name, role: user.Role, teamId: user.TeamId || null };
}

/** בדיקת הרשאה - זורק שגיאה אם התפקיד לא ברשימת המורשים */
function requireRole(token, allowedRoles) {
  var user = getCurrentUser(token);
  if (allowedRoles.indexOf(user.role) === -1) {
    throw new Error('אין לך הרשאה לבצע פעולה זו');
  }
  return user;
}

function isManagement(role) {
  return role === 'ADMIN' || role === 'SHIFT_MANAGER';
}

/** Admin/אחמ"ש בלבד: איפוס קוד PIN למשתמש אחר (למשל נציג ששכח קוד) */
function setUserPin(actorToken, targetUserId, newPin) {
  var actor = requireRole(actorToken, ['ADMIN', 'SHIFT_MANAGER']);
  if (!newPin || String(newPin).length < 4) throw new Error('קוד PIN חייב לכלול לפחות 4 ספרות');
  var target = findById(SHEET_NAMES.USERS, 'UserId', targetUserId);
  if (!target) throw new Error('משתמש לא נמצא');
  updateRow(SHEET_NAMES.USERS, target._row, { PinHash: hashPin(newPin), Claimed: true });
  writeAuditLog(actor, 'איפוס קוד PIN', 'USERS', targetUserId, '', '');
  return { success: true };
}

/** כל משתמש מחובר: שינוי קוד PIN אישי - דורש את הקוד הנוכחי כדי לאשר שזה באמת הוא */
function changeOwnPin(token, oldPin, newPin) {
  var userId = verifyToken(token);
  var user = findById(SHEET_NAMES.USERS, 'UserId', userId);
  if (!user) throw new Error('משתמש לא נמצא');
  if (hashPin(oldPin) !== user.PinHash) throw new Error('קוד ה-PIN הנוכחי שגוי');
  if (!newPin || String(newPin).length < 4) throw new Error('קוד PIN חייב לכלול לפחות 4 ספרות');
  updateRow(SHEET_NAMES.USERS, user._row, { PinHash: hashPin(newPin) });
  return { success: true };
}

/** רשימת משתמשים לניהול (מסך Admin) - כולל TeamId, ללא PinHash */
function getAllUsersForAdmin(actorToken) {
  requireRole(actorToken, ['ADMIN', 'SHIFT_MANAGER']);
  return readSheet(SHEET_NAMES.USERS).map(function (u) {
    return { userId: u.UserId, name: u.Name, role: u.Role, teamId: u.TeamId, claimed: isTrue(u.Claimed) };
  });
}

/* ============================================================
   אשף כניסה/הרשמה לנציגים: מוקד → צוות → שם.
   "כניסה ראשונה" מציגה רק נציגים שטרם תבעו (Claim) קוד PIN;
   "כניסה" מציגה רק נציגים שכבר תבעו - כך ששם לא מופיע בשני המסכים בו-זמנית.
   ============================================================ */

/** רשימת המוקדים הקיימים - נגזרת דינמית מהצוותים בפועל, לא Hardcoded */
function getDivisions() {
  var seen = {};
  readSheet(SHEET_NAMES.TEAMS).forEach(function (t) { if (t.Division) seen[t.Division] = true; });
  return Object.keys(seen);
}

/** צוותים בתוך מוקד נתון */
function getTeamsByDivision(division) {
  return readSheet(SHEET_NAMES.TEAMS)
    .filter(function (t) { return t.Division === division; })
    .map(function (t) { return { teamId: t.TeamId, name: t.Name }; });
}

function getClaimedAgentIdSet() {
  var set = {};
  readSheet(SHEET_NAMES.USERS).forEach(function (u) {
    if (u.Role === 'AGENT' && isTrue(u.Claimed)) set[u.UserId] = true;
  });
  return set;
}

/** נציגים בצוות שעדיין לא נרשמו (מוצג במסך "כניסה ראשונה") */
function getUnclaimedAgentsForTeam(teamId) {
  var claimed = getClaimedAgentIdSet();
  return readSheet(SHEET_NAMES.AGENTS)
    .filter(function (a) { return a.TeamId === teamId && a.Status !== 'INACTIVE' && !claimed[a.AgentId]; })
    .map(function (a) { return { agentId: a.AgentId, name: a.Name }; });
}

/** נציגים בצוות שכבר נרשמו (מוצג במסך "כניסה" הרגיל) */
function getClaimedAgentsForTeam(teamId) {
  var claimed = getClaimedAgentIdSet();
  return readSheet(SHEET_NAMES.AGENTS)
    .filter(function (a) { return a.TeamId === teamId && claimed[a.AgentId]; })
    .map(function (a) { return { agentId: a.AgentId, name: a.Name }; });
}

function generateRandomPin() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 ספרות, 1000-9999
}

/**
 * "כניסה ראשונה": הנציג בוחר את שמו מתוך הרשימה, והמערכת מייצרת עבורו קוד
 * PIN אקראי בן 4 ספרות ומחזירה אותו פעם אחת בלבד (רק ה-Hash נשמר בגיליון).
 * לאחר מכן השם נעלם ממסך ההרשמה ועובר להופיע רק במסך הכניסה הרגיל.
 */
function registerAgent(agentId) {
  var agent = findById(SHEET_NAMES.AGENTS, 'AgentId', agentId);
  if (!agent) throw new Error('נציג לא נמצא');
  var userRow = findById(SHEET_NAMES.USERS, 'UserId', agentId);
  if (!userRow) throw new Error('רשומת המשתמש עבור נציג זה לא נמצאה - יש לפנות למנהל המערכת');
  if (userRow.Role !== 'AGENT') throw new Error('הרשמה עצמית זמינה לנציגים בלבד. אחמ"ש/ראש צוות נכנסים דרך "כניסת ניהול".');
  if (isTrue(userRow.Claimed)) throw new Error('השם הזה כבר נרשם במערכת - יש להשתמש במסך "כניסה" הרגיל');

  var pin = generateRandomPin();
  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    updateRow(SHEET_NAMES.USERS, userRow._row, { PinHash: hashPin(pin), Claimed: true });
  } finally {
    lock.releaseLock();
  }

  logActivity('🆕 ' + agent.Name + ' הצטרף/ה למערכת', getCurrentWeekId());
  return {
    pin: pin,
    token: generateToken(agentId),
    user: { userId: agentId, name: agent.Name, role: 'AGENT', teamId: agent.TeamId }
  };
}
