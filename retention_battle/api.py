from collections import Counter
from datetime import date, timedelta

from . import db
from .auth import change_own_pin, current_user, login, register_agent, require_role, set_user_pin
from .reviews import agent_review_history, save_call_review
from .scoring import agent_leaderboard, call_points, config, leader_leaderboard, quality, team_leaderboard
from .seed import init_db
from .utils import current_week_id, generate_id, now_iso


def _public_agents_for_team(team_id, claimed=None):
    result = []
    for agent in db.rows("agents", "WHERE team_id=? AND status!='INACTIVE'", (team_id,)):
        user = db.one("users", "WHERE user_id=?", (agent["agent_id"],))
        if claimed is None or bool(user["claimed"]) == claimed:
            result.append({"agentId": agent["agent_id"], "name": agent["name"], "teamId": agent["team_id"]})
    return result


def _team_battle_by_division(week_id):
    flat = team_leaderboard(week_id)
    return [{"division": division, "teams": [team for team in flat if team["division"] == division]} for division in sorted({team["division"] for team in flat})]


def _dashboard(week_id):
    agents = agent_leaderboard(week_id)
    teams = team_leaderboard(week_id)
    leaders = leader_leaderboard(week_id)
    today = date.today()
    end_date = today + timedelta(days=6 - today.weekday())
    leading_teams = []
    for division in sorted({team["division"] for team in teams}):
        leading_teams.append({
            "division": division,
            "team": next((team for team in teams if team["division"] == division and team["rank"] == 1), None),
        })
    return {
        "weekId": week_id,
        "weekMeta": {"weekId": week_id, "endDate": end_date.isoformat()},
        "kpis": {
            "leadingTeamsByDivision": leading_teams,
            "topAgent": agents[0] if agents else None,
            "leadingLeader": leaders[0] if leaders else None,
        },
        "teamBattleByDivision": _team_battle_by_division(week_id),
        "topAgents": agents[:5],
        "agentLeaderboard": agents,
        "leaderBattle": leaders,
        "activityFeed": get_activity_feed(week_id, None, 10),
    }


def _analytics(week_id):
    cfg = config()
    reviews = db.rows("call_reviews", "WHERE week_id=? AND status!='CANCELLED'", (week_id,))
    by_reason = Counter(row["leave_reason"] or "לא צוין" for row in reviews)
    by_offer = Counter(row["offer_given"] or "ללא הצעה" for row in reviews)
    labels = sorted({row["date"] for row in reviews})
    teams = team_leaderboard(week_id)
    total_calls = len(reviews)
    total_retention = len([row for row in reviews if row["retention_success"] == "כן"])
    return {
        "overallRetentionRate": round(total_retention / total_calls * 100, 1) if total_calls else 0,
        "dailyTrend": [{"date": label, "calls": len([r for r in reviews if r["date"] == label]), "retentions": len([r for r in reviews if r["date"] == label and r["retention_success"] == "כן"])} for label in labels],
        "retentionsByTeam": [{"name": team["name"], "successRate": team["successRate"]} for team in teams],
        "qualityByCategory": {
            "תשאול": round(sum(float(r["tashaul"] or 0) for r in reviews) / (len(reviews) or 1), 1),
            "התאמת הצעה": round(sum(float(r["hatamat_hatzaa"] or 0) for r in reviews) / (len(reviews) or 1), 1),
            "איכות שירות": round(sum(float(r["eichut_sherut"] or 0) for r in reviews) / (len(reviews) or 1), 1),
        },
        "topLeaveReasons": [{"reason": key, "count": value} for key, value in by_reason.most_common()],
        "offers": [{"label": key, "value": value} for key, value in by_offer.most_common()],
        "avgQuality": round(sum(quality(row, cfg) for row in reviews) / (len(reviews) or 1), 1),
    }


