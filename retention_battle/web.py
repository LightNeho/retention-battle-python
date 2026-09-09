from flask import Flask, jsonify, render_template, request

from .api import dispatch
from .seed import init_db
from .settings import validate_runtime_config


def create_app():
    validate_runtime_config()
    init_db()
    app = Flask(__name__, template_folder="../templates")

    @app.route("/")
    def index():
        return render_template("index.html", tvMode=request.args.get("mode") == "tv")

    @app.route("/landing")
    def landing():
        return render_template("Landing.html")

    @app.route("/api/call", methods=["POST"])
    def api_call():
        payload = request.get_json(force=True)
        try:
            return jsonify({"success": True, "data": dispatch(payload.get("function"), payload.get("args", []))})
        except Exception as exc:
            return jsonify({"success": False, "error": str(exc)}), 400

    return app

