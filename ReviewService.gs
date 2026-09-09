/**
 * ReviewService.gs
 * מסך "בדיקת שיחת שימור". כל שמירה/עדכון מפעילה מחדש הערכת משימות אוטומטיות
 * ו-Badges, ומנקה את ה-Cache הרלוונטי לשבוע - כדי שהדשבורד יהיה עדכני מיידית.
 */

var REVIEW_LOCK_TIMEOUT_MS = 10000;

/** שומר בדיקת שיחה חדשה. מחזיר את הרשומה שנוצרה, או אזהרת כפילות אם נמצא חשד לשיחה כפולה. */
function saveCallReview(currentUserId, data) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  validateReviewPayload(data);

  var agent = findById(SHEET_NAMES.AGENTS, 'AgentId', data.agentId);
  if (!agent) throw new Error('נציג לא נמצא');
  var team = findById(SHEET_NAMES.TEAMS, 'TeamId', agent.TeamId);
  var weekId = data.date ? getWeekId(data.date) : getWeekId();
  if (isWeekClosed(weekId)) throw new Error('השבוע ' + weekId + ' כבר נסגר - לא ניתן להוסיף בדיקות שיחה עבורו יותר');

  var lock = LockService.getScriptLock();
  lock.waitLock(REVIEW_LOCK_TIMEOUT_MS);
  try {
    var purpose = data.reviewPurpose === 'QA' || data.reviewPurpose === 'COACHING' ? data.reviewPurpose : 'COMPETITION';

    // "כבר הושלם סבב תחרות השבוע" - חוסם שיחה שלישית / סבב שני לאותו נציג
    // באותו שבוע (זו ההגנה על ההוגנות: אי אפשר לתת לנציג עוד הזדמנות ניקוד
    // לפני שלכל השאר יש סבב אחד). לא חוסם QA/Coaching - אלה לא נספרים בניקוד.
    if (purpose === 'COMPETITION' && !data.forceExtraCompetitionRound) {
      var existingRound = getAgentRoundForWeek(weekId, agent.AgentId);
      if (existingRound && existingRound.Status === 'COMPLETE') {
        return {
          alreadyCompletedWarning: true,
          message: 'הנציג הזה כבר השלים את ביקורת התחרות השבועית.\nניתן לשמור ביקורות נוספות כ-QA / Coaching, אך הן לא ישפיעו על ניקוד התחרות.'
        };
      }
    }

    // הגנת כפילות: לא חוסמים בשקט ולא קובעים "מספר לקוח" כייחודי גלובלית
    // (אותו לקוח יכול להתקשר כמה פעמים באמת) - רק מזהירים אם יש כבר בדיקה
    // פעילה לאותו נציג+לקוח באותו שבוע, ונותנים למנהל להחליט במודע.
    if (!data.confirmDuplicate) {
      var duplicate = findLikelyDuplicateReview(agent.AgentId, data.customerNumber, weekId, null);
      if (duplicate) {
        return { duplicateWarning: true, existing: duplicate };
      }
    }

    // עבור תחרות: יוצר/ממשיך את הסבב המאוזן של הנציג *לפני* כתיבת השורה,
    // כדי שאפשר יהיה לתייג את הבדיקה ב-RoundId וגם לזרוק אם הסבב כבר מלא
    // (הגנה מפני "שיחה שלישית" גם אם שני אחמ"שים לחצו כמעט בו-זמנית - זה
    // קורה בתוך אותו Lock, לפני כתיבת הרשומה עצמה).

    var record = {
      ReviewId: generateId('rev'),
      Date: data.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      Time: data.time || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm'),
      Timestamp: nowIso(),
      ReviewerId: user.userId,
      AgentId: agent.AgentId,
      TeamId: agent.TeamId,
      LeaderId: team ? team.TeamLeaderId : '',
      CustomerNumber: data.customerNumber || '',
      ReviewPurpose: purpose,
      RoundId: '',
      RetentionSuccess: data.retentionSuccess === true || data.retentionSuccess === 'כן' ? 'כן' : 'לא',
      LeaveReason: data.leaveReason || '',
      OfferGiven: data.offerGiven || '',
      ExcellentCallBonus: data.excellentCallBonus ? 'כן' : 'לא',
      ReviewerNote: data.reviewerNote || '',
      WeekId: weekId,
      Status: 'ACTIVE'
    };
    // ציוני הקטגוריות (תשאול נכון / הצעה מותאמת ללקוח / שירות איכותי) נבנים
    // דינמית מתוך CALL_CATEGORIES - כך שהוספה/הסרה של קטגוריה בעתיד תדרוש
    // שינוי במקום אחד בלבד (CompetitionService.gs) ולא כאן.
    CALL_CATEGORIES.forEach(function (cat) { record[cat] = clampScore(data[cat], 0, 10); });

    var attachResult = null;
    var finalizeResult = null;
    if (purpose === 'COMPETITION') {
      // זורק ROUND_ALREADY_COMPLETE אם מישהו הספיק לסגור את הסבב בין שתי הבדיקות למעלה לבין כאן
      attachResult = attachReviewToRoundPreCheck(weekId, agent.TeamId, agent.AgentId);
      record.RoundId = attachResult.roundId;
    }

    appendRow(SHEET_NAMES.CALL_REVIEWS, record);

    if (purpose === 'COMPETITION') {
      finalizeResult = finalizeRoundAttachment(attachResult.roundRow, record.ReviewId);
    }

    var config = readConfig();
    var quality = computeQualityScore(record, config);
    var purposeLabel = purpose === 'COMPETITION' ? '' : (' [' + (purpose === 'QA' ? 'QA' : 'Coaching') + ']');
    logActivity(
      (record.RetentionSuccess === 'כן' ? '🔥 ' : '📋 ') + agent.Name +
      (record.RetentionSuccess === 'כן' ? ' ביצע/ה שימור נוסף' : ' עברה בדיקת שיחה') + purposeLabel,
      weekId
    );

    invalidateWeekCache(weekId);
    if (purpose === 'COMPETITION') {
      evaluateAutomaticTasks(weekId);
      evaluateBadges(weekId);
    }
    writeAuditLog(user, 'הזנת בדיקת שיחה (' + purpose + ')', 'CALL_REVIEWS', record.ReviewId, '', JSON.stringify(record));
    if (data.confirmDuplicate) {
      writeAuditLog(user, 'אישור שמירה למרות התראת כפילות', 'CALL_REVIEWS', record.ReviewId,
        '', JSON.stringify({ agentId: agent.AgentId, customerNumber: record.CustomerNumber, weekId: weekId }));
    }

    return {
      reviewId: record.ReviewId,
      qualityScore: quality,
      reviewPurpose: purpose,
      roundStatus: finalizeResult ? finalizeResult.newStatus : null,
      callsCompletedInRound: finalizeResult ? finalizeResult.callsCompleted : null
    };
  } finally {
    lock.releaseLock();

  }
}

