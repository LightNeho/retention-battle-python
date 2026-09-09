/**
 * SetupService.gs
 * הרצה חד-פעמית: setupCompetitionSystem() בונה את כל מבנה ה-Sheet מאפס,
 * כולל נתוני Demo, כדי שהמערכת תיראה "חיה" מהרגע הראשון.
 * הרצה חוזרת בטוחה - היא בודקת אם Tab כבר קיים ולא דורסת נתונים קיימים.
 */

var SHEET_SCHEMAS = {
  CONFIG: ['Key', 'Value'],
  USERS: ['UserId', 'Name', 'Role', 'TeamId', 'Email', 'PinHash', 'Claimed'],
  TEAMS: ['TeamId', 'Name', 'TeamLeaderId', 'Division'],
  AGENTS: ['AgentId', 'Name', 'TeamId', 'Status', 'JoinDate'],
  TEAM_LEADERS: ['LeaderId', 'Name', 'TeamId'],
  CALL_REVIEWS: ['ReviewId', 'Date', 'Time', 'Timestamp', 'ReviewerId', 'AgentId', 'TeamId', 'LeaderId', 'CustomerNumber',
    'Tashaul', 'HatamatHatzaa', 'EichutSherut', 'ReviewPurpose', 'RoundId',
    'RetentionSuccess', 'LeaveReason', 'OfferGiven', 'ExcellentCallBonus', 'ReviewerNote', 'WeekId', 'Status'],
  WEEKLY_ROUNDS: ['RoundId', 'WeekId', 'TeamId', 'AgentId', 'RoundNumber', 'Status', 'AssignedDate', 'CompletedDate', 'CallReviewIdsJson', 'DeferredReason'],
  MANAGER_TASKS: ['TaskId', 'Name', 'Description', 'Points', 'Type', 'ConditionKey', 'TargetValue', 'Active'],
  MANAGER_TASK_RESULTS: ['ResultId', 'TaskId', 'LeaderId', 'WeekId', 'Status', 'Progress', 'UpdatedAt', 'ApprovedBy'],
  BONUSES: ['BonusId', 'TargetType', 'TargetId', 'Points', 'Reason', 'WeekId', 'GivenBy', 'GivenAt'],
  BADGES: ['BadgeId', 'Name', 'Icon', 'Description', 'ConditionKey', 'MinimumSample', 'Active'],
  BADGE_AWARDS: ['AwardId', 'BadgeId', 'TargetType', 'TargetId', 'WeekId', 'AwardedAt', 'AwardedBy'],
  WEEKLY_RESULTS: ['WeekId', 'ClosedAt', 'ClosedBy', 'SnapshotVersion', 'ConfigSnapshotJson', 'WinningTeamsJson', 'MvpAgentId', 'MvpAgentPoints',
    'WinningLeaderId', 'CallOfWeekAgentId', 'TeamsSnapshot', 'AgentsSnapshot', 'LeadersSnapshot',
    'TotalReviewCount', 'ParticipatingAgentCount', 'ParticipatingTeamCount'],
  HALL_OF_FAME: ['RecordId', 'WeekId', 'WinningTeamsJson', 'MvpAgentId', 'WinningLeaderId', 'CallOfWeekAgentId'],
  ACTIVITY_LOG: ['EventId', 'Message', 'WeekId', 'Timestamp'],
  AUDIT_LOG: ['LogId', 'Timestamp', 'UserId', 'UserName', 'Action', 'EntityType', 'EntityId', 'OldValue', 'NewValue'],
  LEAVE_REASONS: ['ReasonId', 'Value', 'Active'],
  OFFERS: ['OfferId', 'Value', 'Active']
};

/** נקודת הכניסה היחידה שיש להריץ ידנית מעורך ה-Apps Script בפעם הראשונה */
function setupCompetitionSystem() {
  createAllTabs();
  seedConfig();
  seedDemoOrganization();
  seedManagerTasks();
  seedBadges();
  seedDropdowns();
  seedDemoCallReviews();
  writeConfigValue('CurrentWeekId', getWeekId());
  evaluateAutomaticTasks(getWeekId());
  evaluateBadges(getWeekId());
  SpreadsheetApp.getActiveSpreadsheet().toast('המערכת מוכנה! ראשי צוות ואחמ"שים כבר מוגדרים עם קוד PIN אישי משלהם - נכנסים דרך "כניסת ניהול". נציגים: יירשמו בעצמם דרך "כניסה ראשונה" ויקבלו קוד PIN אקראי.', 'RETENTION BATTLE', 15);
  return { success: true, message: 'ההתקנה הושלמה בהצלחה. ראשי צוות/אחמ"שים כבר מוגדרים עם PIN אישי. נציגים: נרשמים בעצמם דרך "כניסה ראשונה".' };
}

