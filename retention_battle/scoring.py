from . import db
from .utils import round1, shift_week_id


def config():
    out = {}
    for row in db.rows("config"):
        value = row["value"]
        try:
            out[row["key"]] = float(value) if "." in value else int(value)
        except (TypeError, ValueError):
            out[row["key"]] = value
    return out


def quality(review, cfg):
    weights = [cfg.get("Weight_Tashaul", 1), cfg.get("Weight_HatamatHatzaa", 1), cfg.get("Weight_EichutSherut", 1)]
    values = [review.get("tashaul") or 0, review.get("hatamat_hatzaa") or 0, review.get("eichut_sherut") or 0]
    return round1(sum(float(v) * float(w) for v, w in zip(values, weights)) / sum(weights))


def call_points(review, cfg):
    points = quality(review, cfg) * float(cfg.get("QualityWeight", 1))
    if review.get("retention_success") == "כן":
        points += float(cfg.get("RetentionSuccessPoints", 0))
    if review.get("excellent_call_bonus") == "כן":
        points += float(cfg.get("ExcellentCallBonusPoints", 0))
    return round1(points)


def _rank(items, keys):
    items.sort(key=lambda item: tuple(item[key] for key in keys), reverse=True)
    previous = _rank_tuple = None
    for index, item in enumerate(items, 1):
        current = tuple(item[key] for key in keys)
        item["rank"] = index
        item["tied"] = current == previous
        item["tiedWith"] = []
        previous = current
    return items


def agent_leaderboard(week_id):
    cfg = config()
    reviews = db.rows("call_reviews", "WHERE week_id=? AND status!='CANCELLED'", (week_id,))
    bonuses = db.rows("bonuses", "WHERE week_id=? AND target_type='AGENT'", (week_id,))
    previous = {a["agentId"]: a["rank"] for a in _agent_leaderboard_without_change(shift_week_id(week_id, -1), cfg)}
    result = _agent_leaderboard_without_change(week_id, cfg, reviews, bonuses)
    for item in result:
        item["rankChange"] = previous.get(item["agentId"], item["rank"]) - item["rank"]
    return result


def _agent_leaderboard_without_change(week_id, cfg, reviews=None, bonuses=None):
    reviews = reviews if reviews is not None else db.rows("call_reviews", "WHERE week_id=? AND status!='CANCELLED'", (week_id,))
    bonuses = bonuses if bonuses is not None else db.rows("bonuses", "WHERE week_id=? AND target_type='AGENT'", (week_id,))
    result = []
    for agent in db.rows("agents", "WHERE status!='INACTIVE'"):
        agent_reviews = [r for r in reviews if r["agent_id"] == agent["agent_id"] and (r["review_purpose"] or "COMPETITION") == "COMPETITION"]
        points = sum(call_points(r, cfg) for r in agent_reviews)
        agent_bonuses = [b for b in bonuses if b["target_id"] == agent["agent_id"]]
        success = len([r for r in agent_reviews if r["retention_success"] == "כן"])
        avg_quality = round1(sum(quality(r, cfg) for r in agent_reviews) / len(agent_reviews)) if agent_reviews else 0
        result.append({
            "agentId": agent["agent_id"],
            "name": agent["name"],
            "teamId": agent["team_id"],
            "points": round1(points + sum(float(b["points"]) for b in agent_bonuses)),
            "callsReviewed": len(agent_reviews),
            "successfulRetentions": success,
            "successRate": round1(success / len(agent_reviews) * 100) if agent_reviews else 0,
            "avgQuality": avg_quality,
            "bonusPoints": round1(sum(float(b["points"]) for b in agent_bonuses)),
            "perfectCalls": len([r for r in agent_reviews if r["retention_success"] == "כן" and quality(r, cfg) >= cfg.get("PerfectCallQualityThreshold", 9)]),
            "eligibleForStats": len(agent_reviews) >= cfg.get("MinimumSampleSize", 3),
        })
    return _rank(result, ["points", "successRate", "avgQuality", "successfulRetentions", "perfectCalls"])


def team_leaderboard(week_id):
    cfg = config()
    agents = agent_leaderboard(week_id)
    previous = {t["teamId"]: t["rank"] for t in _team_leaderboard_without_change(shift_week_id(week_id, -1), cfg)}
    result = _team_leaderboard_without_change(week_id, cfg, agents=agents)
    for item in result:
        item["rankChange"] = previous.get(item["teamId"], item["rank"]) - item["rank"]
    return result


def _team_leaderboard_without_change(week_id, cfg, agents=None):
    agents = agents if agents is not None else _agent_leaderboard_without_change(week_id, cfg)
    result = []
    target = cfg.get("WeeklyRetentionTargetPercent", 30)
    for team in db.rows("teams"):
        team_agents = [a for a in agents if a["teamId"] == team["team_id"]]
        total = round1(sum(a["points"] for a in team_agents))
        calls = sum(a["callsReviewed"] for a in team_agents)
        successes = sum(a["successfulRetentions"] for a in team_agents)
        score = round1(total / (len(team_agents) or 1))
        success_rate = round1(successes / calls * 100) if calls else 0
        result.append({
            "teamId": team["team_id"],
            "name": team["name"],
            "leaderId": team["team_leader_id"],
            "division": team["division"],
            "score": score,
            "totalPoints": total,
            "avgPoints": score,
            "agentCount": len(team_agents),
            "callsReviewed": calls,
            "successfulRetentions": successes,
            "successRate": success_rate,
            "avgQuality": round1(sum(a["avgQuality"] for a in team_agents) / (len(team_agents) or 1)),
            "weeklyTargetPercent": target,
            "targetProgress": min(100, round1(success_rate / target * 100)) if target else 0,
            "improvement": 0,
        })
    ranked = []
    for division in sorted({item["division"] for item in result}):
        ranked.extend(_rank([item for item in result if item["division"] == division], ["score", "successRate", "avgQuality"]))
    return ranked


def leader_leaderboard(week_id):
    teams = {team["leaderId"]: team for team in team_leaderboard(week_id)}
    result = []
    for leader in db.rows("team_leaders"):
        team = teams.get(leader["leader_id"])
        if not team:
            continue
        result.append({
            "leaderId": leader["leader_id"],
            "name": leader["name"],
            "teamId": leader["team_id"],
            "teamName": team["name"],
            "score": team["score"],
            "teamScore": team["score"],
            "successRate": team["successRate"],
            "avgQuality": team["avgQuality"],
            "improvement": 0,
            "tasksCompleted": 0,
            "tasksTotal": len(db.rows("manager_tasks", "WHERE active=1")),
            "taskCompletionRate": 0,
            "bonusPoints": 0,
        })
    return _rank(result, ["score", "successRate", "avgQuality"])