def _badge_definitions():
    badges = db.rows("badges", "WHERE active=1")
    if not badges:
        defaults = [
            ("bdg_mvp", "MVP", "*", "הנציג עם הניקוד הגבוה ביותר"),
            ("bdg_quality", "PERFECT CALL", "◇", "שיחה עם ציון איכות גבוה ושימור"),
            ("bdg_retention", "הצלף", "◎", "אחוז השימור הגבוה ביותר"),
        ]
        for badge_id, name, icon, desc in defaults:
            db.insert("badges", {"badge_id": badge_id, "name": name, "icon": icon, "description": desc, "condition_key": badge_id, "minimum_sample": 0, "active": 1})
        badges = db.rows("badges", "WHERE active=1")
    return [{"badgeId": b["badge_id"], "name": b["name"], "icon": b["icon"], "description": b["description"]} for b in badges]


def _admin_overview():
    week_id = config().get("CurrentWeekId", current_week_id())
    teams = team_leaderboard(week_id)
    leading = []
    for division in sorted({team["division"] for team in teams}):
        leader = next((team for team in teams if team["division"] == division and team["rank"] == 1), None)
        leading.append({"division": division, "team": leader})
    recent = []
    cfg = config()
    for row in db.rows("call_reviews", "WHERE status!='CANCELLED' ORDER BY timestamp DESC LIMIT 8"):
        recent.append({
            "date": row["date"],
            "time": row["time"],
            "qualityScore": quality(row, cfg),
            "retentionSuccess": row["retention_success"],
        })
    return {
        "totalReviewsThisWeek": len(db.rows("call_reviews", "WHERE week_id=? AND status!='CANCELLED'", (week_id,))),
        "agentCount": len(db.rows("agents", "WHERE status!='INACTIVE'")),
        "teamCount": len(db.rows("teams")),
        "pendingManualTasks": [],
        "leadingTeamsByDivision": leading,
        "recentReviews": recent,
        "unclaimedAgents": len([u for u in db.rows("users", "WHERE role='AGENT'") if not bool(u["claimed"])]),
    }


def _todays_review_plan():
    agents = agent_leaderboard(config().get("CurrentWeekId", current_week_id()))
    teams = []
    for team in db.rows("teams"):
        team_agents = [agent for agent in agents if agent["teamId"] == team["team_id"]]
        completed = len([agent for agent in team_agents if agent["callsReviewed"] > 0])
        teams.append({
            "teamId": team["team_id"],
            "teamName": team["name"],
            "coveragePercent": round(completed / (len(team_agents) or 1) * 100, 1),
            "completedCount": completed,
            "eligibleCount": len(team_agents),
            "nextAgents": [{"agentId": a["agentId"], "name": a["name"], "roundStatus": "NEW"} for a in sorted(team_agents, key=lambda a: a["callsReviewed"])[:3]],
        })
    return teams


def _weekly_coverage():
    plan = _todays_review_plan()
    by_division = {}
    team_divisions = {team["team_id"]: team["division"] for team in db.rows("teams")}
    for item in plan:
        division = team_divisions.get(item["teamId"], "")
        bucket = by_division.setdefault(division, {"division": division, "completedCount": 0, "eligibleCount": 0})
        bucket["completedCount"] += item["completedCount"]
        bucket["eligibleCount"] += item["eligibleCount"]
    return [{**bucket, "coveragePercent": round(bucket["completedCount"] / (bucket["eligibleCount"] or 1) * 100, 1)} for bucket in by_division.values()]