/**
 * מחפש בדיקה פעילה קיימת לאותו נציג+מספר לקוח באותו שבוע - חלון "סביר" לחשד
 * כפילות בלי לחסום שיחות חוזרות לגיטימיות (אותו לקוח יכול להתקשר כמה פעמים).
 * לא בודק "ייחודיות גלובלית" - זו בכוונה בדיקת חשד, לא איסור.
 */
function findLikelyDuplicateReview(agentId, customerNumber, weekId, excludeReviewId) {
  if (!customerNumber) return null;
  var rows = readSheet(SHEET_NAMES.CALL_REVIEWS).filter(function (r) {
    return r.AgentId === agentId && r.CustomerNumber === customerNumber &&
      r.WeekId === weekId && r.Status !== 'CANCELLED' && r.ReviewId !== excludeReviewId;
  });
  if (!rows.length) return null;
  rows.sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); });
  var r = rows[0];
  var reviewerNames = {};
  readSheet(SHEET_NAMES.USERS).forEach(function (u) { reviewerNames[u.UserId] = u.Name; });
  return {
    reviewId: r.ReviewId,
    date: r.Date,
    time: r.Time,
    reviewerName: reviewerNames[r.ReviewerId] || 'לא ידוע',
    customerNumber: r.CustomerNumber,
    qualityScore: computeQualityScore(r, readConfig())
  };
}

