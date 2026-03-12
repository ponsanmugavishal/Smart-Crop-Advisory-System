from __future__ import annotations

from datetime import datetime
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
from typing import Any, Dict, List, Tuple
from urllib import error, request

try:
    import joblib
    import numpy as np
    from sklearn.base import clone
    from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier
    from sklearn.metrics import accuracy_score, f1_score
    from sklearn.model_selection import train_test_split

    ML_AVAILABLE = True
except Exception:
    ML_AVAILABLE = False


MODEL_FILE_PATH = Path(__file__).resolve().parent / "models" / "smartfarm_ai.joblib"
_MODEL_ARTIFACT: Dict[str, Any] | None = None
_LAST_TRAINING_REPORT: Dict[str, Any] | None = None


@dataclass
class RecommendationResult:
    irrigation_action: str
    crop_health_status: str
    resource_optimization_tip: str
    confidence_score: float
    generated_summary: str


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _normalize_language(language: str | None) -> str:
    if language in {"en", "ta", "hi"}:
        return language
    return "en"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _extract_first_json_object(text: str) -> Dict[str, Any] | None:
    if not text:
        return None

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    match = re.search(r"\{[\s\S]*\}", text)
    if not match:
        return None

    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _llm_prompt(current: Dict, history: List[Dict], language: str) -> str:
    recent = history[:6] if history else []
    return (
        "You are an agronomy assistant for smart farming. "
        "Return only valid JSON with keys: irrigation_action, crop_health_status, "
        "resource_optimization_tip, confidence_score, generated_summary. "
        "confidence_score must be a number between 0.55 and 0.99. "
        f"Language code: {language}. "
        f"Current sensor reading: {json.dumps(current, ensure_ascii=False)}. "
        f"Recent history: {json.dumps(recent, ensure_ascii=False)}."
    )


def _call_gemini(prompt: str, timeout_seconds: float) -> Dict[str, Any] | None:
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None

    model = (os.getenv("GEMINI_MODEL", "gemini-1.5-flash") or "gemini-1.5-flash").strip()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 500},
    }

    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=timeout_seconds) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (error.URLError, error.HTTPError, TimeoutError, json.JSONDecodeError):
        return None

    candidates = body.get("candidates") or []
    if not candidates:
        return None
    parts = candidates[0].get("content", {}).get("parts", [])
    text = "\n".join(str(part.get("text", "")) for part in parts)
    return _extract_first_json_object(text)


def _call_openai(prompt: str, timeout_seconds: float) -> Dict[str, Any] | None:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None

    model = (os.getenv("OPENAI_MODEL", "gpt-4o-mini") or "gpt-4o-mini").strip()
    url = "https://api.openai.com/v1/chat/completions"
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": "Return only valid JSON."},
            {"role": "user", "content": prompt},
        ],
    }

    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=timeout_seconds) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (error.URLError, error.HTTPError, TimeoutError, json.JSONDecodeError):
        return None

    choices = body.get("choices") or []
    if not choices:
        return None
    content = str(choices[0].get("message", {}).get("content", ""))
    return _extract_first_json_object(content)


def _generate_external_recommendation(current: Dict, history: List[Dict], language: str) -> RecommendationResult | None:
    provider = (os.getenv("AI_PROVIDER", "gemini") or "gemini").strip().lower()
    if provider not in {"gemini", "openai"}:
        return None

    timeout_seconds = float(os.getenv("AI_REQUEST_TIMEOUT", "12") or "12")
    prompt = _llm_prompt(current, history, language)

    raw = _call_gemini(prompt, timeout_seconds) if provider == "gemini" else _call_openai(prompt, timeout_seconds)
    if not isinstance(raw, dict):
        return None

    irrigation_action = str(raw.get("irrigation_action", "")).strip()
    crop_health_status = str(raw.get("crop_health_status", "")).strip()
    resource_optimization_tip = str(raw.get("resource_optimization_tip", "")).strip()
    generated_summary = str(raw.get("generated_summary", "")).strip()

    try:
        confidence = float(raw.get("confidence_score", 0.75))
    except Exception:
        confidence = 0.75
    confidence = round(_clamp(confidence, 0.55, 0.99), 2)

    if not irrigation_action or not crop_health_status or not resource_optimization_tip or not generated_summary:
        return None

    return RecommendationResult(
        irrigation_action=irrigation_action,
        crop_health_status=crop_health_status,
        resource_optimization_tip=resource_optimization_tip,
        confidence_score=confidence,
        generated_summary=f"Gemini suggestion: {generated_summary}" if provider == "gemini" else generated_summary,
    )


