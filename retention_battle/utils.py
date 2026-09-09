import secrets
import time
from datetime import date, datetime, timedelta


def generate_id(prefix):
    return f"{prefix}_{int(time.time() * 1000):x}{secrets.token_hex(3)}"


def now_iso():
    return datetime.utcnow().isoformat() + "Z"


def current_week_id():
    year, week, _ = date.today().isocalendar()
    return f"{year}-W{week:02d}"


def shift_week_id(week_id, delta):
    year, week = week_id.split("-W")
    shifted = date.fromisocalendar(int(year), int(week), 1) + timedelta(weeks=delta)
    year, week, _ = shifted.isocalendar()
    return f"{year}-W{week:02d}"


def round1(value):
    return round(float(value or 0), 1)

