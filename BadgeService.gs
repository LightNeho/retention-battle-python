/**
 * BadgeService.gs
 * מנוע ההישגים. Badges מבוססי-סטטיסטיקה (כמו "אחוז שימור גבוה") מכבדים
 * MinimumSample כדי שלא יוענקו על סמך מדגם זעיר ולא הוגן.
 */

function getBadgeDefinitions() {
  return readSheet(SHEET_NAMES.BADGES).filter(function (b) { return b.Active !== false && b.Active !== 'FALSE'; });
}

/** מריץ הערכת כל ה-Badges האוטומטיים לשבוע נתון. נקרא אחרי כל שמירת בדיקת שיחה. */
function evaluateBadges(weekId) {
  var config = readConfig();
  var minSample = config.MinimumSampleSize || 3;
  var definitions = getBadgeDefinitions();
  var leaderboard = getAgentLeaderboard(weekId);
  var eligible = leaderboard.filter(function (a) { return a.callsReviewed >= minSample; });
  if (!leaderboard.length) return;

  var awarded = readSheet(SHEET_NAMES.BADGE_AWARDS).filter(function (a) { return a.WeekId === weekId; });
  var alreadyAwardedKey = {};
  awarded.forEach(function (a) { alreadyAwardedKey[a.BadgeId + '|' + a.TargetId] = true; });

  definitions.forEach(function (def) {
    var winnerId = computeBadgeWinner(def.ConditionKey, leaderboard, eligible, weekId, config);
    if (!winnerId) return;
    var key = def.BadgeId + '|' + winnerId;
    if (alreadyAwardedKey[key]) return; // כבר הוענק השבוע לאותו נציג
    // מסירים הענקות קודמות של אותו Badge באותו שבוע (הדירוג יכול להשתנות תוך כדי שבוע)
    removeWeeklyBadgeAwards(def.BadgeId, weekId);
    appendRow(SHEET_NAMES.BADGE_AWARDS, {
      AwardId: generateId('badge'),
      BadgeId: def.BadgeId,
      TargetType: 'AGENT',
      TargetId: winnerId,
      WeekId: weekId,
      AwardedAt: nowIso(),
      AwardedBy: 'SYSTEM'
    });
    var agent = leaderboard.filter(function (a) { return a.agentId === winnerId; })[0];
    logActivity((def.Icon || '⭐') + ' ' + agent.name + ' קיבל/ה Badge: ' + def.Name, weekId);
  });
}

function removeWeeklyBadgeAwards(badgeId, weekId) {
  var rows = readSheet(SHEET_NAMES.BADGE_AWARDS).filter(function (r) {
    return r.BadgeId === badgeId && r.WeekId === weekId && r.AwardedBy === 'SYSTEM';
  });
  // מוחקים מהסוף להתחלה כדי לא לשבש מספרי שורה
  rows.sort(function (a, b) { return b._row - a._row; }).forEach(function (r) {
    deleteRowPhysical(SHEET_NAMES.BADGE_AWARDS, r._row);
  });
}

function computeBadgeWinner(conditionKey, allAgents, eligibleAgents, weekId, config) {
  switch (conditionKey) {
    case 'HOT_STREAK':
      return findHotStreakAgent(weekId, config.HotStreakLength || 3);
    case 'HIGHEST_SUCCESS_RATE':
      return topByField(eligibleAgents, 'successRate');
    case 'HIGHEST_AVG_QUESTIONING':
      return topByAvgCategory(weekId, 'Tashaul', config.MinimumSampleSize || 3);
    case 'HIGHEST_AVG_SERVICE_QUALITY':
      return topByField(eligibleAgents, 'avgQuality');
    case 'BIGGEST_COMEBACK':
      return topByField(allAgents, 'rankChange');
    case 'MVP':
      return topByField(allAgents, 'points');
    case 'PERFECT_CALL':
      return topByField(allAgents.filter(function (a) { return a.perfectCalls > 0; }), 'perfectCalls');
    default:
      return null;
  }
}

function topByField(list, field) {
  if (!list.length) return null;
  var best = list.reduce(function (max, item) { return item[field] > max[field] ? item : max; }, list[0]);
  return best[field] > 0 ? best.agentId : null;
}