function createAllTabs() {
  var ss = getDb();
  Object.keys(SHEET_SCHEMAS).forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    var headers = SHEET_SCHEMAS[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#121827').setFontColor('#F8FAFC');
  });
  // מסיר את ה-Sheet1 ברירת המחדל אם עדיין ריק
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0) ss.deleteSheet(def);
}

function seedConfig() {
  if (readSheet(SHEET_NAMES.CONFIG).length > 0) return;
  var defaults = {
    Weight_Tashaul: 1, Weight_HatamatHatzaa: 1.2, Weight_EichutSherut: 1,
    QualityWeight: 1, RetentionSuccessPoints: 15, ExcellentCallBonusPoints: 5, PerfectCallQualityThreshold: 9,
    TeamScoreMethod: 'AVERAGE', TeamWeighted_ScoreWeight: 0.7, TeamWeighted_RetentionWeight: 0.3,
    WeeklyRetentionTargetPercent: 30,
    LeaderWeight_TeamScore: 0.4, LeaderWeight_Retention: 0.25, LeaderWeight_Improvement: 0.15, LeaderWeight_Tasks: 0.2,
    MinimumSampleSize: 3, HotStreakLength: 3
  };
  Object.keys(defaults).forEach(function (k) { writeConfigValue(k, defaults[k]); });
}

function seedDemoOrganization() {
  if (readSheet(SHEET_NAMES.TEAMS).length > 0) return;

  // כל ראש צוות מקבל PIN אישי משלו (לא ברירת מחדל משותפת) - כפי שנמסר בפועל.
  var teamDefs = [
    { division: 'שימור', name: 'פרואקטיב', leader: 'דקלה', leaderPin: '1710', agents: ['דניאל לוי', 'מאיה אברהם', 'איתי בר', 'נועה שלום', 'יובל פרץ'] },
    { division: 'שימור', name: 'פולס', leader: 'שי', leaderPin: '2105', agents: ['אורי דהן', 'טל מזרחי', 'ליאור אזולאי', 'הדר נחום'] },
    { division: 'שימור', name: 'אירון', leader: 'קסם', leaderPin: '2604', agents: ['גיל שמעוני', 'רוני חדד', 'עדי סבן', 'נדב ביטון', 'שני אוחנה'] },
    { division: 'שירות', name: 'ליגה', leader: 'פז', leaderPin: '1110', agents: ['אלון כרמי', 'קרן בוזגלו', 'עידן פיינגולד', 'מיכל טל'] },
    { division: 'שירות', name: 'טוי', leader: 'רינת', leaderPin: '2912', agents: ['שקד מלכה', 'יעל אשכנזי', 'בר כהן', 'עומרי לוין'] }
  ];

  // אחמ"שים - תפקיד ניהולי בלבד: הם נכנסים דרך "כניסת ניהול" עם PIN שנקבע להם
  // מראש, ולעולם לא דרך אשף ה"הרשמה" (זמין לנציגים בלבד - ראה registerAgent).
  var shiftManagers = [
    { name: 'נהוראי', pin: '1808' },
    { name: 'סברין', pin: '3101' },
    { name: 'שקד', pin: '2701' },
    { name: 'משי', pin: '1509' },
    { name: 'טליה', pin: '0212' }
  ];

  var teams = [], leaders = [], agents = [], users = [];

  teamDefs.forEach(function (def) {
    var teamId = generateId('tm');
    var leaderId = generateId('ldr');
    teams.push({ TeamId: teamId, Name: def.name, TeamLeaderId: leaderId, Division: def.division });
    leaders.push({ LeaderId: leaderId, Name: def.leader, TeamId: teamId });
    users.push({ UserId: leaderId, Name: def.leader, Role: 'TEAM_LEADER', TeamId: teamId, Email: '', PinHash: hashPin(def.leaderPin), Claimed: true });
    def.agents.forEach(function (agentName) {
      var agentId = generateId('agt');
      agents.push({ AgentId: agentId, Name: agentName, TeamId: teamId, Status: 'ACTIVE', JoinDate: nowIso() });
      // הנציגים נוצרים "לא תבועים" (Claimed=false, ללא PIN) בכוונה - כדי שתהליך
      // "כניסה ראשונה" יהיה ניתן לבדיקה מיידית: השם יופיע ברשימת ההרשמה עד
      // שהנציג בעצמו יבחר את שמו ויקבל קוד PIN אקראי.
      users.push({ UserId: agentId, Name: agentName, Role: 'AGENT', TeamId: teamId, Email: '', PinHash: '', Claimed: false });
    });
  });

  appendRows(SHEET_NAMES.TEAMS, teams);
  appendRows(SHEET_NAMES.TEAM_LEADERS, leaders);
  appendRows(SHEET_NAMES.AGENTS, agents);

  shiftManagers.forEach(function (sm) {
    users.push({ UserId: generateId('sm'), Name: sm.name, Role: 'SHIFT_MANAGER', TeamId: '', Email: '', PinHash: hashPin(sm.pin), Claimed: true });
  });
  appendRows(SHEET_NAMES.USERS, users);
}

