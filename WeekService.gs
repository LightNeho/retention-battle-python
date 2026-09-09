/**
 * WeekService.gs
 * ניהול שבועות. אין מחיקת מידע - כל שבוע ממשיך להתקיים ב-CALL_REVIEWS,
 * וסגירת שבוע רק יוצרת Snapshot היסטורי ב-WEEKLY_RESULTS ו-HALL_OF_FAME.
 */

/** השבוע הפעיל כרגע במערכת (נשלט מ-CONFIG, ניתן למעבר ידני לצפייה בלבד) */
function getCurrentWeekId() {
  var config = readConfig();
  return config.CurrentWeekId || getWeekId();
}

/** רשימת שבועות זמינים לבחירה בתפריט (כל השבועות שיש להם נתונים + השבוע הנוכחי) */
function getAvailableWeeks() {
  var reviews = readSheet(SHEET_NAMES.CALL_REVIEWS);
  var weekSet = {};
  reviews.forEach(function (r) { weekSet[r.WeekId] = true; });
  weekSet[getCurrentWeekId()] = true;
  return Object.keys(weekSet).sort().reverse();
}

/** מידע לתצוגת הכותרת: מספר שבוע + טיימר לסיום */
function getWeekMeta(weekId) {
  var range = getWeekRange(weekId);
  var isCurrent = weekId === getCurrentWeekId();
  return {
    weekId: weekId,
    startDate: range.start.toISOString(),
    endDate: range.end.toISOString(),
    isCurrent: isCurrent
  };
}

var SNAPSHOT_VERSION = 1;

/** true אם השבוע כבר נסגר - נקודת ההכרעה היחידה בין "חי" (מחושב) ל"קפוא" (Snapshot) */
function isWeekClosed(weekId) {
  return readSheet(SHEET_NAMES.WEEKLY_RESULTS).some(function (r) { return r.WeekId === weekId; });
}

/**
 * מחזיר את ה-Snapshot הקפוא של שבוע סגור, מפוענח מ-JSON, או null אם השבוע
 * עדיין פעיל (לא נסגר). זו נקודת הכניסה היחידה שמסכי היסטוריה צריכים לקרוא
 * לה - לעולם לא לחשב מחדש שבוע סגור מ-CONFIG הנוכחי.
 */
function getWeekSnapshot(weekId) {
  var row = readSheet(SHEET_NAMES.WEEKLY_RESULTS).filter(function (r) { return r.WeekId === weekId; })[0];
  if (!row) return null;
  return {
    weekId: row.WeekId,
    closedAt: row.ClosedAt,
    closedBy: row.ClosedBy,
    snapshotVersion: Number(row.SnapshotVersion || 1),
    configSnapshot: JSON.parse(row.ConfigSnapshotJson || '{}'),
    winningTeamsByDivision: JSON.parse(row.WinningTeamsJson || '[]'),
    mvpAgentId: row.MvpAgentId,
    mvpAgentPoints: Number(row.MvpAgentPoints || 0),
    winningLeaderId: row.WinningLeaderId,
    callOfWeekAgentId: row.CallOfWeekAgentId,
    teamLeaderboard: JSON.parse(row.TeamsSnapshot || '[]'),
    agentLeaderboard: JSON.parse(row.AgentsSnapshot || '[]'),
    leaderLeaderboard: JSON.parse(row.LeadersSnapshot || '[]'),
    totalReviewCount: Number(row.TotalReviewCount || 0),
    participatingAgentCount: Number(row.ParticipatingAgentCount || 0),
    participatingTeamCount: Number(row.ParticipatingTeamCount || 0)
  };
}

/**
 * "סיכום לפני סגירת שבוע" - מציג למנהל בדיוק מה יוקפא, לפני שהוא מאשר.
 * לא כותב כלום; ניתן לקרוא לה שוב ושוב באופן חופשי (Read-only).
 */
