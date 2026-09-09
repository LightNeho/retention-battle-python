import os


BASE_DIR = os.path.dirname(os.path.dirname(__file__))
DATABASE_URL = os.environ.get("DATABASE_URL")
AUTH_SECRET = os.environ.get("AUTH_SECRET", "dev-change-me")
IS_PRODUCTION = os.environ.get("VERCEL") == "1" or os.environ.get("FLASK_ENV") == "production"
DEFAULT_DATABASE_PATH = "/tmp/retention_battle.db" if os.environ.get("VERCEL") == "1" else os.path.join(BASE_DIR, "retention_battle.db")
DATABASE_PATH = os.environ.get("DATABASE_PATH", DEFAULT_DATABASE_PATH)
TOKEN_TTL_SECONDS = 12 * 60 * 60


def validate_runtime_config():
    if IS_PRODUCTION and AUTH_SECRET == "dev-change-me":
        raise RuntimeError("AUTH_SECRET must be configured in production.")
    if DATABASE_URL and not DATABASE_URL.startswith(("sqlite:///", "postgres://", "postgresql://")):
        raise RuntimeError("DATABASE_URL must start with sqlite:///, postgres://, or postgresql://.")