/** עדכון בדיקה קיימת */
function updateCallReview(currentUserId, reviewId, data) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var review = findById(SHEET_NAMES.CALL_REVIEWS, 'ReviewId', reviewId);
  if (!review) throw new Error('הבדיקה לא נמצאה');
  if (isWeekClosed(review.WeekId)) throw new Error('השבוע ' + review.WeekId + ' כבר נסגר - לא ניתן לערוך בדיקות שיחה משבוע סגור');
  var before = JSON.stringify(review);

  var lock = LockService.getScriptLock();
  lock.waitLock(REVIEW_LOCK_TIMEOUT_MS);
  try {
    var updates = {};
    CALL_CATEGORIES.forEach(function (cat) {
      if (data[cat] !== undefined) updates[cat] = clampScore(data[cat], 0, 10);
    });
    if (data.retentionSuccess !== undefined) {
      updates.RetentionSuccess = (data.retentionSuccess === true || data.retentionSuccess === 'כן') ? 'כן' : 'לא';
    }
    if (data.leaveReason !== undefined) updates.LeaveReason = data.leaveReason;
    if (data.offerGiven !== undefined) updates.OfferGiven = data.offerGiven;
    if (data.excellentCallBonus !== undefined) updates.ExcellentCallBonus = data.excellentCallBonus ? 'כן' : 'לא';
    if (data.reviewerNote !== undefined) updates.ReviewerNote = data.reviewerNote;
    if (data.customerNumber !== undefined) updates.CustomerNumber = data.customerNumber;

    updateRow(SHEET_NAMES.CALL_REVIEWS, review._row, updates);
    writeAuditLog(user, 'עריכת בדיקת שיחה', 'CALL_REVIEWS', reviewId, before, JSON.stringify(updates));
    invalidateWeekCache(review.WeekId);
    evaluateAutomaticTasks(review.WeekId);
    evaluateBadges(review.WeekId);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/** ביטול בדיקה (Soft Delete) - הרשומה נשמרת בהיסטוריה אך לא נכללת בחישובים */
function cancelCallReview(currentUserId, reviewId, reason) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var review = findById(SHEET_NAMES.CALL_REVIEWS, 'ReviewId', reviewId);
  if (!review) throw new Error('הבדיקה לא נמצאה');
  if (isWeekClosed(review.WeekId)) throw new Error('השבוע ' + review.WeekId + ' כבר נסגר - לא ניתן לבטל בדיקות שיחה משבוע סגור');

  updateRow(SHEET_NAMES.CALL_REVIEWS, review._row, {
    Status: 'CANCELLED',
    ReviewerNote: (review.ReviewerNote || '') + '\n[בוטל ע"י ' + user.name + ': ' + (reason || '') + ']'
  });

  // קריטי: אם השיחה הייתה חלק מסבב תחרות, חייבים לשחרר את המקום שלה בסבב -
  // אחרת סבב שסומן COMPLETE יישאר "מלא" לצמיתות למרות ששיחה תקפה אחת בלבד
  // (או אפס) נשארה בו בפועל, וזה חוסם את הנציג מלקבל השלמה הוגנת.
  if (review.RoundId) {
    var round = readSheet(SHEET_NAMES.WEEKLY_ROUNDS).filter(function (r) { return r.RoundId === review.RoundId; })[0];
    if (round) {
      var callIds = JSON.parse(round.CallReviewIdsJson || '[]').filter(function (id) { return id !== reviewId; });
      var newStatus = callIds.length >= ROUND_CALLS_REQUIRED ? 'COMPLETE' : (callIds.length > 0 ? 'IN_PROGRESS' : 'PENDING');
      updateRow(SHEET_NAMES.WEEKLY_ROUNDS, round._row, {
        CallReviewIdsJson: JSON.stringify(callIds), Status: newStatus, CompletedDate: newStatus === 'COMPLETE' ? round.CompletedDate : ''
      });
    }
  }

  writeAuditLog(user, 'ביטול בדיקת שיחה', 'CALL_REVIEWS', reviewId, 'ACTIVE', 'CANCELLED');
  invalidateWeekCache(review.WeekId);
  evaluateAutomaticTasks(review.WeekId);
  evaluateBadges(review.WeekId);
  return { success: true };
}

function validateReviewPayload(data) {
  assertField(data.agentId, 'נציג');
  assertField(data.customerNumber, 'מספר לקוח');
  CALL_CATEGORIES.forEach(function (cat) {
    if (data[cat] === undefined || data[cat] === null || data[cat] === '') {
      throw new Error('חסר ציון לקטגוריה: ' + cat);
    }
  });
}

