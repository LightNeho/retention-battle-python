/**
 * CompetitionService.gs
 * מנוע החישוב המרכזי. שום קובץ אחר לא מחשב ניקוד בעצמו - כולם קוראים לכאן.
 * שום מספר "קשיח" - הכל נשלף מ-CONFIG.
 */

var CALL_CATEGORIES = [
  'Tashaul', 'HatamatHatzaa', 'EichutSherut'
];

/** ציון איכות משוקלל לשיחה בודדת (0-10), לפי משקלי הקטגוריות ב-CONFIG */
function computeQualityScore(review, config) {
  var totalWeight = 0;
  var weightedSum = 0;
  CALL_CATEGORIES.forEach(function (cat) {
    var weightKey = 'Weight_' + cat;
    var weight = config[weightKey] !== undefined ? config[weightKey] : 1;
    var score = clampScore(review[cat], 0, 10);
    weightedSum += score * weight;
    totalWeight += weight;
  });
  return totalWeight > 0 ? round1(weightedSum / totalWeight) : 0;
}

/** נקודות שיחה בודדת לנציג, לפי איכות + הצלחת שימור + בונוסים */
function computeCallPoints(review, config, qualityScore) {
  var points = qualityScore * (config.QualityWeight || 1);
  if (review.RetentionSuccess === 'כן' || review.RetentionSuccess === true) {
    points += (config.RetentionSuccessPoints || 0);
  }
  if (review.ExcellentCallBonus === 'כן' || review.ExcellentCallBonus === true) {
    points += (config.ExcellentCallBonusPoints || 0);
  }
  return round1(points);
}

/**
 * כל בדיקות השיחה התקפות של התחרות בלבד (ReviewPurpose=COMPETITION) עבור שבוע
 * נתון. זו הפונקציה שמזינה ניקוד/דירוגים/Badges/משימות - שיחות QA/Coaching
 * לעולם לא נכנסות לכאן, כדי ששיחות בקרת איכות נוספות לא יעלו ניקוד תחרות
 * בטעות. רשומות ישנות בלי ReviewPurpose נחשבות COMPETITION (תאימות לאחור).
 */
function getReviewsForWeek(weekId) {
  return readSheet(SHEET_NAMES.CALL_REVIEWS).filter(function (r) {
    return r.WeekId === weekId && r.Status !== 'CANCELLED' && (r.ReviewPurpose || 'COMPETITION') === 'COMPETITION';
  });
}

/** כל בדיקות השיחה (כל Purpose) - לשימוש במסכי היסטוריה/ניהול שצריכים לראות הכל, לא רק ניקוד */
function getAllReviewsForWeek(weekId) {
  return readSheet(SHEET_NAMES.CALL_REVIEWS).filter(function (r) {
    return r.WeekId === weekId && r.Status !== 'CANCELLED';
  });
}

/**
 * אגרגציה מלאה לכל נציג בשבוע נתון.
 * מחזיר מערך: { agentId, name, teamId, points, callsReviewed, successfulRetentions,
 *                successRate, avgQuality, bonusPoints, perfectCalls }
 */
