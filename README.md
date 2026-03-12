# Smart Farm Monitoring and Recommendation System

This project implements a **single-farmer, multi-field** smart agriculture system using:
- **ESP32** + capacitive soil moisture sensor + rain sensor + DHT22
- **Flask backend** for API and analytics
- **MySQL** with DBMS-driven schema design
- **Trainable ML recommendation model** (scikit-learn) for irrigation and crop/resource decisions
- **Interactive dashboard** built with HTML, CSS, JavaScript

## 1) Features

- Scheduled sensor sampling at **10:00, 11:00, 15:00, 18:00** (ESP32 side)
- On-demand live reads from ESP32
- WiFi transmission from ESP32 to Flask API
- Normalized MySQL schema with:
  - primary keys and foreign keys
  - indexed query paths
  - timestamp tracking
  - multi-field support under one farmer
- Real-time + historical analytics and field-specific recommendations
- Dashboard with latest values, trends, and AI-generated recommendations
- Automatic model artifact creation on first app start

## 2) Folder Structure

- app.py: Flask backend + DB models + API routes
- ai_module.py: ML training + inference + fallback recommendation logic
- train_ai_model.py: manual retraining utility for the AI model
- schema.sql: MySQL schema and indexes
- templates/index.html: dashboard page
- static/style.css: UI styling
- static/app.js: dashboard behavior and chart rendering
- esp32/SmartFarmNode.ino: ESP32 firmware

## 3) Setup

1. Create and activate a Python environment.
2. Install dependencies:
   - `pip install -r requirements.txt`
3. Copy `.env.example` to `.env` and update MySQL credentials.
4. Create DB and tables:
   - run `schema.sql` in MySQL
5. Start Flask app:
   - `python app.py`
  - This also auto-initializes the AI model at `models/smartfarm_ai.joblib` if missing.

Optional: retrain model manually:
- `python train_ai_model.py`
6. Open dashboard:
   - `http://127.0.0.1:5000/`

### Gemini Integration (recommended)

To force all suggestions from Gemini, set these environment variables in `.env`:

- `AI_PROVIDER=gemini`
- `GEMINI_API_KEY=your_api_key`
- `REQUIRE_GEMINI=true`
- Optional: `GEMINI_MODEL=gemini-1.5-flash`
- Optional: `AI_REQUEST_TIMEOUT=12`

Provider status API:
- `GET /api/ai/provider`

## 4) API Overview

- `POST /api/ingest`
  - ESP32 pushes sensor data
- `GET /api/farmer/fields`
  - get all fields
- `GET /api/fields/<field_id>/latest`
  - latest sensor data + latest recommendation
- `GET /api/fields/<field_id>/history?hours=48`
  - historical points
- `POST /api/fields/<field_id>/recommend`
  - generate and store recommendation based on latest+history

## 5) ESP32 Notes

- Configure WiFi SSID/password and Flask server URL in `esp32/SmartFarmNode.ino`.
- Keep ESP32 and Flask server on reachable network.
- Sampling schedule is implemented via NTP-based hour checks.
- Offline hourly buffering uses a real **SQLite database** on SD card (`/sd/hourly_queue.db`), not CSV.
- Every hourly aggregate is saved to SD-card SQLite first, regardless of upload success/failure.
- End-of-day average is computed from all hourly rows and stored in local `daily_averages` table.
- Install an ESP32-compatible SQLite library in Arduino IDE (for example, `SQLite3` / `sqlite3.h`) before compiling firmware.

## 6) DBMS Design Notes

- **Normalization**:
  - farmer, field, sensor_type, field_sensor, sensor_reading, recommendation split into related entities
- **Key constraints**:
  - PK on each table
  - FK constraints to maintain referential integrity
- **Indexes**:
  - time-series and field-wise read paths indexed (`field_id`, `recorded_at`)
- **Timestamp management**:
  - `created_at`, `updated_at`, and `recorded_at` columns