def _weekly_wrap_up():
    week_id = config().get("CurrentWeekId", current_week_id())
    teams = team_leaderboard(week_id)
    agents = agent_leaderboard(week_id)
    divisions = []
    for division in sorted({team["division"] for team in teams}):
        ranked = [team for team in teams if team["division"] == division]
        winner = ranked[0] if ranked else None
        runner = ranked[1] if len(ranked) > 1 else None
        divisions.append({
            "division": division,
            "winner": winner,
            "runnerUp": runner,
            "margin": round((winner["score"] - runner["score"]), 1) if winner and runner else 0,
            "tied": bool(winner and runner and winner["score"] == runner["score"]),
        })
    total_reviews = sum(agent["callsReviewed"] for agent in agents)
    return {
        "weekId": week_id,
        "alreadyClosed": bool(db.one("weekly_results", "WHERE week_id=?", (week_id,))),
        "totalReviewCount": total_reviews,
        "participatingAgentCount": len([agent for agent in agents if agent["callsReviewed"] > 0]),
        "participatingTeamCount": len([team for team in teams if team["callsReviewed"] > 0]),
        "warnings": [] if total_reviews else ["לא תועדו שיחות השבוע"],
        "divisionsSummary": divisions,
        "topAgent": agents[0] if agents else None,
        "topAgentTied": len(agents) > 1 and agents[0]["points"] == agents[1]["points"],
        "scoringConfigPreview": config(),
    }


def get_activity_feed(week_id, since_timestamp=None, limit=10):
    params = [week_id]
    where = "WHERE week_id=?"
    if since_timestamp:
        where += " AND timestamp>?"
        params.append(since_timestamp)
    params.append(int(limit or 10))
    return [{"eventId": r["event_id"], "message": r["message"], "weekId": r["week_id"], "timestamp": r["timestamp"]} for r in db.rows("activity_log", f"{where} ORDER BY timestamp DESC LIMIT ?", tuple(params))]


def _close_current_week(token):
    user = require_role(token, ["ADMIN", "SHIFT_MANAGER"])
    week_id = config().get("CurrentWeekId", current_week_id())
    teams = team_leaderboard(week_id)
    agents = agent_leaderboard(week_id)
    leaders = leader_leaderboard(week_id)
    winners = []
    for division in sorted({team["division"] for team in teams}):
        winners.extend([team for team in teams if team["division"] == division and team["rank"] == 1])
    db.insert("weekly_results", {"week_id": week_id, "closed_at": now_iso(), "closed_by": user["userId"], "snapshot_json": ""})
    db.insert("hall_of_fame", {
        "record_id": generate_id("hof"),
        "week_id": week_id,
        "winning_teams_json": str([winner["teamId"] for winner in winners]),
        "mvp_agent_id": agents[0]["agentId"] if agents else "",
        "winning_leader_id": leaders[0]["leaderId"] if leaders else "",
        "call_of_week_agent_id": "",
    })
    db.upsert_config("CurrentWeekId", current_week_id())
    return {
        "closedWeekId": week_id,
        "newWeekId": current_week_id(),
        "snapshot": {"winningTeamsByDivision": [{"division": w["division"], "teamId": w["teamId"], "teamName": w["name"], "score": w["score"]} for w in winners]},
        "winningTeams": winners,
    }


def _team_for_leader(user):
    team = db.one("teams", "WHERE team_leader_id=?", (user["userId"],))
    if not team:
        raise ValueError("לא נמצא צוות המשויך לראש הצוות")
    return team


def _can_access_agent_history(user, agent_id):
    if user["role"] in ("ADMIN", "SHIFT_MANAGER"):
        return
    if user["role"] == "AGENT" and user["userId"] == agent_id:
        return
    if user["role"] == "TEAM_LEADER":
        team = _team_for_leader(user)
        agent = db.one("agents", "WHERE agent_id=?", (agent_id,))
        if agent and agent["team_id"] == team["team_id"]:
            return
    raise ValueError("אין לך הרשאה לצפות בשיחות אלה")


def _team_call_history(token, week_id):
    user = require_role(token, ["TEAM_LEADER"])
    team = _team_for_leader(user)
    agents = db.rows("agents", "WHERE team_id=? AND status!='INACTIVE' ORDER BY name", (team["team_id"],))
    return {
        "teamId": team["team_id"],
        "teamName": team["name"],
        "agents": [
            {"agentId": agent["agent_id"], "name": agent["name"], "calls": agent_review_history(agent["agent_id"], week_id)}
            for agent in agents
        ],
    }


