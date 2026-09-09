/**
 * DashboardService.gs
 * שכבת האגרגציה שמזינה את כל מסכי הלקוח. כל פונקציה כאן היא "read model" -
 * לא כותבת דבר, ומשתמשת ב-Cache כדי לא להעמיס על ה-Sheet בכל רענון.
 */

var CATEGORY_LABELS = {
  Tashaul: 'תשאול נכון',
  HatamatHatzaa: 'הצעה מותאמת ללקוח',
  EichutSherut: 'שירות איכותי'
};

/** נתוני עמוד הבית המלא - KPI, קרב צוותים, Top Agents, קרב ראשי צוותים */
function getDashboardData(currentUserId, weekId) {
  var user = getCurrentUser(currentUserId);
  weekId = weekId || getCurrentWeekId();

  // שבוע סגור = עובדה היסטורית קפואה. לא מחשבים מחדש - קוראים מה-Snapshot
  // בלבד, כדי ששינוי CONFIG מאוחר יותר לעולם לא ישנה תוצאה שכבר הוכרזה.
  if (isWeekClosed(weekId)) {
    return withCache('dashboard_' + weekId, function () { return buildDashboardDataFromSnapshot(weekId); });
  }

  return withCache('dashboard_' + weekId, function () {
    var teamBoard = getTeamLeaderboard(weekId);
    var teamBattleByDivision = getTeamBattleByDivision(weekId);
    var agentBoard = getAgentLeaderboard(weekId);
    var leaderBoard = getLeaderLeaderboard(weekId);
    var leadersMap = {};
    readSheet(SHEET_NAMES.TEAM_LEADERS).forEach(function (l) { leadersMap[l.LeaderId] = l.Name; });
    teamBoard.forEach(function (t) { t.leaderName = leadersMap[t.leaderId] || ''; });

    // "Leading Team" הוא מושג שקיים רק בתוך מוקד - אין תחרות בין שימור לשירות.
    // לכן ה-KPI מחזיר צוות מוביל אחד לכל מוקד, לא מנצח אחד גורף.
    var leadingTeamsByDivision = teamBattleByDivision.map(function (group) {
      return { division: group.division, team: group.teams[0] || null };
    });

    return {
      isFrozen: false,
      weekMeta: getWeekMeta(weekId),
      kpis: {
        leadingTeamsByDivision: leadingTeamsByDivision,
        topAgent: agentBoard[0] || null,
        leadingLeader: leaderBoard[0] || null
      },
      teamBattleByDivision: teamBattleByDivision,
      topAgents: agentBoard.slice(0, 3),
      agentLeaderboard: agentBoard,
      leaderBattle: leaderBoard,
      activityFeed: getActivityFeed(weekId, null, 20)
    };
  });
}

/** בונה את מבנה נתוני ה-Dashboard מתוך Snapshot קפוא (שבוע סגור) - ללא חישוב Live */
function buildDashboardDataFromSnapshot(weekId) {
  var snap = getWeekSnapshot(weekId);
  if (!snap) throw new Error('לא נמצא Snapshot עבור שבוע ' + weekId);
  var leadersMap = {};
  readSheet(SHEET_NAMES.TEAM_LEADERS).forEach(function (l) { leadersMap[l.LeaderId] = l.Name; });
  snap.teamLeaderboard.forEach(function (t) { if (!t.leaderName) t.leaderName = leadersMap[t.leaderId] || ''; });

  var byDivision = {};
  snap.teamLeaderboard.forEach(function (t) { (byDivision[t.division] = byDivision[t.division] || []).push(t); });
  var teamBattleByDivision = Object.keys(byDivision).sort().map(function (d) { return { division: d, teams: byDivision[d] }; });
  var leadingTeamsByDivision = teamBattleByDivision.map(function (g) { return { division: g.division, team: g.teams[0] || null }; });

  return {
    isFrozen: true,
    frozenAt: snap.closedAt,
    weekMeta: getWeekMeta(weekId),
    kpis: {
      leadingTeamsByDivision: leadingTeamsByDivision,
      topAgent: snap.agentLeaderboard[0] || null,
      leadingLeader: snap.leaderLeaderboard[0] || null
    },
    teamBattleByDivision: teamBattleByDivision,
    topAgents: snap.agentLeaderboard.slice(0, 3),
    agentLeaderboard: snap.agentLeaderboard,
    leaderBattle: snap.leaderLeaderboard,
    activityFeed: getActivityFeed(weekId, null, 20)
  };
}

