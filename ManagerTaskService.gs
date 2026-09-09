/**
 * ManagerTaskService.gs
 * משימות מנהל (לראשי צוות). תומך במשימות אוטומטיות (המערכת בודקת תנאי)
 * ומשימות ידניות (אחמ"ש מאשר). הנקודות מתווספות ל"ניקוד ראש הצוות" באופן
 * דינמי דרך CompetitionService (אין כפילות אחסון).
 */

/** הגדרות המשימות הפעילות (התבנית - לא הביצוע השבועי) */
function getActiveTaskDefinitions() {
  return readSheet(SHEET_NAMES.MANAGER_TASKS).filter(function (t) { return t.Active !== false && t.Active !== 'FALSE'; });
}

/**
 * מחזיר את תוצאות המשימות לשבוע, בפורמט נוח: { leaderId, taskId, status, progress, points }
 * יוצר אוטומטית שורות חסרות (לא התחיל) עבור כל שילוב leader x task פעיל.
 */
function getManagerTaskResults(weekId) {
  ensureTaskResultRows(weekId);
  var definitions = getActiveTaskDefinitions();
  var defMap = {};
  definitions.forEach(function (d) { defMap[d.TaskId] = d; });

  return readSheet(SHEET_NAMES.MANAGER_TASK_RESULTS)
    .filter(function (r) { return r.WeekId === weekId; })
    .map(function (r) {
      var def = defMap[r.TaskId] || {};
      return {
        resultId: r.ResultId,
        taskId: r.TaskId,
        taskName: def.Name,
        description: def.Description,
        type: def.Type,
        leaderId: r.LeaderId,
        status: r.Status,
        progress: Number(r.Progress || 0),
        points: r.Status === 'הושלם' ? Number(def.Points || 0) : 0,
        maxPoints: Number(def.Points || 0),
        updatedAt: r.UpdatedAt
      };
    });
}

function ensureTaskResultRows(weekId) {
  var definitions = getActiveTaskDefinitions();
  var leaders = readSheet(SHEET_NAMES.TEAM_LEADERS);
  var existing = readSheet(SHEET_NAMES.MANAGER_TASK_RESULTS).filter(function (r) { return r.WeekId === weekId; });
  var existingKeys = {};
  existing.forEach(function (r) { existingKeys[r.TaskId + '|' + r.LeaderId] = true; });

  var toCreate = [];
  definitions.forEach(function (def) {
    leaders.forEach(function (leader) {
      var key = def.TaskId + '|' + leader.LeaderId;
      if (!existingKeys[key]) {
        toCreate.push({
          ResultId: generateId('mtr'),
          TaskId: def.TaskId,
          LeaderId: leader.LeaderId,
          WeekId: weekId,
          Status: 'לא התחיל',
          Progress: 0,
          UpdatedAt: nowIso(),
          ApprovedBy: ''
        });
      }
    });
  });
  if (toCreate.length) appendRows(SHEET_NAMES.MANAGER_TASK_RESULTS, toCreate);
}

/** מריץ הערכה מחדש לכל המשימות האוטומטיות של השבוע. נקרא אחרי כל שמירת בדיקת שיחה. */
function evaluateAutomaticTasks(weekId) {
  ensureTaskResultRows(weekId);
  var definitions = getActiveTaskDefinitions().filter(function (d) { return d.Type === 'AUTO'; });
  if (!definitions.length) return;

  var config = readConfig();
  var teamStats = getTeamAggregatesRaw(weekId, config);
  var teamStatsFull = getTeamAggregates(weekId);
  var agentAggregates = getAgentAggregates(weekId);
  var leaders = readSheet(SHEET_NAMES.TEAM_LEADERS);
  var resultRows = readSheet(SHEET_NAMES.MANAGER_TASK_RESULTS).filter(function (r) { return r.WeekId === weekId; });

  leaders.forEach(function (leader) {
    var teamAgents = agentAggregates.filter(function (a) { return a.teamId === leader.TeamId; });
    var teamFull = teamStatsFull.filter(function (t) { return t.teamId === leader.TeamId; })[0];

    definitions.forEach(function (def) {
      var row = resultRows.filter(function (r) { return r.TaskId === def.TaskId && r.LeaderId === leader.LeaderId; })[0];
      if (!row || row.Status === 'הושלם') return; // כבר הושלם - אין צורך להעריך שוב

      var evalResult = evaluateCondition(def.ConditionKey, Number(def.TargetValue), {
        teamAgents: teamAgents, teamFull: teamFull, config: config, weekId: weekId
      });

      var newStatus = evalResult.met ? 'הושלם' : (evalResult.progress > 0 ? 'בתהליך' : 'לא התחיל');
      if (newStatus !== row.Status || evalResult.progress !== Number(row.Progress)) {
        updateRow(SHEET_NAMES.MANAGER_TASK_RESULTS, row._row, {
          Status: newStatus, Progress: evalResult.progress, UpdatedAt: nowIso()
        });
        if (newStatus === 'הושלם') {
          logActivity('✅ ' + leader.Name + ' השלים משימת מנהל: ' + def.Name, weekId);
        }
      }
    });
  });
}

