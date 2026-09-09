/**
 * RotationService.gs
 * "סבב ביקורת שבועי מאוזן" - המערכת, לא האחמ"ש, מחליטה מי הבא בתור.
 *
 * מודל: לכל נציג זכאי יש לכל היותר סבב אחד (Round) בשבוע נתון, וסבב = בדיוק
 * 2 שיחות תחרות. ברגע שסבב הושלם, לא ניתן לפתוח סבב נוסף לאותו נציג באותו
 * שבוע (מונע "עוד סיבוב" בזמן שלמישהו אחר עוד אין אף סיבוב) - זו בדיוק
 * ההגנה על הוגנות שנדרשה, בלי צורך במנגנון "סיבובים מרובים" מסובך.
 *
 * ה-Rotation Queue עצמה (getNextAgentsToReview) קובעת בעצמה, באופן דטרמיניסטי
 * (לא רנדומלי), מי הבא לביקורת: נציגים בלי סבב עדיין קודמים לנציגים עם סבב.
 */

var ROUND_CALLS_REQUIRED = 2;

/** כל נציגי הצוות הפעילים - Helper פנימי, בלי בדיקת הרשאה (לשימוש פנימי בין שירותים) */
function getActiveAgentsForTeamRaw(teamId) {
  return readSheet(SHEET_NAMES.AGENTS).filter(function (a) { return a.TeamId === teamId && a.Status !== 'INACTIVE'; });
}

/** הסבב הפעיל (אם קיים) של נציג נתון לשבוע נתון - לכל היותר סבב אחד לשבוע */
function getAgentRoundForWeek(weekId, agentId) {
  return readSheet(SHEET_NAMES.WEEKLY_ROUNDS).filter(function (r) { return r.WeekId === weekId && r.AgentId === agentId; })[0] || null;
}

/** כל הסבבים של צוות לשבוע נתון */
function getTeamRoundsForWeek(weekId, teamId) {
  return readSheet(SHEET_NAMES.WEEKLY_ROUNDS).filter(function (r) { return r.WeekId === weekId && r.TeamId === teamId; });
}

/**
 * מצב הסבב המאוזן של צוות לשבוע: כל נציג זכאי + הסטטוס שלו + ספירת כיסוי.
 * DEFERRED נחשב "עדיין לא כוסה" (חוזר לבריכת הממתינים) - לא כהשלמה.
 */
function computeTeamRotationState(weekId, teamId) {
  var agents = getActiveAgentsForTeamRaw(teamId);
  var rounds = getTeamRoundsForWeek(weekId, teamId);
  var roundByAgent = {};
  rounds.forEach(function (r) { roundByAgent[r.AgentId] = r; });

  var agentStates = agents.map(function (a) {
    var round = roundByAgent[a.AgentId];
    var status = round ? round.Status : 'NOT_STARTED'; // NOT_STARTED | PENDING | IN_PROGRESS | COMPLETE | DEFERRED
    var callIds = round ? JSON.parse(round.CallReviewIdsJson || '[]') : [];
    return {
      agentId: a.AgentId,
      name: a.Name,
      roundStatus: status,
      callsCompleted: callIds.length,
      roundId: round ? round.RoundId : null,
      deferredReason: round ? round.DeferredReason : null,
      needsReview: (status === 'NOT_STARTED' || status === 'DEFERRED' || status === 'PENDING' || status === 'IN_PROGRESS')
    };
  });

  var completed = agentStates.filter(function (a) { return a.roundStatus === 'COMPLETE'; }).length;
  var deferred = agentStates.filter(function (a) { return a.roundStatus === 'DEFERRED'; }).length;
  var pending = agentStates.length - completed; // כולל NOT_STARTED, IN_PROGRESS, DEFERRED, PENDING

  return {
    teamId: teamId,
    eligibleCount: agentStates.length,
    completedCount: completed,
    pendingCount: pending,
    deferredCount: deferred,
    coveragePercent: agentStates.length ? round1((completed / agentStates.length) * 100) : 100,
    agents: agentStates
  };
}

/**
 * מציע את הנציגים הבאים לביקורת בצוות, בסדר הוגן דטרמיניסטי - לא רנדומלי:
 * קודם מי שעדיין לא התחיל (NOT_STARTED/DEFERRED), אחר כך מי שבאמצע סבב
 * (IN_PROGRESS - להשלים את השיחה השנייה שלו), לעולם לא מי שכבר COMPLETE.
 * בתוך כל שכבה - סדר יציב לפי AgentId (לא סדר גיליון מקרי).
 */