/** Leaderboard בודד - לשימוש במסכי "דירוגים" הייעודיים עם Filters. שבוע סגור = מה-Snapshot בלבד. */
function getLeaderboard(type, weekId) {
  weekId = weekId || getCurrentWeekId();
  if (isWeekClosed(weekId)) {
    var snap = getWeekSnapshot(weekId);
    if (type === 'TEAM') return snap.teamLeaderboard;
    if (type === 'LEADER') return snap.leaderLeaderboard;
    return snap.agentLeaderboard;
  }
  var cacheKey = 'leaderboard_' + type.toLowerCase() + '_' + weekId;
  return withCache(cacheKey, function () {
    if (type === 'TEAM') return getTeamLeaderboard(weekId);
    if (type === 'LEADER') return getLeaderLeaderboard(weekId);
    return getAgentLeaderboard(weekId);
  });
}

/** פרופיל נציג מלא - כרטיסים, Badges, גרפים, "מה חסר לי" */
function getAgentProfile(currentUserId, agentId, weekId) {
  weekId = weekId || getCurrentWeekId();
  var agent = findById(SHEET_NAMES.AGENTS, 'AgentId', agentId);
  if (!agent) throw new Error('נציג לא נמצא');
  var team = findById(SHEET_NAMES.TEAMS, 'TeamId', agent.TeamId);

  var leaderboard = getLeaderboard('AGENT', weekId);
  var me = leaderboard.filter(function (a) { return a.agentId === agentId; })[0];
  var above = leaderboard.filter(function (a) { return me && a.rank === me.rank - 1; })[0];

  var reviews = getReviewsForWeek(weekId).filter(function (r) { return r.AgentId === agentId; });
  var config = readConfig();

  var byDay = {};
  reviews.forEach(function (r) {
    if (!byDay[r.Date]) byDay[r.Date] = { date: r.Date, points: 0, retentions: 0, calls: 0 };
    var q = computeQualityScore(r, config);
    byDay[r.Date].points += computeCallPoints(r, config, q);
    byDay[r.Date].calls += 1;
    if (r.RetentionSuccess === 'כן') byDay[r.Date].retentions += 1;
  });

  var categoryAverages = {};
  CALL_CATEGORIES.forEach(function (cat) {
    var scores = reviews.map(function (r) { return Number(r[cat] || 0); });
    categoryAverages[cat] = { label: CATEGORY_LABELS[cat], value: scores.length ? round1(scores.reduce(function (s, v) { return s + v; }, 0) / scores.length) : 0 };
  });

  var gapToNext = (me && above) ? round1(Math.max(0, above.points - me.points + 0.1)) : null;

  return {
    agentId: agentId,
    name: agent.Name,
    teamId: agent.TeamId,
    teamName: team ? team.Name : '',
    rank: me ? me.rank : null,
    rankChange: me ? me.rankChange : 0,
    stats: me || { points: 0, callsReviewed: 0, successfulRetentions: 0, successRate: 0, avgQuality: 0 },
    gapToNextRank: gapToNext,
    nextRankLabel: above ? ('עוד ' + gapToNext + ' נקודות כדי לעבור למקום ' + above.rank) : (me && me.rank === 1 ? 'את/ה במקום הראשון! 🏆' : null),
    badges: getBadgesForAgent(agentId),
    dailyPerformance: Object.keys(byDay).sort().map(function (d) { return byDay[d]; }),
    categoryBreakdown: Object.keys(categoryAverages).map(function (k) { return categoryAverages[k]; })
  };
}

