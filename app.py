import os
from datetime import date, datetime, time, timedelta
from pathlib import Path
from urllib.parse import quote_plus

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from flask_socketio import SocketIO, join_room, leave_room
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import case, func

from ai_module import ensure_model_ready, generate_recommendation, get_ai_provider_status, get_model_quality_snapshot

load_dotenv()

app = Flask(__name__)
CORS(app)

db_engine = (os.getenv("DB_ENGINE", "sqlite") or "sqlite").lower()
mysql_user = os.getenv("MYSQL_USER", "root")
mysql_password = os.getenv("MYSQL_PASSWORD", "")
mysql_host = os.getenv("MYSQL_HOST", "localhost")
mysql_port = os.getenv("MYSQL_PORT", "3306")
mysql_db = os.getenv("MYSQL_DB", "smart_farm")
sqlite_path = os.getenv("SQLITE_PATH", "smart_farm.db")

mysql_user_encoded = quote_plus(mysql_user)
mysql_password_encoded = quote_plus(mysql_password)

if db_engine == "mysql":
    app.config["SQLALCHEMY_DATABASE_URI"] = (
        f"mysql+pymysql://{mysql_user_encoded}:{mysql_password_encoded}@{mysql_host}:{mysql_port}/{mysql_db}"
    )
else:
    sqlite_file = Path(sqlite_path)
    if not sqlite_file.is_absolute():
        sqlite_file = Path(app.root_path) / sqlite_file
    app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{sqlite_file.as_posix()}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False


db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*")
pending_device_commands = {}
scheduler = BackgroundScheduler(timezone="UTC")

BIGINT_PK = db.BigInteger().with_variant(db.Integer, "sqlite")


def normalize_language(language: str | None) -> str:
    language = (language or "en").lower()
    if language in {"en", "ta", "hi"}:
        return language
    return "en"


def initialize_database() -> None:
    db.create_all()

    default_farmer = Farmer.query.first()
    if not default_farmer:
        default_farmer = Farmer(farmer_name="Default Farmer", email="default@smartfarm.local")
        db.session.add(default_farmer)
        db.session.flush()

    default_field = Field.query.get(1)
    if not default_field:
        db.session.add(
            Field(
                field_id=1,
                farmer_id=default_farmer.farmer_id,
                field_name="Field 1",
                location_label="Default",
                area_acres=1,
                is_active=True,
            )
        )

    db.session.commit()


class Farmer(db.Model):
    __tablename__ = "farmer"

    farmer_id = db.Column(db.Integer, primary_key=True)
    farmer_name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(150), unique=True)


class Field(db.Model):
    __tablename__ = "field"

    field_id = db.Column(db.Integer, primary_key=True)
    farmer_id = db.Column(db.Integer, db.ForeignKey("farmer.farmer_id"), nullable=False)
    field_name = db.Column(db.String(120), nullable=False)
    location_label = db.Column(db.String(200))
    area_acres = db.Column(db.Numeric(8, 2), default=0)
    is_active = db.Column(db.Boolean, default=True)