function getNextAgentsToReview(weekId, teamId, count) {
  var state = computeTeamRotationState(weekId, teamId);
  var priority = { 'IN_PROGRESS': 0, 'DEFERRED': 1, 'NOT_STARTED': 2, 'PENDING': 2 };
  var candidates = state.agents.filter(function (a) { return a.needsReview; });
  candidates.sort(function (a, b) {
    var pa = priority[a.roundStatus], pb = priority[b.roundStatus];
    if (pa !== pb) return pa - pb;
    return a.agentId < b.agentId ? -1 : (a.agentId > b.agentId ? 1 : 0);
  });
  return candidates.slice(0, count || 2);
}

/**
 * פותח/ממשיך סבב תחרות עבור נציג. אם יש כבר סבב DEFERRED - מפעיל אותו מחדש
 * (לא יוצר כפול). אם יש כבר סבב COMPLETE - זורק שגיאה (ההגנה על "לא עוד
 * סיבוב לפני שלכולם יש אחד" ממומשת ע"י כך שלכל נציג מותר סבב אחד בלבד לשבוע).
 * נקרא תמיד מתוך Lock (על ידי הקורא, saveCallReview) כדי למנוע שני אחמ"שים
 * מיוצרים שני סבבים תקפים לאותו נציג/שבוע.
 */
function getOrCreateAgentRound(weekId, teamId, agentId) {
  var existing = getAgentRoundForWeek(weekId, agentId);
  if (existing) {
    if (existing.Status === 'COMPLETE') {
      throw new Error('ROUND_ALREADY_COMPLETE');
    }
    if (existing.Status === 'DEFERRED') {
      updateRow(SHEET_NAMES.WEEKLY_ROUNDS, existing._row, { Status: 'IN_PROGRESS', DeferredReason: '' });
      existing.Status = 'IN_PROGRESS';
    }
    return existing;
  }
  var record = {
    RoundId: generateId('rnd'),
    WeekId: weekId,
    TeamId: teamId,
    AgentId: agentId,
    RoundNumber: 1,
    Status: 'PENDING',
    AssignedDate: nowIso(),
    CompletedDate: '',
    CallReviewIdsJson: '[]',
    DeferredReason: ''
  };
  appendRow(SHEET_NAMES.WEEKLY_ROUNDS, record);
  record._row = null; // ייקרא מחדש בבדיקה הבאה אם צריך; לא נדרש לעדכון מיידי כאן
  return record;
}

/**
 * שלב 1 מתוך 2 בצירוף בדיקה לסבב: מוצא/יוצר/מפעיל-מחדש את הסבב של הנציג,
 * *לפני* שידוע ה-ReviewId (כי צריך לתייג את שורת ה-CALL_REVIEWS בו). זורק
 * אם הסבב כבר הושלם (2/2) - זו ההגנה מפני "שיחה שלישית"/"סבב שני".
 * נקרא תמיד מתוך אותו Lock כמו הכתיבה עצמה (ב-saveCallReview).
 */
function attachReviewToRoundPreCheck(weekId, teamId, agentId) {
  var round = getOrCreateAgentRound(weekId, teamId, agentId);
  if (!round._row) {
    round = readSheet(SHEET_NAMES.WEEKLY_ROUNDS).filter(function (r) { return r.RoundId === round.RoundId; })[0];
  }
  var callIds = JSON.parse(round.CallReviewIdsJson || '[]');
  if (callIds.length >= ROUND_CALLS_REQUIRED) throw new Error('ROUND_ALREADY_COMPLETE');
  return { roundId: round.RoundId, roundRow: round };
}

/** שלב 2 מתוך 2: אחרי שנכתבה שורת ה-CALL_REVIEWS, מעדכן את הסבב עם ה-ReviewId החדש ומתקדם בסטטוס */
function finalizeRoundAttachment(roundRow, reviewId) {
  var callIds = JSON.parse(roundRow.CallReviewIdsJson || '[]');
  callIds.push(reviewId);
  var newStatus = callIds.length >= ROUND_CALLS_REQUIRED ? 'COMPLETE' : 'IN_PROGRESS';
  var updates = { CallReviewIdsJson: JSON.stringify(callIds), Status: newStatus };
  if (newStatus === 'COMPLETE') updates.CompletedDate = nowIso();
  updateRow(SHEET_NAMES.WEEKLY_ROUNDS, roundRow._row, updates);
  return { roundId: roundRow.RoundId, callsCompleted: callIds.length, newStatus: newStatus };
}