def get_ai_provider_status() -> Dict[str, Any]:
    provider = (os.getenv("AI_PROVIDER", "gemini") or "gemini").strip().lower()
    require_gemini = _env_bool("REQUIRE_GEMINI", True)
    gemini_configured = bool((os.getenv("GEMINI_API_KEY", "") or "").strip())

    return {
        "provider": provider,
        "require_gemini": require_gemini,
        "gemini_configured": gemini_configured,
    }


def _compute_risk_score(moisture: float, rain: int, temp: float, humidity: float) -> float:
    dryness_index = _clamp((42 - moisture) / 42, 0, 1)
    heat_stress = _clamp((temp - 31) / 13, 0, 1)
    low_humidity_stress = _clamp((42 - humidity) / 42, 0, 1)
    rain_buffer = 0.18 if rain == 1 else 0.0

    return _clamp(
        0.58 * dryness_index + 0.24 * heat_stress + 0.18 * low_humidity_stress - rain_buffer,
        0,
        1,
    )


def _rule_irrigation_class(moisture: float, rain: int) -> str:
    if rain == 1:
        return "skip_rain"
    if moisture < 25:
        return "irrigate_deep"
    if moisture < 35:
        return "irrigate_short"
    if moisture <= 60:
        return "maintain"
    return "pause_overwet"


def _rule_health_class(risk_score: float) -> str:
    if risk_score < 0.25:
        return "healthy"
    if risk_score < 0.55:
        return "mild_stress"
    return "high_stress"


def _translate_health_label(health_class: str, language: str) -> str:
    english = {
        "healthy": "Healthy",
        "mild_stress": "Mild Stress",
        "high_stress": "High Stress",
    }.get(health_class, "Mild Stress")

    if language == "ta":
        return {
            "Healthy": "ஆரோக்கியம்",
            "Mild Stress": "லேசான அழுத்தம்",
            "High Stress": "அதிக அழுத்தம்",
        }.get(english, english)
    if language == "hi":
        return {
            "Healthy": "स्वस्थ",
            "Mild Stress": "हल्का तनाव",
            "High Stress": "उच्च तनाव",
        }.get(english, english)
    return english


