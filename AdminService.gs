/**
 * AdminService.gs
 * כל פעולות הניהול (אחמ"ש/Admin). כל שינוי נרשם ב-AUDIT_LOG דרך writeAuditLog.
 */

function writeAuditLog(user, action, entityType, entityId, oldValue, newValue) {
  appendRow(SHEET_NAMES.AUDIT_LOG, {
    LogId: generateId('audit'),
    Timestamp: nowIso(),
    UserId: user.userId,
    UserName: user.name,
    Action: action,
    EntityType: entityType,
    EntityId: entityId,
    OldValue: String(oldValue || '').substring(0, 4000),
    NewValue: String(newValue || '').substring(0, 4000)
  });
}

function getAuditLog(currentUserId, filters, limit) {
  requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  filters = filters || {};
  var rows = readSheet(SHEET_NAMES.AUDIT_LOG);
  if (filters.entityType) rows = rows.filter(function (r) { return r.EntityType === filters.entityType; });
  if (filters.userName) rows = rows.filter(function (r) { return r.UserName === filters.userName; });
  if (filters.search) {
    var q = String(filters.search).toLowerCase();
    rows = rows.filter(function (r) {
      return (r.Action || '').toLowerCase().indexOf(q) !== -1 || (r.UserName || '').toLowerCase().indexOf(q) !== -1 || (r.EntityId || '').toLowerCase().indexOf(q) !== -1;
    });
  }
  if (filters.dateFrom) rows = rows.filter(function (r) { return new Date(r.Timestamp) >= new Date(filters.dateFrom); });
  rows.sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); });
  return rows.slice(0, Math.min(limit || 100, 300)); // Cap קשיח - לא טוענים כמות בלתי מוגבלת לדפדפן
}

/** רשימת ערכי EntityType/UserName ייחודיים - להזנת ה-Filters בממשק בלי לטעון את כל ה-Log */
function getAuditLogFilterOptions(currentUserId) {
  requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var rows = readSheet(SHEET_NAMES.AUDIT_LOG);
  var entityTypes = {}, userNames = {};
  rows.forEach(function (r) { if (r.EntityType) entityTypes[r.EntityType] = true; if (r.UserName) userNames[r.UserName] = true; });
  return { entityTypes: Object.keys(entityTypes).sort(), userNames: Object.keys(userNames).sort() };
}

/* ---------- Agents ---------- */

function createAgent(currentUserId, agent) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  assertField(agent.Name, 'שם נציג');
  assertField(agent.TeamId, 'צוות');
  var record = { AgentId: generateId('agt'), Name: agent.Name, TeamId: agent.TeamId, Status: 'ACTIVE', JoinDate: nowIso() };
  appendRow(SHEET_NAMES.AGENTS, record);
  // רשומת USERS מקבילה, ללא PIN - הנציג יירשם בעצמו דרך מסך "כניסה ראשונה" ויקבל קוד PIN אקראי
  appendRow(SHEET_NAMES.USERS, { UserId: record.AgentId, Name: agent.Name, Role: 'AGENT', TeamId: agent.TeamId, Email: '', PinHash: '', Claimed: false });
  writeAuditLog(user, 'יצירת נציג', 'AGENTS', record.AgentId, '', JSON.stringify(record));
  invalidateWeekCache(getCurrentWeekId());
  return record;
}

function updateAgent(currentUserId, agentId, updates) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var agent = findById(SHEET_NAMES.AGENTS, 'AgentId', agentId);
  if (!agent) throw new Error('נציג לא נמצא');
  var before = JSON.stringify(agent);
  updateRow(SHEET_NAMES.AGENTS, agent._row, updates);
  writeAuditLog(user, 'עריכת נציג', 'AGENTS', agentId, before, JSON.stringify(updates));
  invalidateWeekCache(getCurrentWeekId());
  return { success: true };
}