function topByAvgCategory(weekId, categoryField, minSample) {
  var reviews = getReviewsForWeek(weekId);
  var byAgent = {};
  reviews.forEach(function (r) {
    if (!byAgent[r.AgentId]) byAgent[r.AgentId] = [];
    byAgent[r.AgentId].push(Number(r[categoryField] || 0));
  });
  var best = null, bestAvg = -1;
  Object.keys(byAgent).forEach(function (agentId) {
    var scores = byAgent[agentId];
    if (scores.length < minSample) return;
    var avg = scores.reduce(function (s, v) { return s + v; }, 0) / scores.length;
    if (avg > bestAvg) { bestAvg = avg; best = agentId; }
  });
  return best;
}

/** בודק רצף של N שימורים מוצלחים רצופים (לפי סדר כרונולוגי) עבור מישהו כלשהו בשבוע */
function findHotStreakAgent(weekId, streakLength) {
  var reviews = getReviewsForWeek(weekId).sort(function (a, b) {
    return new Date(a.Timestamp) - new Date(b.Timestamp);
  });
  var byAgent = {};
  reviews.forEach(function (r) {
    if (!byAgent[r.AgentId]) byAgent[r.AgentId] = [];
    byAgent[r.AgentId].push(r.RetentionSuccess === 'כן');
  });
  var winner = null, longestFound = 0;
  Object.keys(byAgent).forEach(function (agentId) {
    var seq = byAgent[agentId];
    var streak = 0, maxStreak = 0;
    seq.forEach(function (success) {
      streak = success ? streak + 1 : 0;
      maxStreak = Math.max(maxStreak, streak);
    });
    if (maxStreak >= streakLength && maxStreak > longestFound) {
      longestFound = maxStreak;
      winner = agentId;
    }
  });
  return winner;
}

/** בחירת "שיחת השבוע" - פעולה ידנית של אחמ"ש, מעניקה Badge ייעודי */
function selectCallOfTheWeek(currentUserId, reviewId) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var review = findById(SHEET_NAMES.CALL_REVIEWS, 'ReviewId', reviewId);
  if (!review) throw new Error('השיחה לא נמצאה');

  var badge = readSheet(SHEET_NAMES.BADGES).filter(function (b) { return b.ConditionKey === 'CALL_OF_WEEK'; })[0];
  if (!badge) throw new Error('Badge "שיחת השבוע" לא מוגדר במערכת');

  removeWeeklyBadgeAwards(badge.BadgeId, review.WeekId);
  appendRow(SHEET_NAMES.BADGE_AWARDS, {
    AwardId: generateId('badge'),
    BadgeId: badge.BadgeId,
    TargetType: 'AGENT',
    TargetId: review.AgentId,
    WeekId: review.WeekId,
    AwardedAt: nowIso(),
    AwardedBy: user.userId
  });
  var agent = findById(SHEET_NAMES.AGENTS, 'AgentId', review.AgentId);
  writeAuditLog(user, 'בחירת שיחת השבוע', 'CALL_REVIEWS', reviewId, '', review.AgentId);
  logActivity('⭐ ' + (agent ? agent.Name : '') + ' קיבל/ה שיחת השבוע', review.WeekId);
  invalidateWeekCache(review.WeekId);
  return { success: true };
}

/** כל ה-Badges שנציג קיבל אי-פעם (לתצוגה בפרופיל) + Badges השבוע הנוכחי */
function getBadgesForAgent(agentId) {
  var definitions = getBadgeDefinitions();
  var defMap = {};
  definitions.forEach(function (d) { defMap[d.BadgeId] = d; });
  var awards = readSheet(SHEET_NAMES.BADGE_AWARDS).filter(function (a) { return a.TargetId === agentId; });
  return awards.map(function (a) {
    var def = defMap[a.BadgeId] || {};
    return { badgeId: a.BadgeId, name: def.Name, icon: def.Icon, description: def.Description, weekId: a.WeekId };
  });
}

function createBadgeDefinition(currentUserId, badge) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  assertField(badge.Name, 'שם ההישג');
  var record = {
    BadgeId: generateId('bdg'),
    Name: badge.Name,
    Icon: badge.Icon || '⭐',
    Description: badge.Description || '',
    ConditionKey: badge.ConditionKey || '',
    MinimumSample: badge.MinimumSample || 0,
    Active: true
  };
  appendRow(SHEET_NAMES.BADGES, record);
  writeAuditLog(user, 'יצירת Badge', 'BADGES', record.BadgeId, '', JSON.stringify(record));
  return record;
}