function getWeeklyWrapUp(currentUserId) {
  requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var weekId = getCurrentWeekId();

  if (isWeekClosed(weekId)) {
    return { alreadyClosed: true, weekId: weekId };
  }

  var teamGroups = getTeamBattleByDivision(weekId);
  var agentBoard = getAgentLeaderboard(weekId);
  var reviews = getReviewsForWeek(weekId);
  var activeAgentIds = {};
  reviews.forEach(function (r) { activeAgentIds[r.AgentId] = true; });

  var warnings = [];
  var divisionsSummary = teamGroups.map(function (group) {
    var winner = group.teams[0], runnerUp = group.teams[1];
    if (!winner) warnings.push('אין נתונים כלל במוקד ' + group.division);
    if (group.teams.some(function (t) { return t.callsReviewed === 0; })) {
      group.teams.filter(function (t) { return t.callsReviewed === 0; }).forEach(function (t) {
        warnings.push('לצוות "' + t.name + '" (' + group.division + ') אין אף בדיקת שיחה השבוע');
      });
    }
    if (winner && winner.tied) warnings.push('תיקו לא פתור במקום הראשון במוקד ' + group.division + ' (' + winner.tiedWith.length + ' צוותים נוספים באותו ניקוד)');
    return {
      division: group.division,
      winner: winner || null,
      runnerUp: runnerUp || null,
      margin: (winner && runnerUp) ? round1(winner.score - runnerUp.score) : null,
      tied: !!(winner && winner.tied)
    };
  });

  var config = readConfig();
  var scoringKeys = Object.keys(config).filter(function (k) { return k.indexOf('Weight') !== -1 || k.indexOf('Points') !== -1 || k.indexOf('Threshold') !== -1 || k.indexOf('Target') !== -1; });
  var scoringConfigPreview = {};
  scoringKeys.forEach(function (k) { scoringConfigPreview[k] = config[k]; });

  return {
    alreadyClosed: false,
    weekId: weekId,
    totalReviewCount: reviews.length,
    participatingAgentCount: Object.keys(activeAgentIds).length,
    participatingTeamCount: teamGroups.reduce(function (s, g) { return s + g.teams.length; }, 0),
    divisionsSummary: divisionsSummary,
    topAgent: agentBoard[0] || null,
    topAgentTied: !!(agentBoard[0] && agentBoard[0].tied),
    warnings: warnings,
    scoringConfigPreview: scoringConfigPreview
  };
}

/**
 * סגירת שבוע - פעולה חד-כיוונית ל-Admin/אחמ"ש בלבד.
 * יוצרת Snapshot קפוא ומלא ב-WEEKLY_RESULTS + HALL_OF_FAME, ומקדמת את השבוע
 * הנוכחי הלאה. אינה מוחקת אף רשומת CALL_REVIEWS. אחרי סגירה, שום שינוי ב-CONFIG
 * לא ישנה את התוצאה המוצגת לשבוע הזה - כל מסך היסטורי קורא מה-Snapshot בלבד
 * (getWeekSnapshot), לא מחשב מחדש.
 *
 * הגנת "סגירה כפולה": הבדיקה alreadyClosed מתבצעת אחרי רכישת ה-Lock (לא לפני) -
 * כך ששתי בקשות כמעט-בו-זמניות לא יכולות שתיהן לעבור את הבדיקה ולהיווצר שני
 * Snapshot לאותו שבוע. הבדיקה השנייה תמיד תיכשל אחרי שהראשונה סיימה לכתוב.
 */
