import sqlite3

from .settings import DATABASE_PATH, DATABASE_URL


_POSTGRES_POOL = None


SCHEMAS = {
    "config": "key TEXT PRIMARY KEY, value TEXT",
    "users": "user_id TEXT PRIMARY KEY, name TEXT, role TEXT, team_id TEXT, email TEXT, pin_hash TEXT, claimed INTEGER",
    "teams": "team_id TEXT PRIMARY KEY, name TEXT, team_leader_id TEXT, division TEXT",
    "agents": "agent_id TEXT PRIMARY KEY, name TEXT, team_id TEXT, status TEXT, join_date TEXT",
    "team_leaders": "leader_id TEXT PRIMARY KEY, name TEXT, team_id TEXT",
    "call_reviews": """review_id TEXT PRIMARY KEY, date TEXT, time TEXT, timestamp TEXT, reviewer_id TEXT,
        agent_id TEXT, team_id TEXT, leader_id TEXT, customer_number TEXT, tashaul REAL, hatamat_hatzaa REAL,
        eichut_sherut REAL, review_purpose TEXT, round_id TEXT, retention_success TEXT, leave_reason TEXT,
        offer_given TEXT, excellent_call_bonus TEXT, reviewer_note TEXT, week_id TEXT, status TEXT""",
    "manager_tasks": "task_id TEXT PRIMARY KEY, name TEXT, description TEXT, points REAL, type TEXT, condition_key TEXT, target_value REAL, active INTEGER",
    "manager_task_results": "result_id TEXT PRIMARY KEY, task_id TEXT, leader_id TEXT, week_id TEXT, status TEXT, progress REAL, updated_at TEXT, approved_by TEXT",
    "bonuses": "bonus_id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT, points REAL, reason TEXT, week_id TEXT, given_by TEXT, given_at TEXT",
    "badges": "badge_id TEXT PRIMARY KEY, name TEXT, icon TEXT, description TEXT, condition_key TEXT, minimum_sample INTEGER, active INTEGER",
    "badge_awards": "award_id TEXT PRIMARY KEY, badge_id TEXT, target_type TEXT, target_id TEXT, week_id TEXT, awarded_at TEXT, awarded_by TEXT",
    "weekly_results": "week_id TEXT PRIMARY KEY, closed_at TEXT, closed_by TEXT, snapshot_json TEXT",
    "hall_of_fame": "record_id TEXT PRIMARY KEY, week_id TEXT, winning_teams_json TEXT, mvp_agent_id TEXT, winning_leader_id TEXT, call_of_week_agent_id TEXT",
    "activity_log": "event_id TEXT PRIMARY KEY, message TEXT, week_id TEXT, timestamp TEXT",
    "audit_log": "log_id TEXT PRIMARY KEY, timestamp TEXT, user_id TEXT, user_name TEXT, action TEXT, entity_type TEXT, entity_id TEXT, old_value TEXT, new_value TEXT",
    "leave_reasons": "reason_id TEXT PRIMARY KEY, value TEXT, active INTEGER",
    "offers": "offer_id TEXT PRIMARY KEY, value TEXT, active INTEGER",
}


def is_postgres():
    return bool(DATABASE_URL and DATABASE_URL.startswith(("postgres://", "postgresql://")))


def placeholder():
    return "%s" if is_postgres() else "?"


def _postgres_pool():
    global _POSTGRES_POOL
    if _POSTGRES_POOL is None:
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool

        _POSTGRES_POOL = ConnectionPool(
            conninfo=DATABASE_URL,
            min_size=1,
            max_size=3,
            kwargs={"row_factory": dict_row, "prepare_threshold": None},
        )
    return _POSTGRES_POOL


def connect():
    if is_postgres():
        return _postgres_pool().connection()
    if DATABASE_URL and DATABASE_URL.startswith("sqlite:///"):
        path = DATABASE_URL.replace("sqlite:///", "", 1)
    else:
        path = DATABASE_PATH
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def setup_schema():
    with connect() as conn:
        for table, schema in SCHEMAS.items():
            conn.execute(f"CREATE TABLE IF NOT EXISTS {table} ({schema})")


def rows(table, where="", params=()):
    where = _sql(where)
    with connect() as conn:
        cur = conn.execute(f"SELECT * FROM {table} {where}", params)
        return [dict(row) for row in cur.fetchall()]


def one(table, where, params=()):
    result = rows(table, where, params)
    return result[0] if result else None


def insert(table, data):
    keys = list(data.keys())
    placeholders = ",".join([placeholder()] * len(keys))
    with connect() as conn:
        conn.execute(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({placeholders})", [data[k] for k in keys])


def update(table, key_field, key_value, data):
    keys = list(data.keys())
    if not keys:
        return
    assignments = ",".join([f"{key}={placeholder()}" for key in keys])
    with connect() as conn:
        conn.execute(f"UPDATE {table} SET {assignments} WHERE {key_field}={placeholder()}", [data[k] for k in keys] + [key_value])


def upsert_config(key, value):
    p = placeholder()
    with connect() as conn:
        conn.execute(
            f"INSERT INTO config (key, value) VALUES ({p}, {p}) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )


def _sql(fragment):
    if not is_postgres():
        return fragment
    return fragment.replace("?", "%s")