function getAgentAggregates(weekId) {
  var config = readConfig();
  var agents = readSheet(SHEET_NAMES.AGENTS).filter(function (a) { return a.Status !== 'INACTIVE'; });
  var reviews = getReviewsForWeek(weekId);
  var bonuses = readSheet(SHEET_NAMES.BONUSES).filter(function (b) {
    return b.WeekId === weekId && b.TargetType === 'AGENT';
  });

  var perfectCallThreshold = config.PerfectCallQualityThreshold || 9;

  return agents.map(function (agent) {
    var agentReviews = reviews.filter(function (r) { return r.AgentId === agent.AgentId; });
    var qualityScores = agentReviews.map(function (r) { return computeQualityScore(r, config); });
    var callPoints = agentReviews.map(function (r, i) { return computeCallPoints(r, config, qualityScores[i]); });
    var successCount = agentReviews.filter(function (r) { return r.RetentionSuccess === 'כן'; }).length;
    var perfectCalls = agentReviews.filter(function (r, i) {
      return r.RetentionSuccess === 'כן' && qualityScores[i] >= perfectCallThreshold;
    }).length;
    var agentBonuses = bonuses.filter(function (b) { return b.TargetId === agent.AgentId; });
    var bonusPoints = agentBonuses.reduce(function (s, b) { return s + Number(b.Points || 0); }, 0);
    var totalPoints = round1(callPoints.reduce(function (s, p) { return s + p; }, 0) + bonusPoints);
    var avgQuality = qualityScores.length ? round1(qualityScores.reduce(function (s, q) { return s + q; }, 0) / qualityScores.length) : 0;
    var successRate = agentReviews.length ? round1((successCount / agentReviews.length) * 100) : 0;

    return {
      agentId: agent.AgentId,
      name: agent.Name,
      teamId: agent.TeamId,
      points: totalPoints,
      callsReviewed: agentReviews.length,
      successfulRetentions: successCount,
      successRate: successRate,
      avgQuality: avgQuality,
      bonusPoints: bonusPoints,
      perfectCalls: perfectCalls
    };
  });
}

/** מיון + דירוג עם Tie-breakers, מוסיף שדה rank לכל פריט */
/**
 * מיון + דירוג עם Tie-breakers, מוסיף שדה rank לכל פריט.
 * דטרמיניסטי: אם אחרי כל ה-Tie-breakers עדיין יש שוויון מוחלט, לא מסתמכים
 * בשקט על סדר ה-Array/Sheet - מסמנים tied:true + tiedGroupIds, כדי שהמנהל
 * יראה את זה במפורש לפני סגירת שבוע (במקום שהמערכת "תחליט" איזה שם קדם).
 * שובר-שוויון אחרון קבוע ויציב: מיון לפי teamId/agentId/leaderId (מזהה קבוע),
 * רק כדי שהתוצאה תהיה נתונה-לשחזור (Reproducible) בין ריצה לריצה - לא כקביעת
 * "מנצח" עסקית. tied:true נשאר האינדיקציה האמיתית שהמנהל צריך להסתכל עליה.
 */
function rankWithTieBreakers(list, tieBreakerFns) {
  var idOf = function (item) { return item.teamId || item.agentId || item.leaderId || ''; };
  var sorted = list.slice().sort(function (a, b) {
    for (var i = 0; i < tieBreakerFns.length; i++) {
      var diff = tieBreakerFns[i](b) - tieBreakerFns[i](a); // גבוה יותר = טוב יותר
      if (diff !== 0) return diff;
    }
    return idOf(a) < idOf(b) ? -1 : (idOf(a) > idOf(b) ? 1 : 0); // שובר-שוויון יציב, לא "מכריע" עסקית
  });
  sorted.forEach(function (item, idx) {
    item.rank = idx + 1;
    item.tieBreakValues = tieBreakerFns.map(function (fn) { return fn(item); });
  });
  // זיהוי תיקו אמיתי: אותם ערכי Tie-break בדיוק לפני שובר-השוויון היציב
  for (var i = 0; i < sorted.length; i++) {
    var group = [sorted[i]];
    var j = i + 1;
    while (j < sorted.length && arraysEqual(sorted[j].tieBreakValues, sorted[i].tieBreakValues)) {
      group.push(sorted[j]);
      j++;
    }
    if (group.length > 1) {
      var ids = group.map(idOf);
      group.forEach(function (item) { item.tied = true; item.tiedWith = ids.filter(function (id) { return id !== idOf(item); }); });
    } else {
      sorted[i].tied = false; sorted[i].tiedWith = [];
    }
    i = j - 1;
  }
  return sorted;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}

