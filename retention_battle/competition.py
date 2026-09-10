from . import db
from .scoring import config
from .utils import current_week_id


STATUS_NOT_STARTED = "NOT_STARTED"
STATUS_ACTIVE = "ACTIVE"
STATUS_PAUSED = "PAUSED"
VALID_STATUSES = {STATUS_NOT_STARTED, STATUS_ACTIVE, STATUS_PAUSED}


def _status_key(division):
    return f"CompetitionStatus:{division}"


def status_for_division(division):
    return str(config().get(_status_key(division), STATUS_NOT_STARTED))


def states():
    divisions = sorted({team["division"] for team in db.rows("teams") if team["division"]})
    return [{"division": division, "status": status_for_division(division)} for division in divisions]


def set_status(division, status):
    if status not in VALID_STATUSES:
        raise ValueError("סטטוס תחרות לא תקין")
    if not db.one("teams", "WHERE division=?", (division,)):
        raise ValueError("מחלקה לא נמצאה")
    db.upsert_config(_status_key(division), status)
    return {"division": division, "status": status}


def require_active_for_team(team_id):
    team = db.one("teams", "WHERE team_id=?", (team_id,))
    if not team:
        raise ValueError("צוות לא נמצא")
    status = status_for_division(team["division"])
    if status == STATUS_PAUSED:
        raise ValueError(f"התחרות במחלקת {team['division']} מושהית כרגע")
    if status != STATUS_ACTIVE:
        raise ValueError(f"התחרות במחלקת {team['division']} עדיין לא התחילה")


def reset_division(division, week_id=None):
    if not db.one("teams", "WHERE division=?", (division,)):
        raise ValueError("מחלקה לא נמצאה")
    week_id = week_id or current_week_id()
    teams = db.rows("teams", "WHERE division=?", (division,))
    team_ids = [team["team_id"] for team in teams]
    agent_ids = [agent["agent_id"] for team_id in team_ids for agent in db.rows("agents", "WHERE team_id=?", (team_id,))]
    review_ids = []
    for team_id in team_ids:
        review_ids.extend(review["review_id"] for review in db.rows("call_reviews", "WHERE team_id=? AND week_id=?", (team_id, week_id)))
    for review_id in review_ids:
        db.delete("review_appeals", "WHERE review_id=?", (review_id,))
    for team_id in team_ids:
        db.delete("call_reviews", "WHERE team_id=? AND week_id=?", (team_id, week_id))
        db.delete("bonuses", "WHERE target_type='TEAM' AND target_id=? AND week_id=?", (team_id, week_id))
        db.delete("badge_awards", "WHERE target_type='TEAM' AND target_id=? AND week_id=?", (team_id, week_id))
    for agent_id in agent_ids:
        db.delete("bonuses", "WHERE target_type='AGENT' AND target_id=? AND week_id=?", (agent_id, week_id))
        db.delete("badge_awards", "WHERE target_type='AGENT' AND target_id=? AND week_id=?", (agent_id, week_id))
    set_status(division, STATUS_NOT_STARTED)
    return {"division": division, "status": STATUS_NOT_STARTED, "removedReviews": len(review_ids)}