def _localized_irrigation_action(language: str, irrigation_class: str) -> str:
    catalog = {
        "en": {
            "skip_rain": "No irrigation now; rain detected. Re-check soil moisture in 2 to 3 hours.",
            "irrigate_deep": "Irrigate immediately with a moderate-to-deep root-zone cycle.",
            "irrigate_short": "Run a short irrigation cycle and reassess moisture after 60 minutes.",
            "maintain": "Moisture is in a healthy range; maintain current irrigation schedule.",
            "pause_overwet": "Pause irrigation; soil is over-wet. Improve drainage and monitor disease risk.",
        },
        "ta": {
            "skip_rain": "இப்போது நீர்ப்பாசனம் வேண்டாம்; மழை கண்டறியப்பட்டது. 2 முதல் 3 மணி நேரத்தில் மண் ஈரப்பதத்தை மீண்டும் சரிபார்க்கவும்.",
            "irrigate_deep": "மிதமான முதல் ஆழமான வேர் பகுதி நீர்ப்பாசன சுழற்சியுடன் உடனே நீர்ப்பாசனம் செய்யவும்.",
            "irrigate_short": "குறுகிய நீர்ப்பாசன சுழற்சியை இயக்கி 60 நிமிடங்களில் மீண்டும் ஈரப்பதத்தை மதிப்பீடு செய்யவும்.",
            "maintain": "ஈரப்பதம் ஆரோக்கியமான அளவில் உள்ளது; தற்போதைய நீர்ப்பாசன அட்டவணையை தொடரவும்.",
            "pause_overwet": "நீர்ப்பாசனத்தை நிறுத்தவும்; மண் அதிக ஈரமாக உள்ளது. வடிகாலத்தை மேம்படுத்தி நோய் அபாயத்தை கண்காணிக்கவும்.",
        },
        "hi": {
            "skip_rain": "अभी सिंचाई न करें; बारिश दर्ज हुई है। 2 से 3 घंटे बाद मिट्टी की नमी फिर जाँचें।",
            "irrigate_deep": "मध्यम से गहरे रूट-ज़ोन चक्र के साथ तुरंत सिंचाई करें।",
            "irrigate_short": "एक छोटा सिंचाई चक्र चलाएँ और 60 मिनट बाद नमी दोबारा जाँचें।",
            "maintain": "नमी स्वस्थ सीमा में है; वर्तमान सिंचाई शेड्यूल बनाए रखें।",
            "pause_overwet": "सिंचाई रोकें; मिट्टी अधिक गीली है। जल निकासी सुधारें और रोग जोखिम की निगरानी करें।",
        },
    }

    language_catalog = catalog.get(language) or catalog["en"]
    return language_catalog.get(irrigation_class, language_catalog["maintain"])


def _resource_tip_by_conditions(moisture: float, rain: int, temp: float, humidity: float) -> str:
    if rain == 1:
        return "Skip irrigation today, monitor runoff, and reopen irrigation only after moisture drops below 35%."
    if moisture > 70:
        return "Prevent waterlogging by improving drainage channels and avoid additional watering cycles."
    if temp >= 35 and humidity <= 40:
        return "Use early-morning irrigation and mulching to reduce heat-driven evapotranspiration loss."
    if moisture < 25:
        return "Prioritize this field in the next irrigation slot with a deeper root-zone wetting cycle."
    return "Maintain current irrigation schedule and continue periodic moisture verification."


def _localized_resource_tip(language: str, moisture: float, rain: int, temp: float, humidity: float) -> str:
    if language == "ta":
        if rain == 1:
            return "இன்று நீர்ப்பாசனம் தவிர்த்து, ஓட்டப்போக்கை கண்காணித்து, ஈரப்பதம் 35% க்குக் குறைந்தபின் மட்டும் நீர்ப்பாசனத்தைத் தொடங்கவும்."
        if moisture > 70:
            return "நீர் தேக்கம் தவிர்க்க வடிகால் வாய்க்கால்களை மேம்படுத்தி, கூடுதல் நீர்ப்பாசன சுற்றுகளை தவிர்க்கவும்."
        if temp >= 35 and humidity <= 40:
            return "வெப்பத்தால் நீராவியாகும் இழப்பை குறைக்க அதிகாலை நீர்ப்பாசனமும் மண் மூடுதலும் பயன்படுத்தவும்."
        if moisture < 25:
            return "அடுத்த நீர்ப்பாசன நேரத்தில் இந்த வயலுக்கு முன்னுரிமை அளித்து ஆழமான வேர் பகுதி ஈரப்படுத்தல் செய்யவும்."
        return "தற்போதைய நீர்ப்பாசன அட்டவணையை பேணி, இடையறாத மண் ஈரப்பத சரிபார்ப்பை தொடரவும்."

    if language == "hi":
        if rain == 1:
            return "आज सिंचाई छोड़ें, रनऑफ की निगरानी करें, और नमी 35% से नीचे आने पर ही सिंचाई फिर शुरू करें।"
        if moisture > 70:
            return "जलभराव रोकने के लिए ड्रेनेज चैनल बेहतर करें और अतिरिक्त सिंचाई चक्रों से बचें।"
        if temp >= 35 and humidity <= 40:
            return "ऊष्मा से होने वाले वाष्पोत्सर्जन नुकसान को घटाने के लिए सुबह जल्दी सिंचाई और मल्चिंग करें।"
        if moisture < 25:
            return "अगले सिंचाई स्लॉट में इस खेत को प्राथमिकता दें और गहरा रूट-ज़ोन वेटिंग चक्र दें।"
        return "वर्तमान सिंचाई शेड्यूल बनाए रखें और समय-समय पर नमी जाँच जारी रखें।"

    return _resource_tip_by_conditions(moisture, rain, temp, humidity)


