from datetime import date, datetime

from . import db
from .competition import require_active_for_team
from .utils import current_week_id, generate_id, now_iso


def save_review_record(data):
    agent_id = data.get("agent_id") or data.get("AgentId")
    agent = db.one("agents", "WHERE agent_id=?", (agent_id,))
    if not agent:
        raise ValueError("נציג לא נמצא")
    team = db.one("teams", "WHERE team_id=?", (agent["team_id"],))
    review_id = generate_id("rev")
    db.insert("call_reviews", {
        "review_id": review_id,
        "date": date.today().isoformat(),
        "time": datetime.now().strftime("%H:%M"),
        "timestamp": now_iso(),
        "reviewer_id": data.get("reviewer_id") or data.get("ReviewerId"),
        "agent_id": agent["agent_id"],
        "team_id": team["team_id"],
        "leader_id": team["team_leader_id"],
        "customer_number": data.get("customer_number") or data.get("CustomerNumber") or "",
        "tashaul": data.get("tashaul") or data.get("Tashaul") or 0,
        "hatamat_hatzaa": data.get("hatamat_hatzaa") or data.get("HatamatHatzaa") or 0,
        "eichut_sherut": data.get("eichut_sherut") or data.get("EichutSherut") or 0,
        "review_purpose": data.get("review_purpose") or data.get("ReviewPurpose") or "COMPETITION",
        "round_id": data.get("round_id") or "",
        "retention_success": data.get("retention_success") or data.get("RetentionSuccess") or "לא",
        "leave_reason": data.get("leave_reason") or data.get("LeaveReason") or "",
        "offer_given": data.get("offer_given") or data.get("OfferGiven") or "",
        "excellent_call_bonus": data.get("excellent_call_bonus") or data.get("ExcellentCallBonus") or "לא",
        "reviewer_note": data.get("reviewer_note") or data.get("ReviewerNote") or "",
        "week_id": data.get("week_id") or data.get("WeekId") or current_week_id(),
        "status": "ACTIVE",
    })
    return review_id


def save_call_review(user, data):
    payload = dict(data)
    agent = db.one("agents", "WHERE agent_id=?", (payload.get("agent_id") or payload.get("AgentId"),))
    if not agent:
        raise ValueError("נציג לא נמצא")
    require_active_for_team(agent["team_id"])
    payload["reviewer_id"] = user["userId"]
    review_id = save_review_record(payload)
    db.insert("activity_log", {
        "event_id": generate_id("evt"),
        "message": f"{user['name']} תיעד/ה שיחת לקוח חדשה",
        "week_id": payload.get("week_id") or payload.get("WeekId") or current_week_id(),
        "timestamp": now_iso(),
    })
    return {"status": "SAVED", "reviewId": review_id}


def agent_review_history(agent_id, week_id):
    from .scoring import call_points, config, quality

    cfg = config()
    result = []
    reviewers = {user["user_id"]: user["name"] for user in db.rows("users")}
    appeals = {appeal["review_id"]: appeal for appeal in db.rows("review_appeals", "WHERE agent_id=?", (agent_id,))}
    for row in db.rows("call_reviews", "WHERE agent_id=? AND week_id=? AND status!='CANCELLED' ORDER BY timestamp DESC", (agent_id, week_id)):
        appeal = appeals.get(row["review_id"])
        result.append({
            "reviewId": row["review_id"],
            "date": row["date"],
            "time": row["time"],
            "customerNumber": row["customer_number"],
            "retentionSuccess": row["retention_success"],
            "qualityScore": quality(row, cfg),
            "points": call_points(row, cfg),
            "reviewerNote": row["reviewer_note"],
            "reviewerName": reviewers.get(row["reviewer_id"], "לא צוין"),
            "excellentCallBonus": row["excellent_call_bonus"],
            "categories": {
                "tashaul": {"label": "תשאול", "value": row["tashaul"]},
                "hatamatHatzaa": {"label": "התאמת הצעה", "value": row["hatamat_hatzaa"]},
                "eichutSherut": {"label": "איכות שירות", "value": row["eichut_sherut"]},
            },
            "appealStatus": appeal["status"] if appeal else None,
            "appealReason": appeal["reason"] if appeal else "",
        })
    return result