def _submit_review_appeal(token, review_id, reason):
    user = require_role(token, ["TEAM_LEADER"])
    team = _team_for_leader(user)
    review = db.one("call_reviews", "WHERE review_id=? AND status!='CANCELLED'", (review_id,))
    if not review or review["team_id"] != team["team_id"]:
        raise ValueError("לא נמצאה שיחה בצוות שלך")
    if db.one("review_appeals", "WHERE review_id=?", (review_id,)):
        raise ValueError("כבר הוגש ערעור עבור שיחה זו")
    reason = str(reason or "").strip()
    if len(reason) < 3:
        raise ValueError("יש לציין סיבת ערעור קצרה")
    appeal_id = generate_id("apl")
    db.insert("review_appeals", {
        "appeal_id": appeal_id,
        "review_id": review_id,
        "agent_id": review["agent_id"],
        "team_id": team["team_id"],
        "submitted_by": user["userId"],
        "reason": reason,
        "status": "PENDING",
        "submitted_at": now_iso(),
        "resolved_by": "",
        "resolved_at": "",
        "resolution_note": "",
    })
    db.insert("activity_log", {
        "event_id": generate_id("evt"),
        "message": f"{user['name']} הגיש/ה ערעור על בדיקת שיחה",
        "week_id": review["week_id"],
        "timestamp": now_iso(),
    })
    db.insert("audit_log", {
        "log_id": generate_id("aud"),
        "timestamp": now_iso(),
        "user_id": user["userId"],
        "user_name": user["name"],
        "action": "SUBMIT_REVIEW_APPEAL",
        "entity_type": "CALL_REVIEW",
        "entity_id": review_id,
        "old_value": "",
        "new_value": reason,
    })
    return {"appealId": appeal_id, "status": "PENDING"}