def _localized_resource_prefix(language: str, avg_moisture: float, avg_temp: float, avg_humidity: float) -> str:
    if language == "ta":
        return f"வரலாற்று சராசரி ஈரப்பதம் {avg_moisture:.1f}%, வெப்பநிலை {avg_temp:.1f}°C, ஈரப்பதம் {avg_humidity:.1f}%. "
    if language == "hi":
        return f"ऐतिहासिक औसत नमी {avg_moisture:.1f}%, तापमान {avg_temp:.1f}°C, आर्द्रता {avg_humidity:.1f}%. "
    return f"Historical avg moisture {avg_moisture:.1f}%, temp {avg_temp:.1f}°C, humidity {avg_humidity:.1f}%. "


def _localized_summary(
    language: str,
    moisture: float,
    temp: float,
    humidity: float,
    rain: int,
    crop_health_status: str,
    irrigation_action: str,
    source_label: str,
) -> str:
    if language == "ta":
        return (
            f"{source_label} பரிந்துரை: ஈரப்பதம் {moisture:.1f}%, வெப்பநிலை {temp:.1f}°C, "
            f"ஈரப்பதம் {humidity:.1f}%, மழை {'ஆம்' if rain == 1 else 'இல்லை'}. "
            f"நிலை: {crop_health_status}. செயல்: {irrigation_action}"
        )
    if language == "hi":
        return (
            f"{source_label} सुझाव: नमी {moisture:.1f}%, तापमान {temp:.1f}°C, "
            f"आर्द्रता {humidity:.1f}%, बारिश {'हाँ' if rain == 1 else 'नहीं'}. "
            f"स्थिति: {crop_health_status}. कार्रवाई: {irrigation_action}"
        )
    return (
        f"{source_label} suggestion: moisture {moisture:.1f}%, temperature {temp:.1f}°C, humidity {humidity:.1f}%, "
        f"rain {'yes' if rain == 1 else 'no'}. Status: {crop_health_status}. Action: {irrigation_action}"
    )


def _safe_average(values: List[float], fallback: float = 0.0) -> float:
    return sum(values) / len(values) if values else fallback


def _build_feature_vector(current: Dict, history: List[Dict]) -> List[float]:
    moisture = float(current.get("soil_moisture", 0.0))
    rain = float(current.get("rain_detected", 0))
    temp = float(current.get("temperature_c", 0.0))
    humidity = float(current.get("humidity", 0.0))

    history_moisture = [float(item.get("soil_moisture", moisture)) for item in history]
    history_temp = [float(item.get("temperature_c", temp)) for item in history]
    history_humidity = [float(item.get("humidity", humidity)) for item in history]

    avg_moisture = _safe_average(history_moisture, moisture)
    avg_temp = _safe_average(history_temp, temp)
    avg_humidity = _safe_average(history_humidity, humidity)

    recent_window = history_moisture[:6] if history_moisture else [moisture]
    recent_avg = _safe_average(recent_window, moisture)

    if history_moisture and ML_AVAILABLE:
        moist_std = float(np.std(history_moisture))
    else:
        moist_std = 0.0

    trend_from_history = moisture - avg_moisture
    short_trend = moisture - recent_avg
    risk_score = _compute_risk_score(moisture, int(rain), temp, humidity)

    return [
        moisture,
        rain,
        temp,
        humidity,
        avg_moisture,
        avg_temp,
        avg_humidity,
        moist_std,
        trend_from_history,
        short_trend,
        float(len(history)),
        risk_score,
    ]