function seedManagerTasks() {
  if (readSheet(SHEET_NAMES.MANAGER_TASKS).length > 0) return;
  var tasks = [
    { TaskId: generateId('task'), Name: '80% ציוני איכות מעל 8', Description: '80% מהצוות קיבלו ציון איכות ממוצע 8 ומעלה', Points: 20, Type: 'AUTO', ConditionKey: 'TEAM_QUALITY_PERCENT_ABOVE', TargetValue: 80, Active: true },
    { TaskId: generateId('task'), Name: 'כיסוי מלא', Description: 'כל הנציגים בצוות קיבלו לפחות בדיקת שיחה אחת השבוע', Points: 15, Type: 'AUTO', ConditionKey: 'ALL_AGENTS_REVIEWED', TargetValue: 100, Active: true },
    { TaskId: generateId('task'), Name: 'שיפור שבועי', Description: 'ניקוד הצוות השבוע גבוה מהשבוע הקודם', Points: 10, Type: 'AUTO', ConditionKey: 'TEAM_IMPROVED', TargetValue: 0, Active: true },
    { TaskId: generateId('task'), Name: '5 שימורים לפחות', Description: '5 נציגים בצוות ביצעו לפחות שימור מוצלח אחד', Points: 15, Type: 'AUTO', ConditionKey: 'AGENTS_WITH_RETENTION_COUNT', TargetValue: 5, Active: true },
    { TaskId: generateId('task'), Name: 'יעד שימור', Description: 'אחוז השימור של הצוות עבר את היעד השבועי', Points: 20, Type: 'AUTO', ConditionKey: 'RETENTION_RATE_ABOVE_TARGET', TargetValue: 30, Active: true },
    { TaskId: generateId('task'), Name: 'תשאול לדוגמה', Description: 'ממוצע ציון התשאול של הצוות מעל 8', Points: 10, Type: 'AUTO', ConditionKey: 'AVG_QUESTIONING_ABOVE', TargetValue: 8, Active: true },
    { TaskId: generateId('task'), Name: 'פידבק אישי לכל נציג', Description: 'ראש הצוות נתן פידבק אישי לכל נציג השבוע', Points: 10, Type: 'MANUAL', ConditionKey: '', TargetValue: 0, Active: true },
    { TaskId: generateId('task'), Name: '150 נקודות צוות', Description: 'הצוות הגיע ל-150 נקודות מצטברות השבוע', Points: 25, Type: 'AUTO', ConditionKey: 'TEAM_POINTS_ABOVE', TargetValue: 150, Active: true }
  ];
  appendRows(SHEET_NAMES.MANAGER_TASKS, tasks);
}

function seedBadges() {
  if (readSheet(SHEET_NAMES.BADGES).length > 0) return;
  var badges = [
    { BadgeId: generateId('bdg'), Name: 'HOT STREAK', Icon: '🔥', Description: '3 שימורים מוצלחים ברצף', ConditionKey: 'HOT_STREAK', MinimumSample: 0, Active: true },
    { BadgeId: generateId('bdg'), Name: 'הצלף', Icon: '🎯', Description: 'אחוז השימור הגבוה ביותר', ConditionKey: 'HIGHEST_SUCCESS_RATE', MinimumSample: 3, Active: true },
    { BadgeId: generateId('bdg'), Name: 'המתשאל', Icon: '🕵️', Description: 'ממוצע התשאול הגבוה ביותר', ConditionKey: 'HIGHEST_AVG_QUESTIONING', MinimumSample: 3, Active: true },
    { BadgeId: generateId('bdg'), Name: 'מלך השירות', Icon: '❤️', Description: 'ממוצע איכות השירות הגבוה ביותר', ConditionKey: 'HIGHEST_AVG_SERVICE_QUALITY', MinimumSample: 3, Active: true },
    { BadgeId: generateId('bdg'), Name: 'הקאמבק', Icon: '🚀', Description: 'העלייה הגדולה ביותר בדירוג', ConditionKey: 'BIGGEST_COMEBACK', MinimumSample: 0, Active: true },
    { BadgeId: generateId('bdg'), Name: 'שיחת השבוע', Icon: '⭐', Description: 'נבחרה ידנית ע"י אחמ"ש', ConditionKey: 'CALL_OF_WEEK', MinimumSample: 0, Active: true },
    { BadgeId: generateId('bdg'), Name: 'MVP', Icon: '🏆', Description: 'הנציג עם הניקוד הגבוה ביותר', ConditionKey: 'MVP', MinimumSample: 0, Active: true },
    { BadgeId: generateId('bdg'), Name: 'PERFECT CALL', Icon: '💎', Description: 'שיחה עם ציון איכות גבוה שהסתיימה בשימור', ConditionKey: 'PERFECT_CALL', MinimumSample: 0, Active: true }
  ];
  appendRows(SHEET_NAMES.BADGES, badges);
}