/** Leaderboard נציגים מדורג, כולל שינוי דירוג מול השבוע הקודם */
function getAgentLeaderboard(weekId) {
  var minSample = readConfig().MinimumSampleSize || 3;
  var current = getAgentAggregates(weekId);
  var ranked = rankWithTieBreakers(current, [
    function (a) { return a.points; },
    function (a) { return a.successRate; },
    function (a) { return a.avgQuality; },
    function (a) { return a.successfulRetentions; },
    function (a) { return a.perfectCalls; }
  ]);

  var prevWeekId = shiftWeekId(weekId, -1);
  var prevRanked = rankWithTieBreakers(getAgentAggregates(prevWeekId), [
    function (a) { return a.points; },
    function (a) { return a.successRate; },
    function (a) { return a.avgQuality; },
    function (a) { return a.successfulRetentions; },
    function (a) { return a.perfectCalls; }
  ]);
  var prevRankMap = {};
  prevRanked.forEach(function (p) { prevRankMap[p.agentId] = p.rank; });

  ranked.forEach(function (a) {
    var prevRank = prevRankMap[a.agentId];
    a.rankChange = prevRank ? (prevRank - a.rank) : 0;
    a.eligibleForStats = a.callsReviewed >= minSample;
  });
  return ranked;
}

/**
 * אגרגציה לצוותים - מכבד את שיטת החישוב שהוגדרה ב-Admin (TOTAL / AVERAGE / WEIGHTED)
 * כדי שלא ייווצר יתרון אוטומטי לצוות עם יותר נציגים.
 */
function getTeamAggregates(weekId) {
  var config = readConfig();
  var teams = readSheet(SHEET_NAMES.TEAMS);
  var agentAggregates = getAgentAggregates(weekId);
  var method = config.TeamScoreMethod || 'AVERAGE';
  var weeklyTarget = config.WeeklyRetentionTargetPercent || 30;

  var prevAggregates = getTeamAggregatesRaw(shiftWeekId(weekId, -1), config);

  return teams.map(function (team) {
    var teamAgents = agentAggregates.filter(function (a) { return a.teamId === team.TeamId; });
    var totalPoints = round1(teamAgents.reduce(function (s, a) { return s + a.points; }, 0));
    var agentCount = teamAgents.length || 1;
    var avgPoints = round1(totalPoints / agentCount);
    var totalCalls = teamAgents.reduce(function (s, a) { return s + a.callsReviewed; }, 0);
    var totalSuccess = teamAgents.reduce(function (s, a) { return s + a.successfulRetentions; }, 0);
    var successRate = totalCalls ? round1((totalSuccess / totalCalls) * 100) : 0;
    var avgQuality = teamAgents.length
      ? round1(teamAgents.reduce(function (s, a) { return s + a.avgQuality; }, 0) / teamAgents.length)
      : 0;

    var score;
    if (method === 'TOTAL') {
      score = totalPoints;
    } else if (method === 'WEIGHTED') {
      var wScore = config.TeamWeighted_ScoreWeight || 0.7;
      var wRetention = config.TeamWeighted_RetentionWeight || 0.3;
      score = round1(avgPoints * wScore + successRate * wRetention);
    } else {
      score = avgPoints; // AVERAGE - ברירת מחדל
    }

    var prev = prevAggregates.filter(function (p) { return p.teamId === team.TeamId; })[0];
    var improvement = prev ? round1(score - prev.score) : 0;

    return {
      teamId: team.TeamId,
      name: team.Name,
      leaderId: team.TeamLeaderId,
      division: team.Division,
      score: score,
      totalPoints: totalPoints,
      avgPoints: avgPoints,
      agentCount: teamAgents.length,
      callsReviewed: totalCalls,
      successfulRetentions: totalSuccess,
      successRate: successRate,
      avgQuality: avgQuality,
      weeklyTargetPercent: weeklyTarget,
      targetProgress: weeklyTarget ? round1(Math.min(100, (successRate / weeklyTarget) * 100)) : 0,
      improvement: improvement
    };
  });
}

