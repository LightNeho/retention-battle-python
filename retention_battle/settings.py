import os


BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DATABASE_PATH = os.environ.get("DATABASE_PATH", os.path.join(BASE_DIR, "retention_battle.db"))
DATABASE_URL = os.environ.get("DATABASE_URL")
AUTH_SECRET = os.environ.get("AUTH_SECRET", "dev-change-me")
IS_PRODUCTION = os.environ.get("VERCEL") == "1" or os.environ.get("FLASK_ENV") == "production"
TOKEN_TTL_SECONDS = 12 * 60 * 60


def validate_runtime_config():
    if IS_PRODUCTION and AUTH_SECRET == "dev-change-me":
        raise RuntimeError("AUTH_SECRET must be configured in production.")
    if DATABASE_URL and not DATABASE_URL.startswith("sqlite:///"):
        raise RuntimeError("Only sqlite:/// DATABASE_URL is wired in this version. Use DATABASE_PATH locally, or add a Postgres adapter before production data.")
