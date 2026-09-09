import random
from datetime import date, datetime

from . import db
from .auth import hash_pin
from .utils import current_week_id, generate_id, now_iso


def config():
    out = {}
    for row in db.rows("config"):
        value = row["value"]
        try:
            out[row["key"]] = float(value) if "." in value else int(value)
        except (TypeError, ValueError):
            out[row["key"]] = value
    return out


def init_db():
    db.setup_schema()
    if db.rows("config"):
        return
    defaults = {
        "Weight_Tashaul": 1,
        "Weight_HatamatHatzaa": 1.2,
        "Weight_EichutSherut": 1,
        "QualityWeight": 1,
        "RetentionSuccessPoints": 15,
        "ExcellentCallBonusPoints": 5,
        "PerfectCallQualityThreshold": 9,
        "TeamScoreMethod": "AVERAGE",
        "WeeklyRetentionTargetPercent": 30,
        "MinimumSampleSize": 3,
        "CurrentWeekId": current_week_id(),
    }
    for key, value in defaults.items():
        db.upsert_config(key, value)
    seed_demo()


def seed_demo():
    team_defs = [
        ("שימור", "פרואקטיב", "דקלה", "1710", ["דניאל לוי", "מאיה אברהם", "איתי בר", "נועה שלום", "יובל פרץ"]),
        ("שימור", "פולס", "שי", "2105", ["אורי דהן", "טל מזרחי", "ליאור אזולאי", "הדר נחום"]),
        ("שימור", "אירון", "קסם", "2604", ["גיל שמעוני", "רוני חדד", "עדי סבן", "נדב ביטון", "שני אוחנה"]),
        ("שירות", "ליגה", "פז", "1110", ["אלון כרמי", "קרן בוזגלו", "עידן פיינגולד", "מיכל טל"]),
        ("שירות", "טוי", "רינת", "2912", ["שקד מלכה", "יעל אשכנזי", "בר כהן", "עומרי לוין"]),
    ]
    for division, team_name, leader_name, pin, agents in team_defs:
        team_id, leader_id = generate_id("tm"), generate_id("ldr")
        db.insert("teams", {"team_id": team_id, "name": team_name, "team_leader_id": leader_id, "division": division})
        db.insert("team_leaders", {"leader_id": leader_id, "name": leader_name, "team_id": team_id})
        db.insert("users", {"user_id": leader_id, "name": leader_name, "role": "TEAM_LEADER", "team_id": team_id, "email": "", "pin_hash": hash_pin(pin), "claimed": 1})
        for agent_name in agents:
            agent_id = generate_id("agt")
            db.insert("agents", {"agent_id": agent_id, "name": agent_name, "team_id": team_id, "status": "ACTIVE", "join_date": now_iso()})
            db.insert("users", {"user_id": agent_id, "name": agent_name, "role": "AGENT", "team_id": team_id, "email": "", "pin_hash": "", "claimed": 0})
    for name, pin in [("נהוראי", "1808"), ("סברין", "3101"), ("שקד", "2701"), ("משי", "1509"), ("טליה", "0212")]:
        db.insert("users", {"user_id": generate_id("sm"), "name": name, "role": "SHIFT_MANAGER", "team_id": "", "email": "", "pin_hash": hash_pin(pin), "claimed": 1})
    for value in ["מחיר", "שירות לקוי", "מתחרים", "חוסר שימוש", "מעבר דירה/סגירת עסק", "אחר"]:
        db.insert("leave_reasons", {"reason_id": generate_id("lr"), "value": value, "active": 1})
    for value in ["הנחה זמנית", "שדרוג חבילה", "חודש מתנה", "הקפאת חשבון", "שירות נוסף ללא עלות"]:
        db.insert("offers", {"offer_id": generate_id("of"), "value": value, "active": 1})
    seed_reviews()


def seed_reviews():
    from .reviews import save_review_record

    agents = db.rows("agents")
    teams = {team["team_id"]: team for team in db.rows("teams")}
    reviewer = db.one("users", "WHERE role='SHIFT_MANAGER'")
    reasons = [row["value"] for row in db.rows("leave_reasons")]
    offers = [row["value"] for row in db.rows("offers")]
    for _ in range(38):
        agent = random.choice(agents)
        team = teams[agent["team_id"]]
        success = random.random() < 0.55
        save_review_record({
            "reviewer_id": reviewer["user_id"],
            "agent_id": agent["agent_id"],
            "customer_number": "05" + str(random.randint(10000000, 99999999)),
            "tashaul": random.randint(5, 10),
            "hatamat_hatzaa": random.randint(5, 10),
            "eichut_sherut": random.randint(5, 10),
            "review_purpose": "COMPETITION",
            "retention_success": "כן" if success else "לא",
            "leave_reason": random.choice(reasons),
            "offer_given": random.choice(offers) if success else "",
            "excellent_call_bonus": "כן" if random.random() < 0.1 else "לא",
            "reviewer_note": "שיחה נבדקה במסגרת בקרת איכות שוטפת.",
            "week_id": current_week_id(),
            "team_id": team["team_id"],
            "leader_id": team["team_leader_id"],
        })

