#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <time.h>

// -------------------- USER CONFIG --------------------
const char* WIFI_SSID = "VISHAL";
const char* WIFI_PASSWORD = "vishal@2007";
const char* API_BASE_URL = "http://192.168.1.10:5000"; // Flask API base URL
int FIELD_ID = 1; // change per node/field

// Timezone config (example: IST = UTC+5:30)
const long GMT_OFFSET_SEC = 19800;

#define DHT_TYPE DHT22

DHT dht(DHT_PIN, DHT_TYPE);

int lastTriggeredHour = -1;
unsigned long lastCommandPollMs = 0;
const unsigned long commandPollIntervalMs = 5000;

void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");
}

void syncTime() {
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, "pool.ntp.org", "time.nist.gov");
  struct tm timeinfo;
  while (!getLocalTime(&timeinfo)) {
    Serial.println("Waiting for NTP time sync...");
    delay(1000);
  }
  Serial.println("Time synchronized");
}

bool isScheduledHour(int hour) {
  for (int i = 0; i < scheduledCount; i++) {
    if (hour == scheduledHours[i]) return true;
  }
  return false;
}

float readSoilMoisturePercent() {
  int raw = analogRead(SOIL_PIN);
  // Calibrate raw dry/wet values to your sensor and soil type
  int dryValue = 3200;
  int wetValue = 1300;

  float pct = (float)(dryValue - raw) * 100.0 / (dryValue - wetValue);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

int readRainDetected() {
  int raw = analogRead(RAIN_PIN);
  int threshold = 2000; // adjust based on your rain board
  return (raw < threshold) ? 1 : 0;
}

void sendReading(const char* sourceType) {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  float moisture = readSoilMoisturePercent();
  int rain = readRainDetected();
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
    Serial.println("DHT read failed");
    return;
  }

  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    Serial.println("Failed to obtain time");
    return;
  }

  char isoTime[25];
  strftime(isoTime, sizeof(isoTime), "%Y-%m-%dT%H:%M:%S", &timeinfo);

  StaticJsonDocument<256> doc;
  doc["field_id"] = FIELD_ID;
  doc["soil_moisture"] = moisture;
  doc["rain_detected"] = rain;
  doc["temperature_c"] = temp;
  doc["humidity"] = hum;
  doc["source_type"] = sourceType;
  doc["recorded_at"] = isoTime;

  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  String ingestUrl = String(API_BASE_URL) + "/api/ingest";
  http.begin(ingestUrl);
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.POST(payload);
  String response = http.getString();

  Serial.printf("POST %s | code=%d | %s\n", sourceType, httpCode, response.c_str());
  http.end();
}

void checkAndExecuteManualCommand() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  HTTPClient http;
  String commandUrl = String(API_BASE_URL) + "/api/device/next-command?field_id=" + String(FIELD_ID);
  http.begin(commandUrl);

  int httpCode = http.GET();
  String response = http.getString();

  if (httpCode == 200) {
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, response);
    if (!err) {
      const char* cmd = doc["command"] | "";
      if (String(cmd).equalsIgnoreCase("now")) {
        Serial.println("Manual command received from server -> sending realtime reading");
        sendReading("realtime");
      }
    } else {
      Serial.printf("Command parse error: %s\n", err.c_str());
    }
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  dht.begin();
  connectWiFi();
  syncTime();

  analogReadResolution(12);
  pinMode(SOIL_PIN, INPUT);
  pinMode(RAIN_PIN, INPUT);

  Serial.println("Smart farm node ready.");
  Serial.println("Send 'now' in Serial Monitor for real-time reading push.");
  Serial.println("Waiting for dashboard manual-check commands from server...");
}

void loop() {
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    int hour = timeinfo.tm_hour;
    int minute = timeinfo.tm_min;

    if (isScheduledHour(hour) && minute == 0 && lastTriggeredHour != hour) {
      sendReading("scheduled");
      lastTriggeredHour = hour;
    }

    if (!isScheduledHour(hour)) {
      lastTriggeredHour = -1;
    }
  }

  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.equalsIgnoreCase("now")) {
      sendReading("realtime");
    }
  }

  if (millis() - lastCommandPollMs >= commandPollIntervalMs) {
    checkAndExecuteManualCommand();
    lastCommandPollMs = millis();
  }

  delay(1000);
}