/** פרופיל צוות - כולל חוזקות/חולשות מחושבות אוטומטית מול ממוצע כלל המוקד */
function getTeamProfile(currentUserId, teamId, weekId) {
  weekId = weekId || getCurrentWeekId();
  var team = findById(SHEET_NAMES.TEAMS, 'TeamId', teamId);
  if (!team) throw new Error('צוות לא נמצא');
  var leader = findById(SHEET_NAMES.TEAM_LEADERS, 'LeaderId', team.TeamLeaderId);

  var teamBoard = getLeaderboard('TEAM', weekId);
  var me = teamBoard.filter(function (t) { return t.teamId === teamId; })[0];
  var divisionPeerCount = teamBoard.filter(function (t) { return t.division === team.Division; }).length;

  // חוזקות/חולשות מושוות מול ממוצע צוותי אותו מוקד בלבד - לא מול כל המוקד השני,
  // כי אין השוואה הוגנת בין שימור לשירות (מדדים/יעדים שונים במהותם).
  var divisionTeamIds = teamBoard.filter(function (t) { return t.division === team.Division; }).map(function (t) { return t.teamId; });
  var allReviews = getReviewsForWeek(weekId).filter(function (r) { return divisionTeamIds.indexOf(r.TeamId) !== -1; });
  var teamReviews = allReviews.filter(function (r) { return r.TeamId === teamId; });
  var config = readConfig();

  var globalAvg = {}, teamAvg = {};
  CALL_CATEGORIES.forEach(function (cat) {
    var allScores = allReviews.map(function (r) { return Number(r[cat] || 0); });
    var teamScores = teamReviews.map(function (r) { return Number(r[cat] || 0); });
    globalAvg[cat] = allScores.length ? allScores.reduce(function (s, v) { return s + v; }, 0) / allScores.length : 0;
    teamAvg[cat] = teamScores.length ? teamScores.reduce(function (s, v) { return s + v; }, 0) / teamScores.length : 0;
  });

  var strengths = [], improvements = [];
  CALL_CATEGORIES.forEach(function (cat) {
    if (teamAvg[cat] >= globalAvg[cat] && teamReviews.length > 0) strengths.push(CATEGORY_LABELS[cat]);
    else if (teamReviews.length > 0) improvements.push(CATEGORY_LABELS[cat]);
  });

  var byDay = {};
  teamReviews.forEach(function (r) {
    if (!byDay[r.Date]) byDay[r.Date] = { date: r.Date, calls: 0, retentions: 0, qualitySum: 0 };
    byDay[r.Date].calls += 1;
    byDay[r.Date].qualitySum += computeQualityScore(r, config);
    if (r.RetentionSuccess === 'כן') byDay[r.Date].retentions += 1;
  });
  var dailyPerformance = Object.keys(byDay).sort().map(function (d) {
    var day = byDay[d];
    return { date: day.date, calls: day.calls, retentions: day.retentions, avgQuality: round1(day.qualitySum / day.calls) };
  });

  var agentBoard = getLeaderboard('AGENT', weekId).filter(function (a) { return a.teamId === teamId; });

  return {
    teamId: teamId,
    name: team.Name,
    division: team.Division,
    leaderName: leader ? leader.Name : '',
    rank: me ? me.rank : null,
    divisionTeamCount: divisionPeerCount,
    score: me ? me.score : 0,
    successRate: me ? me.successRate : 0,
    avgQuality: me ? me.avgQuality : 0,
    targetProgress: me ? me.targetProgress : 0,
    strengths: strengths,
    improvements: improvements,
    dailyPerformance: dailyPerformance,
    internalLeaderboard: agentBoard
  };
}