/**
 * דוחה נציג שהוקצה לו סבב אך לא זמין (חופש/מחלה/וכו') - חוזר לבריכת
 * הממתינים (לא נספר כהשלמה), ונשאר גלוי כדורש ביקורת עדיין.
 */
function deferAgentRound(currentUserId, weekId, teamId, agentId, reason) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var round = getAgentRoundForWeek(weekId, agentId);
    if (!round) {
      round = getOrCreateAgentRound(weekId, teamId, agentId);
      round = readSheet(SHEET_NAMES.WEEKLY_ROUNDS).filter(function (r) { return r.RoundId === round.RoundId; })[0];
    }
    if (round.Status === 'COMPLETE') throw new Error('הסבב של נציג זה כבר הושלם - אין מה לדחות');
    updateRow(SHEET_NAMES.WEEKLY_ROUNDS, round._row, { Status: 'DEFERRED', DeferredReason: reason || '' });
    writeAuditLog(user, 'דחיית סבב ביקורת (נציג לא זמין)', 'WEEKLY_ROUNDS', round.RoundId, round.Status, 'DEFERRED: ' + (reason || ''));
    invalidateWeekCache(weekId);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/** כיסוי שבועי לכל הצוותים, מקובץ לפי מוקד - "מי עוד צריך ביקורת השבוע" ברמת המערכת כולה */
function getWeeklyCoverage(currentUserId, weekId) {
  requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  weekId = weekId || getCurrentWeekId();
  var teams = readSheet(SHEET_NAMES.TEAMS);
  var byDivision = {};
  teams.forEach(function (t) {
    var state = computeTeamRotationState(weekId, t.TeamId);
    var entry = { teamId: t.TeamId, teamName: t.Name, division: t.Division,
      eligibleCount: state.eligibleCount, completedCount: state.completedCount,
      pendingCount: state.pendingCount, deferredCount: state.deferredCount, coveragePercent: state.coveragePercent };
    (byDivision[t.Division] = byDivision[t.Division] || []).push(entry);
  });
  return Object.keys(byDivision).sort().map(function (division) {
    var teamsInDiv = byDivision[division];
    var eligible = teamsInDiv.reduce(function (s, t) { return s + t.eligibleCount; }, 0);
    var completed = teamsInDiv.reduce(function (s, t) { return s + t.completedCount; }, 0);
    return { division: division, teams: teamsInDiv, eligibleCount: eligible, completedCount: completed,
      coveragePercent: eligible ? round1((completed / eligible) * 100) : 100 };
  });
}

/** "היום האחמ"ש צריך לבדוק" - לכל צוות, הנציגים הבאים בתור לפי הסבב המאוזן */
function getTodaysReviewPlan(currentUserId, weekId) {
  requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  weekId = weekId || getCurrentWeekId();
  var teams = readSheet(SHEET_NAMES.TEAMS);
  return teams.map(function (t) {
    var next = getNextAgentsToReview(weekId, t.TeamId, 2);
    var state = computeTeamRotationState(weekId, t.TeamId);
    return { teamId: t.TeamId, teamName: t.Name, division: t.Division, nextAgents: next,
      coveragePercent: state.coveragePercent, completedCount: state.completedCount, eligibleCount: state.eligibleCount };
  });
}

/** רשימת "חריגים" תפעוליים לתשומת לב אחמ"ש - מוצג במסך הבית */
function getRotationExceptions(currentUserId, weekId) {
  requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  weekId = weekId || getCurrentWeekId();
  var exceptions = [];
  var teams = readSheet(SHEET_NAMES.TEAMS);
  teams.forEach(function (t) {
    var state = computeTeamRotationState(weekId, t.TeamId);
    state.agents.forEach(function (a) {
      if (a.roundStatus === 'IN_PROGRESS') exceptions.push({ level: 'warning', message: a.name + ' (' + t.Name + ') - חסרה שיחה שנייה להשלמת הסבב' });
      if (a.roundStatus === 'DEFERRED') exceptions.push({ level: 'warning', message: a.name + ' (' + t.Name + ') - נדחה, עדיין דורש ביקורת' });
    });
    if (state.coveragePercent < 100 && state.eligibleCount > 0) {
      exceptions.push({ level: 'info', message: t.Name + ': כיסוי ' + state.coveragePercent + '% בלבד (' + state.completedCount + '/' + state.eligibleCount + ')' });
    }
  });
  return exceptions;
}