/** כל נציגי צוות נתון (לא רק פעילים/רשומים) - לשימוש במסך "ניהול תחרות" */
function getAgentsForTeam(currentUserId, teamId) {
  requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  return readSheet(SHEET_NAMES.AGENTS)
    .filter(function (a) { return a.TeamId === teamId && a.Status !== 'INACTIVE'; })
    .map(function (a) { return { agentId: a.AgentId, name: a.Name }; });
}

/* ---------- Teams ---------- */

function createTeam(currentUserId, team) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  assertField(team.Name, 'שם צוות');
  assertField(team.Division, 'מוקד');
  var record = { TeamId: generateId('tm'), Name: team.Name, TeamLeaderId: team.TeamLeaderId || '', Division: team.Division };
  appendRow(SHEET_NAMES.TEAMS, record);
  writeAuditLog(user, 'יצירת צוות', 'TEAMS', record.TeamId, '', JSON.stringify(record));
  return record;
}

function updateTeam(currentUserId, teamId, updates) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var team = findById(SHEET_NAMES.TEAMS, 'TeamId', teamId);
  if (!team) throw new Error('צוות לא נמצא');
  var before = JSON.stringify(team);
  updateRow(SHEET_NAMES.TEAMS, team._row, updates);
  writeAuditLog(user, 'עריכת צוות', 'TEAMS', teamId, before, JSON.stringify(updates));
  invalidateWeekCache(getCurrentWeekId());
  return { success: true };
}

/* ---------- Team Leaders ---------- */

function createTeamLeader(currentUserId, leader) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  assertField(leader.Name, 'שם ראש צוות');
  assertField(leader.TeamId, 'צוות');
  var record = { LeaderId: generateId('ldr'), Name: leader.Name, TeamId: leader.TeamId };
  appendRow(SHEET_NAMES.TEAM_LEADERS, record);
  // ראשי צוות מקבלים גישה מיידית עם קוד PIN זמני (לא עוברים את תהליך ההרשמה העצמית של נציגים)
  appendRow(SHEET_NAMES.USERS, { UserId: record.LeaderId, Name: leader.Name, Role: 'TEAM_LEADER', TeamId: leader.TeamId, Email: '', PinHash: hashPin('1234'), Claimed: true });
  updateTeam(currentUserId, leader.TeamId, { TeamLeaderId: record.LeaderId });
  writeAuditLog(user, 'יצירת ראש צוות', 'TEAM_LEADERS', record.LeaderId, '', JSON.stringify(record));
  return record;
}

function updateTeamLeader(currentUserId, leaderId, updates) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var leader = findById(SHEET_NAMES.TEAM_LEADERS, 'LeaderId', leaderId);
  if (!leader) throw new Error('ראש צוות לא נמצא');
  var before = JSON.stringify(leader);
  updateRow(SHEET_NAMES.TEAM_LEADERS, leader._row, updates);
  writeAuditLog(user, 'עריכת ראש צוות', 'TEAM_LEADERS', leaderId, before, JSON.stringify(updates));
  invalidateWeekCache(getCurrentWeekId());
  return { success: true };
}

/* ---------- Bonuses ---------- */

/** מתן בונוס חד-פעמי לנציג או לראש צוות */
function giveBonus(currentUserId, targetType, targetId, points, reason) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  assertField(targetId, 'מקבל הבונוס');
  assertField(points, 'נקודות');
  var weekId = getCurrentWeekId();
  var record = {
    BonusId: generateId('bon'),
    TargetType: targetType, // AGENT | LEADER
    TargetId: targetId,
    Points: Number(points),
    Reason: reason || '',
    WeekId: weekId,
    GivenBy: user.userId,
    GivenAt: nowIso()
  };
  appendRow(SHEET_NAMES.BONUSES, record);
  var name = targetType === 'AGENT'
    ? (findById(SHEET_NAMES.AGENTS, 'AgentId', targetId) || {}).Name
    : (findById(SHEET_NAMES.TEAM_LEADERS, 'LeaderId', targetId) || {}).Name;
  logActivity('🎁 ' + name + ' קיבל/ה בונוס של ' + points + ' נקודות', weekId);
  writeAuditLog(user, 'מתן בונוס', 'BONUSES', record.BonusId, '', JSON.stringify(record));
  invalidateWeekCache(weekId);
  return { success: true };
}