/** Dashboard אישי לראש צוות - כולל התראות אוטומטיות */
function getLeaderDashboard(currentUserId, leaderId, weekId) {
  weekId = weekId || getCurrentWeekId();
  var leader = findById(SHEET_NAMES.TEAM_LEADERS, 'LeaderId', leaderId);
  if (!leader) throw new Error('ראש צוות לא נמצא');

  var leaderBoard = getLeaderboard('LEADER', weekId);
  var me = leaderBoard.filter(function (l) { return l.leaderId === leaderId; })[0];
  var teamAgents = getLeaderboard('AGENT', weekId).filter(function (a) { return a.teamId === leader.TeamId; });
  var tasks = getManagerTaskResults(weekId).filter(function (t) { return t.leaderId === leaderId; });

  var alerts = [];
  var noReview = teamAgents.filter(function (a) { return a.callsReviewed === 0; });
  if (noReview.length > 0) {
    alerts.push({ level: 'warning', message: noReview.length + ' נציגים עדיין ללא בדיקת שיחה השבוע' });
  }

  var allReviews = getReviewsForWeek(weekId).filter(function (r) { return r.TeamId === leader.TeamId; });
  var now = new Date();
  var last24h = allReviews.filter(function (r) { return (now - new Date(r.Timestamp)) < 86400000; });
  var prev24h = allReviews.filter(function (r) { var diff = now - new Date(r.Timestamp); return diff >= 86400000 && diff < 172800000; });
  var rate24 = last24h.length ? (last24h.filter(function (r) { return r.RetentionSuccess === 'כן'; }).length / last24h.length) * 100 : null;
  var ratePrev = prev24h.length ? (prev24h.filter(function (r) { return r.RetentionSuccess === 'כן'; }).length / prev24h.length) * 100 : null;
  if (rate24 !== null && ratePrev !== null && (ratePrev - rate24) >= 8) {
    alerts.push({ level: 'danger', message: 'אחוז השימור ירד ב-' + round1(ratePrev - rate24) + '% ביממה האחרונה' });
  }

  var hotAgents = teamAgents.filter(function (a) { return a.avgQuality >= 8 && a.successRate >= 50; });
  if (hotAgents.length >= 3) {
    alerts.push({ level: 'success', message: hotAgents.length + ' נציגים בביצועים מעולים השבוע' });
  }

  var improving = teamAgents.filter(function (a) { return a.rankChange > 0; });
  var declining = teamAgents.filter(function (a) { return a.rankChange < 0; });
  var needsAttention = teamAgents.filter(function (a) { return a.successRate < 30 && a.callsReviewed >= 2; });

  return {
    leaderId: leaderId,
    name: leader.Name,
    teamId: leader.TeamId,
    rank: me ? me.rank : null,
    score: me ? me.score : 0,
    tasks: tasks,
    teamAgents: teamAgents,
    improving: improving,
    declining: declining,
    needsAttention: needsAttention,
    alerts: alerts
  };
}

/** Hall of Fame - היסטוריית ניצחונות + סטטיסטיקות מצטברות */
function getHallOfFame() {
  return withCache('hall_of_fame', function () {
    var records = readSheet(SHEET_NAMES.HALL_OF_FAME).sort(function (a, b) { return b.WeekId < a.WeekId ? -1 : 1; });
    var teamsMap = {}, agentsMap = {}, leadersMap = {};
    readSheet(SHEET_NAMES.TEAMS).forEach(function (t) { teamsMap[t.TeamId] = t.Name; });
    readSheet(SHEET_NAMES.AGENTS).forEach(function (a) { agentsMap[a.AgentId] = a.Name; });
    readSheet(SHEET_NAMES.TEAM_LEADERS).forEach(function (l) { leadersMap[l.LeaderId] = l.Name; });

    // התחרות בין צוותים היא בתוך מוקד בלבד, לכן לכל שבוע יש זוכה נפרד לכל
    // מוקד (לא אלוף אחד גורף) - וגם "רצף ניצחונות" נספר בנפרד לכל מוקד,
    // כי רצף בשימור ורצף בשירות הם שני "מסלולים" נפרדים לגמרי.
    var teamWins = {}, agentWins = {}, leaderWins = {};
    var streakByDivision = {};
    var longestStreakTeamId = null, longestStreak = 0, topWeeklyScore = 0;
    var sortedAsc = records.slice().sort(function (a, b) { return a.WeekId < b.WeekId ? -1 : 1; });

    sortedAsc.forEach(function (r) {
      var winners = [];
      try { winners = JSON.parse(r.WinningTeamsJson || '[]'); } catch (e) { winners = []; }
      winners.forEach(function (w) {
        teamWins[w.teamId] = (teamWins[w.teamId] || 0) + 1;
        var s = streakByDivision[w.division] || { teamId: null, count: 0 };
        s.count = (s.teamId === w.teamId) ? s.count + 1 : 1;
        s.teamId = w.teamId;
        streakByDivision[w.division] = s;
        if (s.count > longestStreak) { longestStreak = s.count; longestStreakTeamId = w.teamId; }
        topWeeklyScore = Math.max(topWeeklyScore, Number(w.score || 0));
      });
      agentWins[r.MvpAgentId] = (agentWins[r.MvpAgentId] || 0) + 1;
      leaderWins[r.WinningLeaderId] = (leaderWins[r.WinningLeaderId] || 0) + 1;
    });

    return {
      history: records.map(function (r) {
        var winners = [];
        try { winners = JSON.parse(r.WinningTeamsJson || '[]'); } catch (e) { winners = []; }
        return {
          weekId: r.WeekId,
          winningTeams: winners.map(function (w) { return { division: w.division, name: w.teamName || teamsMap[w.teamId] || '' }; }),
          mvpAgent: agentsMap[r.MvpAgentId] || '',
          winningLeader: leadersMap[r.WinningLeaderId] || '',
          callOfWeekAgent: agentsMap[r.CallOfWeekAgentId] || ''
        };
      }),
      statistics: {
        teamWins: Object.keys(teamWins).map(function (id) { return { name: teamsMap[id] || '', wins: teamWins[id] }; }),
        agentWins: Object.keys(agentWins).map(function (id) { return { name: agentsMap[id] || '', wins: agentWins[id] }; }),
        leaderWins: Object.keys(leaderWins).map(function (id) { return { name: leadersMap[id] || '', wins: leaderWins[id] }; }),
        longestStreak: { team: teamsMap[longestStreakTeamId] || '', length: longestStreak },
        topWeeklyScore: round1(topWeeklyScore)
      }
    };
  });
}