/** גרסה "גולמית" ללא Tie-break/דירוג - לשימוש פנימי בחישוב שיפור שבועי */
function getTeamAggregatesRaw(weekId, config) {
  var teams = readSheet(SHEET_NAMES.TEAMS);
  var agentAggregates = getAgentAggregates(weekId);
  var method = config.TeamScoreMethod || 'AVERAGE';
  return teams.map(function (team) {
    var teamAgents = agentAggregates.filter(function (a) { return a.teamId === team.TeamId; });
    var totalPoints = teamAgents.reduce(function (s, a) { return s + a.points; }, 0);
    var agentCount = teamAgents.length || 1;
    var avgPoints = totalPoints / agentCount;
    var totalCalls = teamAgents.reduce(function (s, a) { return s + a.callsReviewed; }, 0);
    var totalSuccess = teamAgents.reduce(function (s, a) { return s + a.successfulRetentions; }, 0);
    var successRate = totalCalls ? (totalSuccess / totalCalls) * 100 : 0;
    var score = method === 'TOTAL' ? totalPoints : avgPoints;
    return { teamId: team.TeamId, score: round1(score), successRate: round1(successRate) };
  });
}

/**
 * Leaderboard צוותים - עם Tie-breakers ושינוי מקום.
 * חשוב: התחרות היא בין צוותים באותו מוקד (Division) בלבד - צוותי שימור
 * מתחרים רק מול צוותי שימור אחרים, וצוותי שירות רק מול צוותי שירות אחרים.
 * הדירוג (rank) וה-rankChange מחושבים בנפרד בתוך כל קבוצת מוקד, ואז
 * מאוחדים בחזרה למערך שטוח אחד (כל צוות שומר את שדה division שלו).
 */
function getTeamLeaderboard(weekId) {
  var current = getTeamAggregates(weekId);
  var prevRankMap = buildTeamPrevRankMap(weekId);

  var byDivision = {};
  current.forEach(function (t) { (byDivision[t.division] = byDivision[t.division] || []).push(t); });

  var result = [];
  Object.keys(byDivision).forEach(function (division) {
    var ranked = rankWithTieBreakers(byDivision[division], [
      function (t) { return t.score; },
      function (t) { return t.successRate; },
      function (t) { return t.avgQuality; },
      function (t) { return t.improvement; }
    ]);
    ranked.forEach(function (t) {
      var prevRank = prevRankMap[t.teamId];
      t.rankChange = prevRank ? (prevRank - t.rank) : 0;
    });
    result = result.concat(ranked);
  });
  return result;
}

/** מדרג את השבוע הקודם באותה שיטה (per-division) כדי לחשב rankChange */
function buildTeamPrevRankMap(weekId) {
  var prevWeekId = shiftWeekId(weekId, -1);
  var prevAggregates = getTeamAggregates(prevWeekId);
  var byDivision = {};
  prevAggregates.forEach(function (t) { (byDivision[t.division] = byDivision[t.division] || []).push(t); });
  var map = {};
  Object.keys(byDivision).forEach(function (division) {
    var ranked = rankWithTieBreakers(byDivision[division], [
      function (t) { return t.score; },
      function (t) { return t.successRate; },
      function (t) { return t.avgQuality; },
      function (t) { return t.improvement; }
    ]);
    ranked.forEach(function (t) { map[t.teamId] = t.rank; });
  });
  return map;
}

/** מקבץ Leaderboard צוותים לפי מוקד - לשימוש במסכים שמציגים כל מוקד בנפרד.
 * שבוע סגור = קורא מה-Snapshot הקפוא, לא מחשב מחדש. */
function getTeamBattleByDivision(weekId) {
  if (isWeekClosed(weekId)) {
    var snap = getWeekSnapshot(weekId);
    var byDiv = {};
    snap.teamLeaderboard.forEach(function (t) { (byDiv[t.division] = byDiv[t.division] || []).push(t); });
    return Object.keys(byDiv).sort().map(function (division) { return { division: division, teams: byDiv[division] }; });
  }
  var flat = getTeamLeaderboard(weekId);
  var byDivision = {};
  flat.forEach(function (t) {
    if (!byDivision[t.division]) byDivision[t.division] = [];
    byDivision[t.division].push(t);
  });
  return Object.keys(byDivision).sort().map(function (division) {
    return { division: division, teams: byDivision[division] };
  });
}