def _generate_synthetic_training_data(samples: int = 12000) -> Tuple[Any, List[str], List[str]]:
    if not ML_AVAILABLE:
        raise RuntimeError("ML dependencies are not available")

    rng = np.random.default_rng(42)
    feature_rows: List[List[float]] = []
    irrigation_labels: List[str] = []
    health_labels: List[str] = []

    for _ in range(samples):
        profile = rng.choice(
            ["normal", "dry", "wet", "heat", "rainy"],
            p=[0.43, 0.2, 0.15, 0.14, 0.08],
        )

        if profile == "dry":
            moisture = float(rng.uniform(8, 34))
            rain = int(rng.choice([0, 1], p=[0.9, 0.1]))
            temp = float(rng.uniform(26, 41))
            humidity = float(rng.uniform(18, 54))
        elif profile == "wet":
            moisture = float(rng.uniform(62, 95))
            rain = int(rng.choice([0, 1], p=[0.55, 0.45]))
            temp = float(rng.uniform(14, 32))
            humidity = float(rng.uniform(56, 96))
        elif profile == "heat":
            moisture = float(rng.uniform(18, 62))
            rain = int(rng.choice([0, 1], p=[0.85, 0.15]))
            temp = float(rng.uniform(33, 44))
            humidity = float(rng.uniform(16, 58))
        elif profile == "rainy":
            moisture = float(rng.uniform(28, 80))
            rain = int(rng.choice([0, 1], p=[0.25, 0.75]))
            temp = float(rng.uniform(16, 34))
            humidity = float(rng.uniform(52, 98))
        else:
            moisture = float(rng.uniform(14, 82))
            rain = int(rng.choice([0, 1], p=[0.7, 0.3]))
            temp = float(rng.uniform(15, 39))
            humidity = float(rng.uniform(26, 88))

        history_len = int(rng.integers(12, 30))
        history = []
        for _ in range(history_len):
            history.append(
                {
                    "soil_moisture": _clamp(moisture + float(rng.normal(0, 7.2)), 5, 98),
                    "rain_detected": int(rng.integers(0, 2) if rng.random() < 0.12 else rain),
                    "temperature_c": _clamp(temp + float(rng.normal(0, 2.2)), 8, 46),
                    "humidity": _clamp(humidity + float(rng.normal(0, 6.2)), 15, 99),
                }
            )

        current = {
            "soil_moisture": moisture,
            "rain_detected": rain,
            "temperature_c": temp,
            "humidity": humidity,
        }

        features = _build_feature_vector(current, history)
        risk_score = _compute_risk_score(moisture, rain, temp, humidity)

        feature_rows.append(features)
        irrigation_labels.append(_rule_irrigation_class(moisture, rain))
        health_labels.append(_rule_health_class(risk_score))

    return np.asarray(feature_rows, dtype=float), irrigation_labels, health_labels