function seedDropdowns() {
  if (readSheet(SHEET_NAMES.LEAVE_REASONS).length === 0) {
    appendRows(SHEET_NAMES.LEAVE_REASONS, ['מחיר', 'שירות לקוי', 'מתחרים', 'חוסר שימוש', 'מעבר דירה/סגירת עסק', 'אחר'].map(function (v) {
      return { ReasonId: generateId('lr'), Value: v, Active: true };
    }));
  }
  if (readSheet(SHEET_NAMES.OFFERS).length === 0) {
    appendRows(SHEET_NAMES.OFFERS, ['הנחה זמנית', 'שדרוג חבילה', 'חודש מתנה', 'הקפאת חשבון', 'שירות נוסף ללא עלות'].map(function (v) {
      return { OfferId: generateId('of'), Value: v, Active: true };
    }));
  }
}

/** יוצר 35-45 בדיקות שיחה מדומות לשבוע הנוכחי, כדי שהדשבורד לא יהיה ריק */
function seedDemoCallReviews() {
  if (readSheet(SHEET_NAMES.CALL_REVIEWS).length > 0) return;
  var agents = readSheet(SHEET_NAMES.AGENTS);
  var reasons = getLeaveReasons();
  var offers = getOffers();
  var weekId = getWeekId();
  var reviewerId = readSheet(SHEET_NAMES.USERS).filter(function (u) { return u.Role === 'SHIFT_MANAGER'; })[0].UserId;
  var teamsMap = {};
  readSheet(SHEET_NAMES.TEAMS).forEach(function (t) { teamsMap[t.TeamId] = t; });

  var records = [];
  var reviewCount = 38;
  var today = new Date();

  for (var i = 0; i < reviewCount; i++) {
    var agent = agents[Math.floor(Math.random() * agents.length)];
    var team = teamsMap[agent.TeamId];
    var dayOffset = Math.floor(Math.random() * 5); // ראשון-חמישי
    var reviewDate = new Date(today);
    reviewDate.setDate(today.getDate() - reviewDate.getDay() + dayOffset);
    var success = Math.random() < 0.55;

    var reviewRecord = {
      ReviewId: generateId('rev'),
      Date: Utilities.formatDate(reviewDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      Time: (8 + Math.floor(Math.random() * 9)) + ':' + (Math.random() < 0.5 ? '00' : '30'),
      Timestamp: reviewDate.toISOString(),
      ReviewerId: reviewerId,
      AgentId: agent.AgentId,
      TeamId: agent.TeamId,
      LeaderId: team.TeamLeaderId,
      CustomerNumber: '05' + Math.floor(10000000 + Math.random() * 89999999),
      RetentionSuccess: success ? 'כן' : 'לא',
      LeaveReason: reasons[Math.floor(Math.random() * reasons.length)],
      OfferGiven: success ? offers[Math.floor(Math.random() * offers.length)] : '',
      ExcellentCallBonus: Math.random() < 0.1 ? 'כן' : 'לא',
      ReviewerNote: 'שיחה נבדקה במסגרת בקרת איכות שוטפת.',
      WeekId: weekId,
      Status: 'ACTIVE'
    };
    CALL_CATEGORIES.forEach(function (cat) { reviewRecord[cat] = randScore(); });
    records.push(reviewRecord);
  }
  appendRows(SHEET_NAMES.CALL_REVIEWS, records);
}

function randScore() {
  return Math.floor(5 + Math.random() * 6); // 5-10, מציאותי יותר מטווח מלא
}