/** מנוע תנאים - כל מפתח תנאי אפשרי ממופה כאן. הוספת תנאי חדש = הוספת case אחד. */
function evaluateCondition(conditionKey, targetValue, ctx) {
  var agents = ctx.teamAgents;
  var team = ctx.teamFull;
  var progress = 0;
  var met = false;

  switch (conditionKey) {
    case 'TEAM_QUALITY_PERCENT_ABOVE': {
      var qualified = agents.filter(function (a) { return a.avgQuality >= 8; }).length;
      progress = agents.length ? round1((qualified / agents.length) * 100) : 0;
      met = progress >= targetValue;
      break;
    }
    case 'ALL_AGENTS_REVIEWED': {
      var reviewed = agents.filter(function (a) { return a.callsReviewed >= 1; }).length;
      progress = agents.length ? round1((reviewed / agents.length) * 100) : 0;
      met = reviewed === agents.length && agents.length > 0;
      break;
    }
    case 'TEAM_IMPROVED': {
      met = team && team.improvement > 0;
      progress = met ? 100 : 0;
      break;
    }
    case 'AGENTS_WITH_RETENTION_COUNT': {
      var count = agents.filter(function (a) { return a.successfulRetentions >= 1; }).length;
      progress = targetValue ? round1(Math.min(100, (count / targetValue) * 100)) : 0;
      met = count >= targetValue;
      break;
    }
    case 'RETENTION_RATE_ABOVE_TARGET': {
      progress = team ? Math.min(100, round1((team.successRate / targetValue) * 100)) : 0;
      met = team && team.successRate >= targetValue;
      break;
    }
    case 'AVG_QUESTIONING_ABOVE': {
      var reviews = getReviewsForWeek(ctx.weekId);
      // מחושב ברמת נציגי הצוות בלבד
      var teamIds = agents.map(function (a) { return a.agentId; });
      var relevant = reviews.filter(function (r) { return teamIds.indexOf(r.AgentId) !== -1; });
      var avg = relevant.length
        ? relevant.reduce(function (s, r) { return s + Number(r.Tashaul || 0); }, 0) / relevant.length
        : 0;
      progress = round1(Math.min(100, (avg / targetValue) * 100));
      met = avg >= targetValue;
      break;
    }
    case 'TEAM_POINTS_ABOVE': {
      progress = team ? round1(Math.min(100, (team.totalPoints / targetValue) * 100)) : 0;
      met = team && team.totalPoints >= targetValue;
      break;
    }
    default:
      progress = 0;
      met = false;
  }
  return { met: met, progress: progress };
}

/** אישור משימה ידנית ע"י אחמ"ש/Admin */
function completeManualTask(currentUserId, resultId) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var rows = readSheet(SHEET_NAMES.MANAGER_TASK_RESULTS);
  var row = rows.filter(function (r) { return r.ResultId === resultId; })[0];
  if (!row) throw new Error('המשימה לא נמצאה');

  updateRow(SHEET_NAMES.MANAGER_TASK_RESULTS, row._row, {
    Status: 'הושלם', Progress: 100, UpdatedAt: nowIso(), ApprovedBy: user.userId
  });

  var leader = findById(SHEET_NAMES.TEAM_LEADERS, 'LeaderId', row.LeaderId);
  var task = findById(SHEET_NAMES.MANAGER_TASKS, 'TaskId', row.TaskId);
  writeAuditLog(user, 'אישור משימת מנהל', 'MANAGER_TASK_RESULTS', resultId, row.Status, 'הושלם');
  logActivity('✅ ' + (leader ? leader.Name : '') + ' השלים משימת מנהל: ' + (task ? task.Name : ''), row.WeekId);
  invalidateWeekCache(row.WeekId);
  return { success: true };
}

/** ביטול השלמת משימה (תיקון ע"י אחמ"ש) */
function revertManualTask(currentUserId, resultId) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var rows = readSheet(SHEET_NAMES.MANAGER_TASK_RESULTS);
  var row = rows.filter(function (r) { return r.ResultId === resultId; })[0];
  if (!row) throw new Error('המשימה לא נמצאה');
  updateRow(SHEET_NAMES.MANAGER_TASK_RESULTS, row._row, { Status: 'בתהליך', UpdatedAt: nowIso() });
  writeAuditLog(user, 'ביטול אישור משימת מנהל', 'MANAGER_TASK_RESULTS', resultId, 'הושלם', 'בתהליך');
  invalidateWeekCache(row.WeekId);
  return { success: true };
}

/** יצירת הגדרת משימה חדשה (Admin) */
function createManagerTaskDefinition(currentUserId, task) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  assertField(task.Name, 'שם המשימה');
  assertField(task.Points, 'ניקוד');
  var record = {
    TaskId: generateId('task'),
    Name: task.Name,
    Description: task.Description || '',
    Points: Number(task.Points),
    Type: task.Type === 'AUTO' ? 'AUTO' : 'MANUAL',
    ConditionKey: task.ConditionKey || '',
    TargetValue: task.TargetValue || 0,
    Active: true
  };
  appendRow(SHEET_NAMES.MANAGER_TASKS, record);
  writeAuditLog(user, 'יצירת משימת מנהל', 'MANAGER_TASKS', record.TaskId, '', JSON.stringify(record));
  return record;
}

/** עריכת הגדרת משימה קיימת (Admin) */
function updateManagerTaskDefinition(currentUserId, taskId, updates) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var task = findById(SHEET_NAMES.MANAGER_TASKS, 'TaskId', taskId);
  if (!task) throw new Error('משימה לא נמצאה');
  var before = JSON.stringify(task);
  updateRow(SHEET_NAMES.MANAGER_TASKS, task._row, updates);
  writeAuditLog(user, 'עריכת משימת מנהל', 'MANAGER_TASKS', taskId, before, JSON.stringify(updates));
  return { success: true };
}