/* ---------- Config ---------- */

function getAdminConfig(currentUserId) {
  requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  return readConfig();
}

function updateConfigValues(currentUserId, updates) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var before = readConfig();
  Object.keys(updates).forEach(function (key) { writeConfigValue(key, updates[key]); });
  writeAuditLog(user, 'עדכון הגדרות מערכת', 'CONFIG', 'bulk', JSON.stringify(before), JSON.stringify(updates));
  // שינוי משקלים משפיע על כל החישובים - מנקים Cache לכל השבועות הפעילים
  getAvailableWeeks().forEach(invalidateWeekCache);
  return { success: true };
}

/* ---------- Dropdowns: Leave Reasons / Offers ---------- */

function getLeaveReasons() {
  return readSheet(SHEET_NAMES.LEAVE_REASONS).filter(function (r) { return r.Active !== false; }).map(function (r) { return r.Value; });
}

function addLeaveReason(currentUserId, value) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  appendRow(SHEET_NAMES.LEAVE_REASONS, { ReasonId: generateId('lr'), Value: value, Active: true });
  writeAuditLog(user, 'הוספת סיבת נטישה', 'LEAVE_REASONS', value, '', value);
  return { success: true };
}

function getOffers() {
  return readSheet(SHEET_NAMES.OFFERS).filter(function (r) { return r.Active !== false; }).map(function (r) { return r.Value; });
}

function addOffer(currentUserId, value) {
  var user = requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  appendRow(SHEET_NAMES.OFFERS, { OfferId: generateId('of'), Value: value, Active: true });
  writeAuditLog(user, 'הוספת הצעה', 'OFFERS', value, '', value);
  return { success: true };
}

/* ---------- Admin summary screen ---------- */

/** נתונים למסך ה-Admin הראשי: משימות ממתינות לאישור, בדיקות אחרונות, סטטיסטיקות מהירות */
function getAdminOverview(currentUserId) {
  requireRole(currentUserId, ['ADMIN', 'SHIFT_MANAGER']);
  var weekId = getCurrentWeekId();
  var pendingTasks = getManagerTaskResults(weekId).filter(function (t) { return t.type === 'MANUAL' && t.status !== 'הושלם'; });
  var recentReviews = getCallReviews(weekId, {}).slice(0, 15);

  var reviewedAgentIds = {};
  getReviewsForWeek(weekId).forEach(function (r) { reviewedAgentIds[r.AgentId] = true; });
  var teamNames = {};
  readSheet(SHEET_NAMES.TEAMS).forEach(function (t) { teamNames[t.TeamId] = t.Name; });
  var agentsNotReviewed = readSheet(SHEET_NAMES.AGENTS)
    .filter(function (a) { return a.Status !== 'INACTIVE' && !reviewedAgentIds[a.AgentId]; })
    .map(function (a) { return { agentId: a.AgentId, name: a.Name, teamName: teamNames[a.TeamId] || '' }; });

  var leadingTeamsByDivision = getTeamBattleByDivision(weekId).map(function (group) {
    return { division: group.division, team: group.teams[0] || null };
  });

  return {
    weekId: weekId,
    pendingManualTasks: pendingTasks,
    recentReviews: recentReviews,
    totalReviewsThisWeek: getReviewsForWeek(weekId).length,
    teamCount: readSheet(SHEET_NAMES.TEAMS).length,
    agentCount: readSheet(SHEET_NAMES.AGENTS).filter(function (a) { return a.Status !== 'INACTIVE'; }).length,
    agentsNotReviewed: agentsNotReviewed,
    leadingTeamsByDivision: leadingTeamsByDivision
  };
}