def train_and_save_model(model_path: Path = MODEL_FILE_PATH) -> bool:
    global _LAST_TRAINING_REPORT

    if not ML_AVAILABLE:
        _LAST_TRAINING_REPORT = None
        return False

    x_all, y_irrigation, y_health = _generate_synthetic_training_data()
    indices = np.arange(len(x_all))
    train_idx, valid_idx = train_test_split(
        indices,
        test_size=0.2,
        random_state=42,
        stratify=y_irrigation,
    )

    x_train = x_all[train_idx]
    x_valid = x_all[valid_idx]
    y_train_irrigation = [y_irrigation[index] for index in train_idx]
    y_valid_irrigation = [y_irrigation[index] for index in valid_idx]
    y_train_health = [y_health[index] for index in train_idx]
    y_valid_health = [y_health[index] for index in valid_idx]

    model_candidates = [
        (
            "rf_balanced",
            RandomForestClassifier(
                n_estimators=320,
                max_depth=14,
                min_samples_leaf=2,
                class_weight="balanced_subsample",
                random_state=42,
                n_jobs=-1,
            ),
        ),
        (
            "rf_fast",
            RandomForestClassifier(
                n_estimators=260,
                max_depth=10,
                min_samples_leaf=2,
                class_weight="balanced_subsample",
                random_state=42,
                n_jobs=-1,
            ),
        ),
        (
            "et_balanced",
            ExtraTreesClassifier(
                n_estimators=340,
                max_depth=14,
                min_samples_leaf=1,
                class_weight="balanced",
                random_state=42,
                n_jobs=-1,
            ),
        ),
    ]

    best_score = -1.0
    best_name = ""
    best_irrigation_model = None
    best_health_model = None
    best_metrics: Dict[str, float] = {}

    for candidate_name, candidate_model in model_candidates:
        irrigation_model = clone(candidate_model)
        health_model = clone(candidate_model)

        irrigation_model.fit(x_train, y_train_irrigation)
        health_model.fit(x_train, y_train_health)

        pred_irrigation = irrigation_model.predict(x_valid)
        pred_health = health_model.predict(x_valid)

        irrigation_acc = float(accuracy_score(y_valid_irrigation, pred_irrigation))
        irrigation_f1 = float(f1_score(y_valid_irrigation, pred_irrigation, average="macro"))
        health_acc = float(accuracy_score(y_valid_health, pred_health))
        health_f1 = float(f1_score(y_valid_health, pred_health, average="macro"))

        combined_score = (0.35 * irrigation_f1) + (0.35 * health_f1) + (0.15 * irrigation_acc) + (0.15 * health_acc)

        if combined_score > best_score:
            best_score = combined_score
            best_name = candidate_name
            best_irrigation_model = irrigation_model
            best_health_model = health_model
            best_metrics = {
                "irrigation_accuracy": round(irrigation_acc, 4),
                "irrigation_f1_macro": round(irrigation_f1, 4),
                "health_accuracy": round(health_acc, 4),
                "health_f1_macro": round(health_f1, 4),
                "combined_score": round(float(combined_score), 4),
            }

    if best_irrigation_model is None or best_health_model is None:
        _LAST_TRAINING_REPORT = None
        return False

    best_irrigation_model.fit(x_all, y_irrigation)
    best_health_model.fit(x_all, y_health)

    report = {
        "trained_at": datetime.utcnow().isoformat(),
        "samples": int(len(x_all)),
        "best_model": best_name,
        "validation": best_metrics,
    }
    _LAST_TRAINING_REPORT = report

    model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "irrigation_model": best_irrigation_model,
            "health_model": best_health_model,
            "feature_version": 1,
            "training_report": report,
        },
        model_path,
    )
    return True


def _load_model_artifact() -> Dict[str, Any] | None:
    global _MODEL_ARTIFACT

    if _MODEL_ARTIFACT is not None:
        return _MODEL_ARTIFACT

    if not ML_AVAILABLE:
        return None

    if not MODEL_FILE_PATH.exists():
        auto_train_local = _env_bool("AUTO_TRAIN_LOCAL_MODEL", False)
        if not auto_train_local:
            return None

        trained = train_and_save_model(MODEL_FILE_PATH)
        if not trained:
            return None

    try:
        _MODEL_ARTIFACT = joblib.load(MODEL_FILE_PATH)
        return _MODEL_ARTIFACT
    except Exception:
        return None


def ensure_model_ready() -> bool:
    return _load_model_artifact() is not None


def retrain_model() -> bool:
    global _MODEL_ARTIFACT

    _MODEL_ARTIFACT = None
    trained = train_and_save_model(MODEL_FILE_PATH)
    if not trained:
        return False

    _MODEL_ARTIFACT = None
    return _load_model_artifact() is not None


def retrain_model_with_report() -> Dict[str, Any] | None:
    global _MODEL_ARTIFACT

    _MODEL_ARTIFACT = None
    trained = train_and_save_model(MODEL_FILE_PATH)
    if not trained:
        return None

    _MODEL_ARTIFACT = None
    artifact = _load_model_artifact()
    if artifact is None:
        return None

    report = artifact.get("training_report")
    if isinstance(report, dict):
        return report
    return None