class SensorReading(db.Model):
    __tablename__ = "sensor_reading"
    __table_args__ = (
        db.Index("idx_sensor_reading_field_recorded", "field_id", "recorded_at"),
        db.Index("idx_sensor_reading_recorded", "recorded_at"),
    )

    reading_id = db.Column(BIGINT_PK, primary_key=True, autoincrement=True)
    field_id = db.Column(db.Integer, db.ForeignKey("field.field_id"), nullable=False)
    moisture_percent = db.Column(db.Numeric(5, 2), nullable=False)
    rain_detected = db.Column(db.Boolean, nullable=False)
    temperature_c = db.Column(db.Numeric(5, 2), nullable=False)
    humidity_percent = db.Column(db.Numeric(5, 2), nullable=False)
    source_type = db.Column(db.Enum("scheduled", "realtime", "hourly"), nullable=False, default="scheduled")
    recorded_at = db.Column(db.DateTime, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Recommendation(db.Model):
    __tablename__ = "recommendation"

    recommendation_id = db.Column(BIGINT_PK, primary_key=True, autoincrement=True)
    field_id = db.Column(db.Integer, db.ForeignKey("field.field_id"), nullable=False)
    reading_id = db.Column(BIGINT_PK, db.ForeignKey("sensor_reading.reading_id"), nullable=True)
    irrigation_action = db.Column(db.Text, nullable=False)
    crop_health_status = db.Column(db.String(60), nullable=False)
    resource_optimization_tip = db.Column(db.Text, nullable=False)
    confidence_score = db.Column(db.Numeric(4, 2), nullable=False)
    generated_summary = db.Column(db.Text, nullable=False)
    generated_at = db.Column(db.DateTime, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class DailySummary(db.Model):
    __tablename__ = "daily_summary"
    __table_args__ = (
        db.UniqueConstraint("field_id", "summary_date", name="uq_daily_summary_field_date"),
        db.Index("idx_daily_summary_field_date", "field_id", "summary_date"),
    )

    summary_id = db.Column(BIGINT_PK, primary_key=True, autoincrement=True)
    field_id = db.Column(db.Integer, db.ForeignKey("field.field_id"), nullable=False)
    avg_moisture = db.Column(db.Numeric(6, 2), nullable=False)
    avg_temperature = db.Column(db.Numeric(6, 2), nullable=False)
    avg_humidity = db.Column(db.Numeric(6, 2), nullable=False)
    rain_frequency = db.Column(db.Integer, nullable=False, default=0)
    summary_date = db.Column(db.Date, nullable=False)
    generated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)


def _hour_bucket_expression():
    if db_engine == "mysql":
        return func.date_format(SensorReading.recorded_at, "%Y-%m-%d %H:00:00")
    return func.strftime("%Y-%m-%d %H:00:00", SensorReading.recorded_at)


def _serialize_live_payload(field_id: int, reading: SensorReading, recommendation: Recommendation):
    provider_status = get_ai_provider_status()
    now = datetime.utcnow()
    minutes_since = max(0, int((now - reading.recorded_at).total_seconds() // 60))
    if minutes_since <= 20:
        esp32_status = "online"
    elif minutes_since <= 120:
        esp32_status = "delayed"
    else:
        esp32_status = "offline"
    queued_at = pending_device_commands.get(field_id)
    return {
        "field_id": field_id,
        "latest_reading": {
            "reading_id": reading.reading_id,
            "soil_moisture": float(reading.moisture_percent),
            "rain_detected": int(reading.rain_detected),
            "temperature_c": float(reading.temperature_c),
            "humidity": float(reading.humidity_percent),
            "source_type": reading.source_type,
            "recorded_at": reading.recorded_at.isoformat(),
        },
        "latest_recommendation": {
            "provider": provider_status.get("provider", "gemini"),
            "irrigation_action": recommendation.irrigation_action,
            "crop_health_status": recommendation.crop_health_status,
            "resource_optimization_tip": recommendation.resource_optimization_tip,
            "confidence_score": float(recommendation.confidence_score),
            "generated_summary": recommendation.generated_summary,
            "generated_at": recommendation.generated_at.isoformat(),
        },
        "device_status": {
            "field_id": field_id,
            "esp32_status": esp32_status,
            "last_seen": reading.recorded_at.isoformat(),
            "minutes_since_last_seen": minutes_since,
            "latest_source_type": reading.source_type,
            "command_pending": queued_at is not None,
            "command_queued_at": queued_at.isoformat() if queued_at else None,
        },
    }


def _generate_recommendation_resilient(current_payload: dict, history_payload: list, language: str, use_external: bool = False):
    """Generate a recommendation.

    When *use_external* is True the external LLM (Gemini) is attempted first.
    Otherwise only the local ML model / rule engine is used (fast, no API cost).
    """
    try:
        return generate_recommendation(current_payload, history_payload, language=language, use_external=use_external)
    except RuntimeError as ex:
        error_text = str(ex)
        if "Gemini suggestion is required but unavailable" not in error_text:
            raise

        # Temporarily disable strict external-provider requirement and retry with local model.
        original_value = os.getenv("REQUIRE_GEMINI")
        os.environ["REQUIRE_GEMINI"] = "false"
        try:
            return generate_recommendation(current_payload, history_payload, language=language, use_external=False)
        finally:
            if original_value is None:
                os.environ.pop("REQUIRE_GEMINI", None)
            else:
                os.environ["REQUIRE_GEMINI"] = original_value


def aggregate_and_cleanup_for_date(summary_day: date) -> dict:
    day_start = datetime.combine(summary_day, time.min)
    next_day = day_start + timedelta(days=1)

    rain_case = case((SensorReading.rain_detected.is_(True), 1), else_=0)
    aggregate_rows = (
        db.session.query(
            SensorReading.field_id.label("field_id"),
            func.avg(SensorReading.moisture_percent).label("avg_moisture"),
            func.avg(SensorReading.temperature_c).label("avg_temperature"),
            func.avg(SensorReading.humidity_percent).label("avg_humidity"),
            func.sum(rain_case).label("rain_frequency"),
            func.min(SensorReading.moisture_percent).label("min_moisture"),
            func.max(SensorReading.moisture_percent).label("max_moisture"),
            func.min(SensorReading.temperature_c).label("min_temperature"),
            func.max(SensorReading.temperature_c).label("max_temperature"),
            func.min(SensorReading.humidity_percent).label("min_humidity"),
            func.max(SensorReading.humidity_percent).label("max_humidity"),
        )
        .filter(
            SensorReading.recorded_at >= day_start,
            SensorReading.recorded_at < next_day,
        )
        .group_by(SensorReading.field_id)
        .all()
    )

    now = datetime.utcnow()
    inserted_count = 0

    with db.session.begin():
        DailySummary.query.filter(DailySummary.summary_date == summary_day).delete(synchronize_session=False)

        for row in aggregate_rows:
            db.session.add(
                DailySummary(
                    field_id=int(row.field_id),
                    avg_moisture=float(row.avg_moisture or 0),
                    avg_temperature=float(row.avg_temperature or 0),
                    avg_humidity=float(row.avg_humidity or 0),
                    rain_frequency=int(row.rain_frequency or 0),
                    summary_date=summary_day,
                    generated_at=now,
                )
            )
            inserted_count += 1

        deleted_count = (
            SensorReading.query.filter(
                SensorReading.recorded_at >= day_start,
                SensorReading.recorded_at < next_day,
            ).delete(synchronize_session=False)
        )

    return {
        "summary_date": summary_day.isoformat(),
        "summary_rows": inserted_count,
        "deleted_hourly_rows": int(deleted_count),
    }


def run_daily_summary_job() -> None:
    with app.app_context():
        today_utc = datetime.utcnow().date()
        aggregate_and_cleanup_for_date(today_utc)


def start_scheduler() -> None:
    if scheduler.running:
        return

    scheduler.add_job(
        run_daily_summary_job,
        trigger=CronTrigger(hour=23, minute=59),
        id="daily_summary_2359",
        replace_existing=True,
    )
    scheduler.start()


@app.route("/")
def home_page():
    return render_template("home.html")


@app.route("/dashboard")
def dashboard_page():
    return render_template("dashboard.html")


@app.route("/suggestions")
def suggestions_page():
    return render_template("suggestions.html")


@app.route("/status")
def status_page():
    return render_template("status.html")


@app.route("/api/schedule", methods=["GET"])
def schedule_config():
    return jsonify({"scheduled_hours": [10, 11, 15, 18]})


@app.route("/api/farmer/fields", methods=["GET"])
def list_fields():
    fields = Field.query.filter_by(is_active=True).all()
    payload = [
        {
            "field_id": f.field_id,
            "field_name": f.field_name,
            "location_label": f.location_label,
            "area_acres": float(f.area_acres or 0),
        }
        for f in fields
    ]
    return jsonify(payload)


@app.route("/api/device/status", methods=["GET"])
def device_status():
    field_id = request.args.get("field_id", type=int)
    if not field_id:
        return jsonify({"error": "field_id is required"}), 400

    field = Field.query.get(field_id)
    if not field:
        return jsonify({"error": "Invalid field_id"}), 400

    latest = (
        SensorReading.query.filter_by(field_id=field_id)
        .order_by(SensorReading.recorded_at.desc())
        .first()
    )

    queued_at = pending_device_commands.get(field_id)
    now = datetime.utcnow()

    if not latest:
        return jsonify(
            {
                "field_id": field_id,
                "esp32_status": "no_data",
                "last_seen": None,
                "minutes_since_last_seen": None,
                "latest_source_type": None,
                "command_pending": queued_at is not None,
                "command_queued_at": queued_at.isoformat() if queued_at else None,
            }
        )

    minutes_since_last_seen = max(0, int((now - latest.recorded_at).total_seconds() // 60))
    if minutes_since_last_seen <= 20:
        esp32_status = "online"
    elif minutes_since_last_seen <= 120:
        esp32_status = "delayed"
    else:
        esp32_status = "offline"

    return jsonify(
        {
            "field_id": field_id,
            "esp32_status": esp32_status,
            "last_seen": latest.recorded_at.isoformat(),
            "minutes_since_last_seen": minutes_since_last_seen,
            "latest_source_type": latest.source_type,
            "command_pending": queued_at is not None,
            "command_queued_at": queued_at.isoformat() if queued_at else None,
        }
    )


@app.route("/api/model/quality", methods=["GET"])
def model_quality():
    return jsonify(get_model_quality_snapshot())


@app.route("/api/ai/provider", methods=["GET"])
def ai_provider_status():
    return jsonify(get_ai_provider_status())


@app.route("/api/device/manual-check", methods=["POST"])
def queue_manual_device_check():
    body = request.get_json(force=True)
    field_id = body.get("field_id")

    if not field_id:
        return jsonify({"error": "field_id is required"}), 400

    field = Field.query.get(field_id)
    if not field:
        return jsonify({"error": "Invalid field_id"}), 400

    pending_device_commands[int(field_id)] = datetime.utcnow()
    return jsonify(
        {
            "message": "Manual check command queued",
            "field_id": int(field_id),
        }
    )


@app.route("/api/device/next-command", methods=["GET"])
def get_next_device_command():
    field_id = request.args.get("field_id", type=int)
    if not field_id:
        return jsonify({"error": "field_id is required"}), 400

    queued_at = pending_device_commands.pop(field_id, None)
    if not queued_at:
        return jsonify({"command": None})

    return jsonify(
        {
            "command": "now",
            "queued_at": queued_at.isoformat(),
        }
    )


@app.route("/api/ingest", methods=["POST"])
def ingest_data():
    body = request.get_json(force=True)

    field_id = body.get("field_id")
    if not field_id:
        return jsonify({"error": "field_id is required"}), 400

    field = Field.query.get(field_id)
    if not field:
        return jsonify({"error": "Invalid field_id"}), 400

    try:
        recorded_at = body.get("recorded_at")
        recorded_at = datetime.fromisoformat(recorded_at) if recorded_at else datetime.utcnow()

        reading = SensorReading(
            field_id=field_id,
            moisture_percent=float(body.get("soil_moisture", 0.0)),
            rain_detected=bool(body.get("rain_detected", 0)),
            temperature_c=float(body.get("temperature_c", 0.0)),
            humidity_percent=float(body.get("humidity", 0.0)),
            source_type=body.get("source_type", "scheduled"),
            recorded_at=recorded_at,
        )

        db.session.add(reading)
        db.session.flush()

        history_rows = (
            SensorReading.query.filter_by(field_id=field_id)
            .order_by(SensorReading.recorded_at.desc())
            .limit(24)
            .all()
        )

        history_payload = [
            {
                "soil_moisture": float(h.moisture_percent),
                "rain_detected": int(h.rain_detected),
                "temperature_c": float(h.temperature_c),
                "humidity": float(h.humidity_percent),
            }
            for h in history_rows
        ]

        current_payload = {
            "soil_moisture": float(reading.moisture_percent),
            "rain_detected": int(reading.rain_detected),
            "temperature_c": float(reading.temperature_c),
            "humidity": float(reading.humidity_percent),
        }
        rec_obj = _generate_recommendation_resilient(current_payload, history_payload, language="en")

        recommendation = Recommendation(
            field_id=field_id,
            reading_id=reading.reading_id,
            irrigation_action=rec_obj.irrigation_action,
            crop_health_status=rec_obj.crop_health_status,
            resource_optimization_tip=rec_obj.resource_optimization_tip,
            confidence_score=rec_obj.confidence_score,
            generated_summary=rec_obj.generated_summary,
            generated_at=datetime.utcnow(),
        )
        db.session.add(recommendation)
        db.session.commit()

        socketio.emit(
            "sensor_update",
            _serialize_live_payload(field_id, reading, recommendation),
            room=f"field_{field_id}",
        )

        return jsonify(
            {
                "message": "Reading and recommendation stored",
                "reading_id": reading.reading_id,
                "recommendation_generated": True,
            }
        )
    except Exception as ex:
        db.session.rollback()
        return jsonify({"error": str(ex)}), 500


@app.route("/api/fields/<int:field_id>/latest", methods=["GET"])
def latest_data(field_id: int):
    language = normalize_language(request.args.get("lang", "en"))
    provider_status = get_ai_provider_status()

    reading = (
        SensorReading.query.filter_by(field_id=field_id)
        .order_by(SensorReading.recorded_at.desc())
        .first()
    )
    rec = (
        Recommendation.query.filter_by(field_id=field_id)
        .order_by(Recommendation.generated_at.desc())
        .first()
    )

    localized_rec = None
    if rec and reading and language != "en":
        history_rows = (
            SensorReading.query.filter_by(field_id=field_id)
            .order_by(SensorReading.recorded_at.desc())
            .limit(24)
            .all()
        )
        history_payload = [
            {
                "soil_moisture": float(h.moisture_percent),
                "rain_detected": int(h.rain_detected),
                "temperature_c": float(h.temperature_c),
                "humidity": float(h.humidity_percent),
            }
            for h in history_rows
        ]
        current_payload = {
            "soil_moisture": float(reading.moisture_percent),
            "rain_detected": int(reading.rain_detected),
            "temperature_c": float(reading.temperature_c),
            "humidity": float(reading.humidity_percent),
        }
        localized_rec = _generate_recommendation_resilient(current_payload, history_payload, language=language)

    return jsonify(
        {
            "latest_reading": None
            if not reading
            else {
                "reading_id": reading.reading_id,
                "soil_moisture": float(reading.moisture_percent),
                "rain_detected": int(reading.rain_detected),
                "temperature_c": float(reading.temperature_c),
                "humidity": float(reading.humidity_percent),
                "source_type": reading.source_type,
                "recorded_at": reading.recorded_at.isoformat(),
            },
            "latest_recommendation": None
            if not rec
            else {
                "provider": provider_status.get("provider", "gemini"),
                "irrigation_action": localized_rec.irrigation_action if localized_rec else rec.irrigation_action,
                "crop_health_status": localized_rec.crop_health_status if localized_rec else rec.crop_health_status,
                "resource_optimization_tip": localized_rec.resource_optimization_tip
                if localized_rec
                else rec.resource_optimization_tip,
                "confidence_score": float(localized_rec.confidence_score)
                if localized_rec
                else float(rec.confidence_score),
                "generated_summary": localized_rec.generated_summary if localized_rec else rec.generated_summary,
                "generated_at": rec.generated_at.isoformat(),
            },
        }
    )


@app.route("/api/fields/<int:field_id>/history", methods=["GET"])
def field_history(field_id: int):
    mode = (request.args.get("mode", "realtime") or "realtime").lower()
    hours = int(request.args.get("hours", 48))
    if mode == "daily":
        day_window = max(1, int((hours + 23) / 24))
        start_day = datetime.utcnow().date() - timedelta(days=day_window - 1)
        rows = (
            DailySummary.query.filter(
                DailySummary.field_id == field_id,
                DailySummary.summary_date >= start_day,
            )
            .order_by(DailySummary.summary_date.asc())
            .all()
        )

        return jsonify(
            [
                {
                    "summary_date": row.summary_date.isoformat(),
                    "avg_moisture": float(row.avg_moisture),
                    "avg_temperature": float(row.avg_temperature),
                    "avg_humidity": float(row.avg_humidity),
                    "rain_frequency": int(row.rain_frequency),
                    "generated_at": row.generated_at.isoformat(),
                }
                for row in rows
            ]
        )

    if mode == "hourly":
        start_day = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        end_day = start_day + timedelta(days=1)
        bucket_expr = _hour_bucket_expression().label("hour_bucket")
        rain_case = case((SensorReading.rain_detected.is_(True), 1), else_=0)

        rows = (
            db.session.query(
                bucket_expr,
                func.avg(SensorReading.moisture_percent).label("soil_moisture"),
                func.avg(SensorReading.temperature_c).label("temperature_c"),
                func.avg(SensorReading.humidity_percent).label("humidity"),
                func.max(rain_case).label("rain_detected"),
                func.min(SensorReading.moisture_percent).label("min_moisture"),
                func.max(SensorReading.moisture_percent).label("max_moisture"),
            )
            .filter(
                SensorReading.field_id == field_id,
                SensorReading.recorded_at >= start_day,
                SensorReading.recorded_at < end_day,
            )
            .group_by(bucket_expr)
            .order_by(bucket_expr.asc())
            .all()
        )

        return jsonify(
            [
                {
                    "recorded_at": str(row.hour_bucket).replace(" ", "T"),
                    "soil_moisture": float(row.soil_moisture or 0),
                    "temperature_c": float(row.temperature_c or 0),
                    "humidity": float(row.humidity or 0),
                    "rain_detected": int(row.rain_detected or 0),
                    "min_moisture": float(row.min_moisture or 0),
                    "max_moisture": float(row.max_moisture or 0),
                    "source_type": "hourly",
                }
                for row in rows
            ]
        )

    since = datetime.utcnow() - timedelta(hours=hours)

    rows = (
        SensorReading.query.filter(
            SensorReading.field_id == field_id,
            SensorReading.recorded_at >= since,
        )
        .order_by(SensorReading.recorded_at.asc())
        .all()
    )

    return jsonify(
        [
            {
                "reading_id": r.reading_id,
                "soil_moisture": float(r.moisture_percent),
                "rain_detected": int(r.rain_detected),
                "temperature_c": float(r.temperature_c),
                "humidity": float(r.humidity_percent),
                "source_type": r.source_type,
                "recorded_at": r.recorded_at.isoformat(),
            }
            for r in rows
        ]
    )


@app.route("/api/daily-summary/run", methods=["POST"])
def trigger_daily_summary():
    body = request.get_json(silent=True) or {}
    date_str = body.get("summary_date")
    if date_str:
        target = datetime.fromisoformat(date_str).date()
    else:
        target = datetime.utcnow().date()

    result = aggregate_and_cleanup_for_date(target)
    return jsonify({"message": "Daily summary generated", **result})


@socketio.on("subscribe_field")
def on_subscribe_field(data):
    field_id = int((data or {}).get("field_id", 0) or 0)
    if not field_id:
        return
    join_room(f"field_{field_id}")


@socketio.on("unsubscribe_field")
def on_unsubscribe_field(data):
    field_id = int((data or {}).get("field_id", 0) or 0)
    if not field_id:
        return
    leave_room(f"field_{field_id}")


@app.route("/api/fields/<int:field_id>/recommend", methods=["POST"])
def create_recommendation(field_id: int):
    body = request.get_json(silent=True) or {}
    language = normalize_language(body.get("lang") or request.args.get("lang", "en"))

    latest = (
        SensorReading.query.filter_by(field_id=field_id)
        .order_by(SensorReading.recorded_at.desc())
        .first()
    )
    if not latest:
        return jsonify({"error": "No sensor data available for this field"}), 404

    history_rows = (
        SensorReading.query.filter_by(field_id=field_id)
        .order_by(SensorReading.recorded_at.desc())
        .limit(24)
        .all()
    )

    history_payload = [
        {
            "soil_moisture": float(h.moisture_percent),
            "rain_detected": int(h.rain_detected),
            "temperature_c": float(h.temperature_c),
            "humidity": float(h.humidity_percent),
        }
        for h in history_rows
    ]

    current_payload = {
        "soil_moisture": float(latest.moisture_percent),
        "rain_detected": int(latest.rain_detected),
        "temperature_c": float(latest.temperature_c),
        "humidity": float(latest.humidity_percent),
    }

    rec_obj = _generate_recommendation_resilient(current_payload, history_payload, language=language, use_external=True)

    rec = Recommendation(
        field_id=field_id,
        reading_id=latest.reading_id,
        irrigation_action=rec_obj.irrigation_action,
        crop_health_status=rec_obj.crop_health_status,
        resource_optimization_tip=rec_obj.resource_optimization_tip,
        confidence_score=rec_obj.confidence_score,
        generated_summary=rec_obj.generated_summary,
        generated_at=datetime.utcnow(),
    )
    db.session.add(rec)
    db.session.commit()

    return jsonify(
        {
            "message": "Recommendation generated",
            "recommendation": {
                "provider": get_ai_provider_status().get("provider", "gemini"),
                "irrigation_action": rec.irrigation_action,
                "crop_health_status": rec.crop_health_status,
                "resource_optimization_tip": rec.resource_optimization_tip,
                "confidence_score": float(rec.confidence_score),
                "generated_summary": rec.generated_summary,
                "generated_at": rec.generated_at.isoformat(),
            },
        }
    )


if __name__ == "__main__":
    debug_mode = True
    with app.app_context():
        initialize_database()
        if (os.getenv("PRELOAD_LOCAL_MODEL", "false") or "false").lower() in {"1", "true", "yes", "on"}:
            ensure_model_ready()
        start_scheduler()
    socketio.run(app, host="0.0.0.0", port=5000, debug=debug_mode, use_reloader=False)
