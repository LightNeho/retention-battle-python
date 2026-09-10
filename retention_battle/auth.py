import hashlib
import hmac
import random
import time

from . import db
from .settings import AUTH_SECRET, TOKEN_TTL_SECONDS


def hash_pin(pin):
    return hmac.new(AUTH_SECRET.encode(), f"PIN:{pin}".encode(), hashlib.sha256).hexdigest()


def _sign(message):
    return hmac.new(AUTH_SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()


def generate_token(user_id):
    expiry = int(time.time()) + TOKEN_TTL_SECONDS
    payload = f"{user_id}.{expiry}"
    return f"{payload}.{_sign('TOKEN:' + payload)}"


def verify_token(token):
    if not token:
        raise ValueError("נדרשת התחברות מחדש")
    parts = str(token).split(".")
    if len(parts) != 3:
        raise ValueError("פג תוקף ההתחברות, יש להתחבר מחדש")
    user_id, expiry, signature = parts
    expected = _sign(f"TOKEN:{user_id}.{expiry}")
    if not hmac.compare_digest(signature, expected) or int(expiry) < int(time.time()):
        raise ValueError("פג תוקף ההתחברות, יש להתחבר מחדש")
    return user_id


def public_user(row):
    return {"userId": row["user_id"], "name": row["name"], "role": row["role"], "teamId": row["team_id"] or None}


def current_user(token):
    user = db.one("users", "WHERE user_id=?", (verify_token(token),))
    if not user:
        raise ValueError("משתמש לא נמצא")
    return public_user(user)


def require_role(token, allowed_roles):
    user = current_user(token)
    if user["role"] not in allowed_roles:
        raise ValueError("אין לך הרשאה לבצע פעולה זו")
    return user


def login(user_id, pin):
    user = db.one("users", "WHERE user_id=?", (user_id,))
    if not user or not user["pin_hash"] or hash_pin(pin) != user["pin_hash"]:
        raise ValueError("קוד PIN שגוי")
    return {"token": generate_token(user["user_id"]), "user": public_user(user)}


def register_agent(agent_id):
    agent = db.one("agents", "WHERE agent_id=?", (agent_id,))
    user = db.one("users", "WHERE user_id=?", (agent_id,))
    if not agent or not user:
        raise ValueError("נציג לא נמצא")
    if user["role"] != "AGENT":
        raise ValueError("הרשמה עצמית זמינה לנציגים בלבד")
    if bool(user["claimed"]):
        raise ValueError("השם הזה כבר נרשם במערכת")
    pin = str(random.randint(1000, 9999))
    db.update("users", "user_id", agent_id, {"pin_hash": hash_pin(pin), "claimed": 1})
    return {"pin": pin, "token": generate_token(agent_id), "user": public_user({**user, "pin_hash": hash_pin(pin), "claimed": 1})}


def change_own_pin(token, old_pin, new_pin):
    user_id = verify_token(token)
    user = db.one("users", "WHERE user_id=?", (user_id,))
    if not user or hash_pin(old_pin) != user["pin_hash"]:
        raise ValueError("קוד ה-PIN הנוכחי שגוי")
    if not new_pin or len(str(new_pin)) < 4:
        raise ValueError("קוד PIN חייב לכלול לפחות 4 ספרות")
    db.update("users", "user_id", user_id, {"pin_hash": hash_pin(new_pin)})
    return {"success": True}


def set_user_pin(actor_token, target_user_id, new_pin):
    require_role(actor_token, ["ADMIN", "SHIFT_MANAGER"])
    if not new_pin or len(str(new_pin)) < 4:
        raise ValueError("קוד PIN חייב לכלול לפחות 4 ספרות")
    if not db.one("users", "WHERE user_id=?", (target_user_id,)):
        raise ValueError("משתמש לא נמצא")
    db.update("users", "user_id", target_user_id, {"pin_hash": hash_pin(new_pin), "claimed": 1})
    return {"success": True}