/** ניקוד ראשי צוותים - נגזר מביצועי הצוות + השלמת משימות ניהול, לא העתק של ניקוד נציגים */
function getLeaderAggregates(weekId) {
  var config = readConfig();
  var leaders = readSheet(SHEET_NAMES.TEAM_LEADERS);
  var teamStats = getTeamAggregates(weekId);
  var taskResults = getManagerTaskResults(weekId);
  var bonuses = readSheet(SHEET_NAMES.BONUSES).filter(function (b) {
    return b.WeekId === weekId && b.TargetType === 'LEADER';
  });

  var wTeam = config.LeaderWeight_TeamScore || 0.4;
  var wRetention = config.LeaderWeight_Retention || 0.25;
  var wImprovement = config.LeaderWeight_Improvement || 0.15;
  var wTasks = config.LeaderWeight_Tasks || 0.2;

  var maxTeamScore = Math.max.apply(null, teamStats.map(function (t) { return t.score; }).concat([1]));
  var teamNames = {};
  readSheet(SHEET_NAMES.TEAMS).forEach(function (t) { teamNames[t.TeamId] = t.Name; });

  return leaders.map(function (leader) {
    var team = teamStats.filter(function (t) { return t.teamId === leader.TeamId; })[0];
    if (!team) return null;
    var leaderTasks = taskResults.filter(function (t) { return t.leaderId === leader.LeaderId; });
    var completedTasks = leaderTasks.filter(function (t) { return t.status === 'הושלם'; });
    var taskPoints = completedTasks.reduce(function (s, t) { return s + t.points; }, 0);
    var taskCompletionRate = leaderTasks.length ? (completedTasks.length / leaderTasks.length) * 100 : 0;
    var leaderBonuses = bonuses.filter(function (b) { return b.TargetId === leader.LeaderId; });
    var bonusPoints = leaderBonuses.reduce(function (s, b) { return s + Number(b.Points || 0); }, 0);

    var normalizedTeamScore = (team.score / maxTeamScore) * 100;
    var improvementScore = Math.max(0, team.improvement) * 2;

    var score = round1(
      normalizedTeamScore * wTeam +
      team.successRate * wRetention +
      Math.min(100, improvementScore) * wImprovement +
      taskCompletionRate * wTasks +
      taskPoints + bonusPoints
    );

    return {
      leaderId: leader.LeaderId,
      name: leader.Name,
      teamId: leader.TeamId,
      teamName: teamNames[leader.TeamId] || '',
      score: score,
      teamScore: team.score,
      successRate: team.successRate,
      avgQuality: team.avgQuality,
      improvement: team.improvement,
      tasksCompleted: completedTasks.length,
      tasksTotal: leaderTasks.length,
      taskCompletionRate: round1(taskCompletionRate),
      bonusPoints: bonusPoints
    };
  }).filter(function (x) { return x !== null; });
}

function getLeaderLeaderboard(weekId) {
  var current = getLeaderAggregates(weekId);
  var ranked = rankWithTieBreakers(current, [
    function (l) { return l.taskCompletionRate; },
    function (l) { return l.teamScore; },
    function (l) { return l.improvement; }
  ]);

  var prevWeekId = shiftWeekId(weekId, -1);
  var prevRanked = rankWithTieBreakers(getLeaderAggregates(prevWeekId), [
    function (l) { return l.taskCompletionRate; },
    function (l) { return l.teamScore; },
    function (l) { return l.improvement; }
  ]);
  var prevRankMap = {};
  prevRanked.forEach(function (p) { prevRankMap[p.leaderId] = p.rank; });

  ranked.forEach(function (l) {
    var prevRank = prevRankMap[l.leaderId];
    l.rankChange = prevRank ? (prevRank - l.rank) : 0;
  });
  return ranked;
}