function closeCurrentWeek(currentUserId) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var weekId = getCurrentWeekId();

  var lock = LockService.getScriptLock();
  var gotLock = lock.tryLock(15000);
  if (!gotLock) throw new Error('פעולת סגירה אחרת בעיצומה - נסה/י שוב בעוד רגע');
  try {
    if (isWeekClosed(weekId)) throw new Error('השבוע ' + weekId + ' כבר נסגר - לא ניתן לסגור פעמיים');

    var teamBoard = getTeamLeaderboard(weekId);
    var agentBoard = getAgentLeaderboard(weekId);
    var leaderBoard = getLeaderLeaderboard(weekId);
    var reviews = getReviewsForWeek(weekId);
    var activeAgentIds = {};
    reviews.forEach(function (r) { activeAgentIds[r.AgentId] = true; });

    // התחרות היא בין צוותים באותו מוקד בלבד - לכן יש צוות מנצח נפרד לכל מוקד,
    // לא זוכה אחד גורף. בונים רשימת זוכים { division, teamId, teamName, score, tied }.
    var teamGroups = getTeamBattleByDivision(weekId);
    var winningTeamsByDivision = teamGroups.map(function (group) {
      var winner = group.teams[0];
      return winner ? { division: group.division, teamId: winner.teamId, teamName: winner.name, score: winner.score, tied: !!winner.tied, tiedWith: winner.tiedWith || [] } : null;
    }).filter(Boolean);
    var mvpAgent = agentBoard[0];
    var winningLeader = leaderBoard[0];
    var callOfWeekAward = readSheet(SHEET_NAMES.BADGE_AWARDS).filter(function (a) {
      return a.WeekId === weekId;
    }).map(function (a) {
      var badge = findById(SHEET_NAMES.BADGES, 'BadgeId', a.BadgeId);
      return badge && badge.ConditionKey === 'CALL_OF_WEEK' ? a.TargetId : null;
    }).filter(Boolean)[0] || '';

    // מקפיאים את משקלי/ספי הניקוד שהיו בתוקף ברגע הסגירה - כדי ששינוי CONFIG
    // עתידי לא ישנה את ההסבר לתוצאה ההיסטורית הזו.
    var config = readConfig();

    var snapshot = {
      WeekId: weekId,
      ClosedAt: nowIso(),
      ClosedBy: user.userId,
      SnapshotVersion: SNAPSHOT_VERSION,
      ConfigSnapshotJson: JSON.stringify(config),
      WinningTeamsJson: JSON.stringify(winningTeamsByDivision),
      MvpAgentId: mvpAgent ? mvpAgent.agentId : '',
      MvpAgentPoints: mvpAgent ? mvpAgent.points : 0,
      WinningLeaderId: winningLeader ? winningLeader.leaderId : '',
      CallOfWeekAgentId: callOfWeekAward,
      TeamsSnapshot: JSON.stringify(teamBoard),
      AgentsSnapshot: JSON.stringify(agentBoard),
      LeadersSnapshot: JSON.stringify(leaderBoard),
      TotalReviewCount: reviews.length,
      ParticipatingAgentCount: Object.keys(activeAgentIds).length,
      ParticipatingTeamCount: teamGroups.reduce(function (s, g) { return s + g.teams.length; }, 0)
    };
    appendRow(SHEET_NAMES.WEEKLY_RESULTS, snapshot);

    appendRow(SHEET_NAMES.HALL_OF_FAME, {
      RecordId: generateId('hof'),
      WeekId: weekId,
      WinningTeamsJson: snapshot.WinningTeamsJson,
      MvpAgentId: snapshot.MvpAgentId,
      WinningLeaderId: snapshot.WinningLeaderId,
      CallOfWeekAgentId: snapshot.CallOfWeekAgentId
    });

    var nextWeekId = shiftWeekId(weekId, 1);
    writeConfigValue('CurrentWeekId', nextWeekId);

    writeAuditLog(user, 'סגירת שבוע', 'WEEKLY_RESULTS', weekId,
      '', JSON.stringify({ snapshotVersion: SNAPSHOT_VERSION, winners: winningTeamsByDivision, reviewCount: snapshot.TotalReviewCount, closedAt: snapshot.ClosedAt }));
    logActivity('🏁 השבוע ' + weekId + ' נסגר. השבוע החדש: ' + nextWeekId, nextWeekId);

    cacheRemove('dashboard_' + weekId);
    cacheRemove('hall_of_fame');
    cacheRemove('available_weeks');

    return { closedWeekId: weekId, newWeekId: nextWeekId, snapshot: getWeekSnapshot(weekId) };
  } finally {
    lock.releaseLock();
  }
}