def get_model_quality_snapshot() -> Dict[str, Any]:
    artifact = _load_model_artifact()
    ready = artifact is not None
    report = artifact.get("training_report") if artifact else None

    return {
        "ready": ready,
        "model_path": str(MODEL_FILE_PATH),
        "feature_version": int(artifact.get("feature_version", 1)) if artifact else 1,
        "training_report": report if isinstance(report, dict) else None,
    }


def _predict_classes_with_model(current: Dict, history: List[Dict]) -> Tuple[str, str, float] | None:
    artifact = _load_model_artifact()
    if artifact is None or not ML_AVAILABLE:
        return None

    features = np.asarray([_build_feature_vector(current, history)], dtype=float)
    irrigation_model = artifact["irrigation_model"]
    health_model = artifact["health_model"]

    irrigation_class = str(irrigation_model.predict(features)[0])
    health_class = str(health_model.predict(features)[0])

    irrigation_proba = float(max(irrigation_model.predict_proba(features)[0]))
    health_proba = float(max(health_model.predict_proba(features)[0]))
    validation = artifact.get("training_report", {}).get("validation", {})
    validation_quality = float(validation.get("combined_score", 0.78))
    confidence = _clamp((0.6 * ((irrigation_proba + health_proba) / 2)) + (0.4 * validation_quality), 0.55, 0.99)

    return irrigation_class, health_class, confidence


def generate_recommendation(current: Dict, history: List[Dict], language: str = "en", use_external: bool = True) -> RecommendationResult:
    """ML-backed recommendation with automatic rule fallback.

    When *use_external* is False the external LLM provider (Gemini / OpenAI)
    is skipped entirely and only the local ML model or rule engine is used.
    """
    moisture = float(current.get("soil_moisture", 0.0))
    rain = int(current.get("rain_detected", 0))
    temp = float(current.get("temperature_c", 0.0))
    humidity = float(current.get("humidity", 0.0))
    language = _normalize_language(language)

    avg_moisture = _safe_average([float(x.get("soil_moisture", moisture)) for x in history], moisture)
    avg_temp = _safe_average([float(x.get("temperature_c", temp)) for x in history], temp)
    avg_humidity = _safe_average([float(x.get("humidity", humidity)) for x in history], humidity)

    provider = (os.getenv("AI_PROVIDER", "gemini") or "gemini").strip().lower()
    require_gemini = _env_bool("REQUIRE_GEMINI", True)

    if use_external:
        external = _generate_external_recommendation(current, history, language)
        if external is not None:
            return external

        if provider == "gemini" and require_gemini:
            raise RuntimeError("Gemini suggestion is required but unavailable. Set GEMINI_API_KEY and verify connectivity.")

    model_prediction = _predict_classes_with_model(current, history)

    if model_prediction:
        irrigation_class, health_class, confidence = model_prediction
        source_label = {
            "en": "AI model",
            "ta": "AI மாதிரி",
            "hi": "AI मॉडल",
        }.get(language, "AI model")
    else:
        risk_score = _compute_risk_score(moisture, rain, temp, humidity)
        irrigation_class = _rule_irrigation_class(moisture, rain)
        health_class = _rule_health_class(risk_score)
        confidence = _clamp(0.76 + (0.18 if len(history) >= 12 else 0.08), 0.55, 0.97)
        source_label = {
            "en": "Rule fallback",
            "ta": "விதி மாற்று",
            "hi": "नियम बैकअप",
        }.get(language, "Rule fallback")

    irrigation_action = _localized_irrigation_action(language, irrigation_class)
    crop_health_status = _translate_health_label(health_class, language)

    resource_tip = _localized_resource_tip(language, moisture, rain, temp, humidity)
    resource_optimization_tip = (
        _localized_resource_prefix(language, avg_moisture, avg_temp, avg_humidity)
        + resource_tip
    )

    summary = _localized_summary(
        language,
        moisture,
        temp,
        humidity,
        rain,
        crop_health_status,
        irrigation_action,
        source_label,
    )

    return RecommendationResult(
        irrigation_action=irrigation_action,
        crop_health_status=crop_health_status,
        resource_optimization_tip=resource_optimization_tip,
        confidence_score=round(confidence, 2),
        generated_summary=summary,
    )