/** עמוד Analytics */
function getAnalytics(weekId) {
  weekId = weekId || getCurrentWeekId();
  var config = readConfig();
  var reviews = getReviewsForWeek(weekId);
  var teamBoard = getLeaderboard('TEAM', weekId);
  var agentBoard = getLeaderboard('AGENT', weekId);

  var totalRetentions = reviews.filter(function (r) { return r.RetentionSuccess === 'כן'; }).length;
  var overallRate = reviews.length ? round1((totalRetentions / reviews.length) * 100) : 0;

  var byDay = {};
  reviews.forEach(function (r) {
    if (!byDay[r.Date]) byDay[r.Date] = { date: r.Date, calls: 0, retentions: 0 };
    byDay[r.Date].calls++;
    if (r.RetentionSuccess === 'כן') byDay[r.Date].retentions++;
  });

  var reasonCounts = {}, offerCounts = {};
  reviews.forEach(function (r) {
    if (r.LeaveReason) reasonCounts[r.LeaveReason] = (reasonCounts[r.LeaveReason] || 0) + 1;
    if (r.OfferGiven && r.RetentionSuccess === 'כן') offerCounts[r.OfferGiven] = (offerCounts[r.OfferGiven] || 0) + 1;
  });

  var categoryAverages = {};
  CALL_CATEGORIES.forEach(function (cat) {
    var scores = reviews.map(function (r) { return Number(r[cat] || 0); });
    categoryAverages[CATEGORY_LABELS[cat]] = scores.length ? round1(scores.reduce(function (s, v) { return s + v; }, 0) / scores.length) : 0;
  });

  var prevWeekAgents = getAgentAggregates(shiftWeekId(weekId, -1));
  var prevMap = {};
  prevWeekAgents.forEach(function (a) { prevMap[a.agentId] = a.points; });
  var improvingAgents = agentBoard.filter(function (a) { return prevMap[a.agentId] !== undefined && a.points > prevMap[a.agentId]; })
    .sort(function (a, b) { return (b.points - prevMap[b.agentId]) - (a.points - prevMap[a.agentId]); }).slice(0, 5);
  var decliningAgents = agentBoard.filter(function (a) { return prevMap[a.agentId] !== undefined && a.points < prevMap[a.agentId]; })
    .sort(function (a, b) { return (a.points - prevMap[a.agentId]) - (b.points - prevMap[b.agentId]); }).slice(0, 5);

  return {
    overallRetentionRate: overallRate,
    retentionsByTeam: teamBoard.map(function (t) { return { name: t.name, successRate: t.successRate }; }),
    dailyTrend: Object.keys(byDay).sort().map(function (d) { return byDay[d]; }),
    qualityByTeam: teamBoard.map(function (t) { return { name: t.name, avgQuality: t.avgQuality }; }),
    qualityByCategory: categoryAverages,
    topLeaveReasons: Object.keys(reasonCounts).map(function (k) { return { reason: k, count: reasonCounts[k] }; }),
    topSuccessfulOffers: Object.keys(offerCounts).map(function (k) { return { offer: k, count: offerCounts[k] }; }),
    improvingAgents: improvingAgents,
    decliningAgents: decliningAgents
  };
}