def dispatch(name, args):
    init_db()
    if name == "getCurrentWeekId":
        return config().get("CurrentWeekId", current_week_id())
    if name == "getAvailableWeeks":
        weeks = {current_week_id(), str(config().get("CurrentWeekId", current_week_id()))}
        weeks.update(row["week_id"] for row in db.rows("weekly_results"))
        return [{"weekId": week, "label": week, "closed": bool(db.one("weekly_results", "WHERE week_id=?", (week,)))} for week in sorted(weeks, reverse=True)]
    if name == "getCurrentUser":
        return current_user(args[0])
    if name == "getUsersForRoleSelection":
        return [{"userId": u["user_id"], "name": u["name"], "role": u["role"], "teamId": u["team_id"]} for u in db.rows("users")]
    if name == "login":
        return login(args[0], args[1])
    if name == "changeOwnPin":
        return change_own_pin(args[0], args[1], args[2])
    if name == "setUserPin":
        return set_user_pin(args[0], args[1], args[2])
    if name == "registerAgent":
        return register_agent(args[0])
    if name == "getDivisions":
        return sorted({team["division"] for team in db.rows("teams") if team["division"]})
    if name == "getTeamsByDivision":
        return [{"teamId": t["team_id"], "name": t["name"]} for t in db.rows("teams", "WHERE division=?", (args[0],))]
    if name == "getUnclaimedAgentsForTeam":
        return _public_agents_for_team(args[0], False)
    if name == "getClaimedAgentsForTeam":
        return _public_agents_for_team(args[0], True)
    if name == "getAgentsForTeam":
        require_role(args[0], ["ADMIN", "SHIFT_MANAGER", "TEAM_LEADER"])
        return _public_agents_for_team(args[1], None)
    if name == "getLeaderboard":
        return {"AGENT": agent_leaderboard, "TEAM": team_leaderboard, "LEADER": leader_leaderboard}[args[0]](args[1])
    if name == "getTeamBattleByDivision":
        return _team_battle_by_division(args[0])
    if name == "getDashboardData":
        current_user(args[0])
        return _dashboard(args[1])
    if name == "saveCallReview":
        user = require_role(args[0], ["ADMIN", "SHIFT_MANAGER", "TEAM_LEADER"])
        return save_call_review(user, args[1])
    if name == "getLeaveReasons":
        return [r["value"] for r in db.rows("leave_reasons", "WHERE active=1")]
    if name == "getOffers":
        return [r["value"] for r in db.rows("offers", "WHERE active=1")]
    if name == "getBadgeDefinitions":
        return _badge_definitions()
    if name == "getHallOfFame":
        history = []
        agent_names = {a["agent_id"]: a["name"] for a in db.rows("agents")}
        leader_names = {l["leader_id"]: l["name"] for l in db.rows("team_leaders")}
        team_names = {t["team_id"]: t for t in db.rows("teams")}
        for row in db.rows("hall_of_fame", "ORDER BY week_id DESC"):
            ids = [value.strip(" '[]") for value in (row["winning_teams_json"] or "").split(",") if value.strip(" '[]")]
            history.append({
                "weekId": row["week_id"],
                "winningTeams": [{"name": team_names.get(team_id, {}).get("name", team_id), "division": team_names.get(team_id, {}).get("division", "")} for team_id in ids],
                "mvpAgent": agent_names.get(row["mvp_agent_id"], ""),
                "winningLeader": leader_names.get(row["winning_leader_id"], ""),
            })
        return {"statistics": {"longestStreak": {"team": "", "length": 0}, "topWeeklyScore": 0}, "history": history}
    if name == "getAnalytics":
        return _analytics(args[0])
    if name == "getAdminConfig":
        require_role(args[0], ["ADMIN", "SHIFT_MANAGER"])
        return config()
    if name == "updateConfigValues":
        require_role(args[0], ["ADMIN", "SHIFT_MANAGER"])
        for key, value in args[1].items():
            db.upsert_config(key, value)
        return {"success": True}
    if name == "getAgentProfile":
        current_user(args[0])
        return next((agent for agent in agent_leaderboard(args[2]) if agent["agentId"] == args[1]), {})
    if name == "getTeamProfile":
        current_user(args[0])
        return next((team for team in team_leaderboard(args[2]) if team["teamId"] == args[1]), {})
    if name == "getLeaderDashboard":
        current_user(args[0])
        return next((leader for leader in leader_leaderboard(args[2]) if leader["leaderId"] == args[1]), {})
    if name == "getAgentReviewHistory":
        user = current_user(args[0])
        _can_access_agent_history(user, args[1])
        return agent_review_history(args[1], args[2])
    if name == "getTeamCallHistory":
        return _team_call_history(args[0], args[1])
    if name == "submitReviewAppeal":
        return _submit_review_appeal(args[0], args[1], args[2])
    if name == "getAllUsersForAdmin":
        require_role(args[0], ["ADMIN", "SHIFT_MANAGER"])
        return [{"userId": u["user_id"], "name": u["name"], "role": u["role"], "teamId": u["team_id"], "claimed": bool(u["claimed"])} for u in db.rows("users")]
    if name == "getAdminOverview":
        require_role(args[0], ["ADMIN", "SHIFT_MANAGER"])
        return _admin_overview()
    if name == "getActivityFeed":
        return get_activity_feed(args[0], args[1], args[2])
    if name == "closeCurrentWeek":
        return _close_current_week(args[0])
    if name in ("getManagerTaskResults", "getRotationExceptions"):
        return []
    if name == "getTodaysReviewPlan":
        require_role(args[0], ["ADMIN", "SHIFT_MANAGER"])
        return _todays_review_plan()
    if name == "getWeeklyCoverage":
        require_role(args[0], ["ADMIN", "SHIFT_MANAGER"])
        return _weekly_coverage()
    if name == "getWeeklyWrapUp":
        require_role(args[0], ["ADMIN", "SHIFT_MANAGER"])
        return _weekly_wrap_up()
    if name == "getAuditLogFilterOptions":
        return {}
    if name in ("completeManualTask", "deferAgentRound"):
        require_role(args[0], ["ADMIN", "SHIFT_MANAGER", "TEAM_LEADER"])
        return {"success": True}
    raise ValueError(f"פונקציה לא נתמכת עדיין: {name}")