/** רשימת בדיקות שיחה לשבוע, עם סינון אופציונלי לפי נציג/צוות - למסכי היסטוריה וניהול */
function getCallReviews(weekId, filters) {
  filters = filters || {};
  var reviews = readSheet(SHEET_NAMES.CALL_REVIEWS).filter(function (r) { return r.WeekId === weekId; });
  if (filters.agentId) reviews = reviews.filter(function (r) { return r.AgentId === filters.agentId; });
  if (filters.teamId) reviews = reviews.filter(function (r) { return r.TeamId === filters.teamId; });
  if (filters.includeCancelled !== true) reviews = reviews.filter(function (r) { return r.Status !== 'CANCELLED'; });

  var config = readConfig();
  return reviews.map(function (r) {
    return {
      reviewId: r.ReviewId,
      date: r.Date,
      time: r.Time,
      agentId: r.AgentId,
      teamId: r.TeamId,
      qualityScore: computeQualityScore(r, config),
      retentionSuccess: r.RetentionSuccess,
      leaveReason: r.LeaveReason,
      offerGiven: r.OfferGiven,
      excellentCallBonus: r.ExcellentCallBonus,
      status: r.Status,
      reviewerId: r.ReviewerId
    };
  }).sort(function (a, b) { return new Date(b.date + ' ' + b.time) - new Date(a.date + ' ' + a.time); });
}

/** פרטי בדיקה מלאים כולל הערת אחמ"ש - עם אכיפת פרטיות */
function getCallReviewDetail(currentUserId, reviewId) {
  var user = getCurrentUser(currentUserId);
  var review = findById(SHEET_NAMES.CALL_REVIEWS, 'ReviewId', reviewId);
  if (!review) throw new Error('הבדיקה לא נמצאה');

  var canSeeNote = isManagement(user.role) ||
    user.userId === review.ReviewerId ||
    (user.role === 'TEAM_LEADER' && user.teamId === review.TeamId);

  var config = readConfig();
  var result = {
    reviewId: review.ReviewId,
    date: review.Date,
    time: review.Time,
    agentId: review.AgentId,
    customerNumber: review.CustomerNumber || '',
    qualityScore: computeQualityScore(review, config),
    categories: {},
    retentionSuccess: review.RetentionSuccess,
    leaveReason: review.LeaveReason,
    offerGiven: review.OfferGiven,
    excellentCallBonus: review.ExcellentCallBonus,
    status: review.Status
  };
  CALL_CATEGORIES.forEach(function (cat) { result.categories[cat] = review[cat]; });
  if (canSeeNote) result.reviewerNote = review.ReviewerNote;
  return result;
}

/**
 * "השיחות שלי" - היסטוריית שיחות מתועדות שנבדקו עבור נציג נתון, כולל שם
 * האחמ"ש שבדק וכל הציונים. הערת האחמ"ש החופשית מוצגת רק לפי אותה מדיניות
 * פרטיות כמו בכל שאר המערכת (ניהול / הבודק עצמו / ראש הצוות של הנציג) -
 * הנציג עצמו לעולם לא רואה את הערת האחמ"ש עליו, רק את הציונים המספריים.
 */
function getAgentReviewHistory(currentUserId, agentId, weekId) {
  var user = getCurrentUser(currentUserId);
  weekId = weekId || getCurrentWeekId();
  var agent = findById(SHEET_NAMES.AGENTS, 'AgentId', agentId);
  if (!agent) throw new Error('נציג לא נמצא');

  var canView = isManagement(user.role) || user.userId === agentId ||
    (user.role === 'TEAM_LEADER' && user.teamId === agent.TeamId);
  if (!canView) throw new Error('אין לך הרשאה לצפות בנתונים אלו');

  var config = readConfig();
  var reviewerNames = {};
  readSheet(SHEET_NAMES.USERS).forEach(function (u) { reviewerNames[u.UserId] = u.Name; });

  var reviews = readSheet(SHEET_NAMES.CALL_REVIEWS).filter(function (r) {
    return r.AgentId === agentId && r.WeekId === weekId && r.Status !== 'CANCELLED';
  });

  return reviews.map(function (r) {
    var canSeeNote = isManagement(user.role) || user.userId === r.ReviewerId ||
      (user.role === 'TEAM_LEADER' && user.teamId === r.TeamId);
    var categories = {};
    CALL_CATEGORIES.forEach(function (cat) { categories[cat] = { label: CATEGORY_LABELS[cat], value: r[cat] }; });
    var out = {
      reviewId: r.ReviewId,
      date: r.Date,
      time: r.Time,
      reviewerName: reviewerNames[r.ReviewerId] || 'לא ידוע',
      customerNumber: r.CustomerNumber || '',
      qualityScore: computeQualityScore(r, config),
      categories: categories,
      retentionSuccess: r.RetentionSuccess,
      excellentCallBonus: r.ExcellentCallBonus,
      reviewPurpose: r.ReviewPurpose || 'COMPETITION'
    };
    if (canSeeNote) out.reviewerNote = r.ReviewerNote;
    return out;
  }).sort(function (a, b) { return new Date(b.date + ' ' + b.time) - new Date(a.date + ' ' + a.time); });
}
