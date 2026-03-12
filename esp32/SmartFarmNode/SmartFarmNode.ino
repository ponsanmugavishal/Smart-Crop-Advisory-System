#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <time.h>
#include <SPI.h>
#include <SD.h>
#include <sqlite3.h>

const char* WIFI_SSID = "vishal";
const char* WIFI_PASSWORD = "12345678";
const char* API_BASE_URL = "http://10.229.158.87:5000";
int FIELD_ID = 1;

const long GMT_OFFSET_SEC = 19800;
const int DAYLIGHT_OFFSET_SEC = 0;

#define SOIL_PIN 34
#define RAIN_PIN 35
#define DHT_PIN 4
#define DHT_TYPE DHT22

// ESP32 VSPI default pins for SD reader
#define SD_CS_PIN 5
#define SD_SCK_PIN 18
#define SD_MISO_PIN 19
#define SD_MOSI_PIN 23

const char* SQLITE_QUEUE_DB_PATH = "/sd/hourly_queue.db";

const unsigned long commandPollIntervalMs = 2000;
const unsigned long sensorSampleIntervalMs = 2000;

DHT dht(DHT_PIN, DHT_TYPE);

unsigned long lastCommandPollMs = 0;
unsigned long lastSensorSampleMs = 0;
bool sdReady = false;
sqlite3* queueDb = nullptr;

struct HourBucket {
  bool initialized;
  int year;
  int month;
  int day;
  int hour;
  float moistureSum;
  float tempSum;
  float humSum;
  int rainCount;
  int sampleCount;
};

HourBucket currentBucket = {false, 0, 0, 0, 0, 0, 0, 0, 0, 0};

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting WiFi");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected");
  } else {
    Serial.println("\nWiFi unavailable");
  }
}

void syncTime() {
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, "pool.ntp.org", "time.nist.gov");
  struct tm timeinfo;
  int attempts = 0;

  while (!getLocalTime(&timeinfo) && attempts < 30) {
    Serial.println("Waiting for NTP time sync...");
    delay(1000);
    attempts++;
  }

  if (attempts < 30) {
    Serial.println("Time synchronized");
  } else {
    Serial.println("NTP sync skipped for now");
  }
}

bool executeSQL(sqlite3* db, const char* sql) {
  char* errMsg = nullptr;
  int rc = sqlite3_exec(db, sql, nullptr, nullptr, &errMsg);
  if (rc != SQLITE_OK) {
    Serial.printf("SQLite error: %s\n", errMsg ? errMsg : "unknown");
    sqlite3_free(errMsg);
    return false;
  }
  return true;
}

bool openQueueDatabase() {
  if (!sdReady) return false;
  if (queueDb) return true;

  int rc = sqlite3_open(SQLITE_QUEUE_DB_PATH, &queueDb);
  if (rc != SQLITE_OK) {
    Serial.printf("Unable to open SQLite queue DB (%s): %s\n", SQLITE_QUEUE_DB_PATH, sqlite3_errmsg(queueDb));
    if (queueDb) {
      sqlite3_close(queueDb);
      queueDb = nullptr;
    }
    return false;
  }

  sqlite3_busy_timeout(queueDb, 2000);

  const char* createHourlySql =
    "CREATE TABLE IF NOT EXISTS hourly_records ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "recorded_at TEXT NOT NULL,"
    "soil_moisture REAL NOT NULL,"
    "temperature_c REAL NOT NULL,"
    "humidity REAL NOT NULL,"
    "rain_detected INTEGER NOT NULL,"
    "uploaded INTEGER NOT NULL DEFAULT 0,"
    "created_at TEXT DEFAULT CURRENT_TIMESTAMP"
    ");";

  const char* createDailyAvgSql =
    "CREATE TABLE IF NOT EXISTS daily_averages ("
    "summary_date TEXT PRIMARY KEY,"
    "avg_moisture REAL NOT NULL,"
    "avg_temperature REAL NOT NULL,"
    "avg_humidity REAL NOT NULL,"
    "rainy_hours INTEGER NOT NULL,"
    "total_hours INTEGER NOT NULL,"
    "created_at TEXT DEFAULT CURRENT_TIMESTAMP"
    ");";

  if (!executeSQL(queueDb, createHourlySql) || !executeSQL(queueDb, createDailyAvgSql)) {
    sqlite3_close(queueDb);
    queueDb = nullptr;
    return false;
  }

  return true;
}

void initSDCard() {
  SPI.begin(SD_SCK_PIN, SD_MISO_PIN, SD_MOSI_PIN, SD_CS_PIN);
  if (!SD.begin(SD_CS_PIN)) {
    sdReady = false;
    Serial.println("SD card init failed. Offline persistence disabled.");
    return;
  }

  sdReady = true;
  Serial.println("SD card initialized.");

  if (openQueueDatabase()) {
    Serial.printf("SQLite queue ready at %s\n", SQLITE_QUEUE_DB_PATH);
  } else {
    Serial.println("SQLite queue unavailable. Offline persistence disabled.");
  }
}

long long insertHourlyRecord(const char* recordedAtIso, float moisture, float temp, float hum, int rainDetected) {
  if (!openQueueDatabase()) return -1;

  const char* insertSql =
    "INSERT INTO hourly_records (recorded_at, soil_moisture, temperature_c, humidity, rain_detected, uploaded) "
    "VALUES (?, ?, ?, ?, ?, 0);";

  sqlite3_stmt* stmt = nullptr;
  int rc = sqlite3_prepare_v2(queueDb, insertSql, -1, &stmt, nullptr);
  if (rc != SQLITE_OK || !stmt) {
    Serial.printf("SQLite prepare failed: %s\n", sqlite3_errmsg(queueDb));
    if (stmt) sqlite3_finalize(stmt);
    return -1;
  }

  sqlite3_bind_text(stmt, 1, recordedAtIso, -1, SQLITE_TRANSIENT);
  sqlite3_bind_double(stmt, 2, moisture);
  sqlite3_bind_double(stmt, 3, temp);
  sqlite3_bind_double(stmt, 4, hum);
  sqlite3_bind_int(stmt, 5, rainDetected);

  rc = sqlite3_step(stmt);
  if (rc != SQLITE_DONE) {
    Serial.printf("SQLite insert failed: %s\n", sqlite3_errmsg(queueDb));
    sqlite3_finalize(stmt);
    return -1;
  }

  sqlite3_finalize(stmt);
  long long rowId = sqlite3_last_insert_rowid(queueDb);
  Serial.printf("Saved hourly record in SQLite: %s (id=%lld)\n", recordedAtIso, rowId);
  return rowId;
}

void markRecordUploaded(long long rowId) {
  if (!openQueueDatabase() || rowId <= 0) return;

  const char* updateSql = "UPDATE hourly_records SET uploaded = 1 WHERE id = ?;";
  sqlite3_stmt* stmt = nullptr;
  int rc = sqlite3_prepare_v2(queueDb, updateSql, -1, &stmt, nullptr);
  if (rc != SQLITE_OK || !stmt) {
    if (stmt) sqlite3_finalize(stmt);
    return;
  }

  sqlite3_bind_int64(stmt, 1, rowId);
  rc = sqlite3_step(stmt);
  if (rc != SQLITE_DONE) {
    Serial.printf("SQLite upload-flag update failed for id=%lld: %s\n", rowId, sqlite3_errmsg(queueDb));
  }
  sqlite3_finalize(stmt);
}

void computeAndStoreDailyAverage(int year, int month, int day) {
  if (!openQueueDatabase()) return;

  char dateKey[11];
  snprintf(dateKey, sizeof(dateKey), "%04d-%02d-%02d", year, month, day);

  const char* querySql =
    "SELECT AVG(soil_moisture), AVG(temperature_c), AVG(humidity), SUM(rain_detected), COUNT(*) "
    "FROM hourly_records WHERE substr(recorded_at, 1, 10) = ?;";

  sqlite3_stmt* queryStmt = nullptr;
  int rc = sqlite3_prepare_v2(queueDb, querySql, -1, &queryStmt, nullptr);
  if (rc != SQLITE_OK || !queryStmt) {
    Serial.printf("SQLite daily avg query prepare failed: %s\n", sqlite3_errmsg(queueDb));
    if (queryStmt) sqlite3_finalize(queryStmt);
    return;
  }

  sqlite3_bind_text(queryStmt, 1, dateKey, -1, SQLITE_TRANSIENT);
  rc = sqlite3_step(queryStmt);
  if (rc != SQLITE_ROW) {
    sqlite3_finalize(queryStmt);
    return;
  }

  int totalHours = sqlite3_column_int(queryStmt, 4);
  if (totalHours <= 0) {
    sqlite3_finalize(queryStmt);
    return;
  }

  float avgMoisture = (float)sqlite3_column_double(queryStmt, 0);
  float avgTemp = (float)sqlite3_column_double(queryStmt, 1);
  float avgHum = (float)sqlite3_column_double(queryStmt, 2);
  int rainyHours = sqlite3_column_int(queryStmt, 3);
  sqlite3_finalize(queryStmt);

  const char* upsertSql =
    "INSERT INTO daily_averages (summary_date, avg_moisture, avg_temperature, avg_humidity, rainy_hours, total_hours) "
    "VALUES (?, ?, ?, ?, ?, ?) "
    "ON CONFLICT(summary_date) DO UPDATE SET "
    "avg_moisture=excluded.avg_moisture, "
    "avg_temperature=excluded.avg_temperature, "
    "avg_humidity=excluded.avg_humidity, "
    "rainy_hours=excluded.rainy_hours, "
    "total_hours=excluded.total_hours, "
    "created_at=CURRENT_TIMESTAMP;";

  sqlite3_stmt* upsertStmt = nullptr;
  rc = sqlite3_prepare_v2(queueDb, upsertSql, -1, &upsertStmt, nullptr);
  if (rc != SQLITE_OK || !upsertStmt) {
    Serial.printf("SQLite daily avg upsert prepare failed: %s\n", sqlite3_errmsg(queueDb));
    if (upsertStmt) sqlite3_finalize(upsertStmt);
    return;
  }

  sqlite3_bind_text(upsertStmt, 1, dateKey, -1, SQLITE_TRANSIENT);
  sqlite3_bind_double(upsertStmt, 2, avgMoisture);
  sqlite3_bind_double(upsertStmt, 3, avgTemp);
  sqlite3_bind_double(upsertStmt, 4, avgHum);
  sqlite3_bind_int(upsertStmt, 5, rainyHours);
  sqlite3_bind_int(upsertStmt, 6, totalHours);

  rc = sqlite3_step(upsertStmt);
  if (rc == SQLITE_DONE) {
    Serial.printf(
      "Daily average %s | M=%.2f T=%.2f H=%.2f RainyHours=%d TotalHours=%d\n",
      dateKey,
      avgMoisture,
      avgTemp,
      avgHum,
      rainyHours,
      totalHours
    );
  } else {
    Serial.printf("SQLite daily avg upsert failed: %s\n", sqlite3_errmsg(queueDb));
  }

  sqlite3_finalize(upsertStmt);
}

float readSoilMoisturePercent() {
  int raw = analogRead(SOIL_PIN);
  const int dryValue = 3200;
  const int wetValue = 1300;

  float pct = (float)(dryValue - raw) * 100.0f / (dryValue - wetValue);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

int readRainDetected() {
  int raw = analogRead(RAIN_PIN);
  const int threshold = 2000;
  return (raw < threshold) ? 1 : 0;
}

bool postReadingPayload(float moisture, int rain, float temp, float hum, const char* sourceType, const char* recordedAtIso) {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (WiFi.status() != WL_CONNECTED) return false;

  StaticJsonDocument<256> doc;
  doc["field_id"] = FIELD_ID;
  doc["soil_moisture"] = moisture;
  doc["rain_detected"] = rain;
  doc["temperature_c"] = temp;
  doc["humidity"] = hum;
  doc["source_type"] = sourceType;
  doc["recorded_at"] = recordedAtIso;

  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  String ingestUrl = String(API_BASE_URL) + "/api/ingest";
  http.begin(ingestUrl);
  http.addHeader("Content-Type", "application/json");

  int httpCode = http.POST(payload);
  String response = http.getString();
  http.end();

  if (httpCode >= 200 && httpCode < 300) {
    Serial.printf("Uploaded %s reading | %s\n", sourceType, response.c_str());
    return true;
  }

  Serial.printf("Upload failed | code=%d | %s\n", httpCode, response.c_str());
  return false;
}

bool sendRealtimeReading() {
  float moisture = readSoilMoisturePercent();
  int rain = readRainDetected();
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
    Serial.println("DHT read failed for realtime reading");
    return false;
  }

  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    Serial.println("Time unavailable for realtime reading");
    return false;
  }

  char isoTime[25];
  strftime(isoTime, sizeof(isoTime), "%Y-%m-%dT%H:%M:%S", &timeinfo);
  return postReadingPayload(moisture, rain, temp, hum, "realtime", isoTime);
}

void flushOfflineQueueFromSD() {
  if (!openQueueDatabase()) return;

  const char* selectSql =
    "SELECT id, recorded_at, soil_moisture, temperature_c, humidity, rain_detected "
    "FROM hourly_records WHERE uploaded = 0 ORDER BY id ASC LIMIT 60;";

  sqlite3_stmt* selectStmt = nullptr;
  int rc = sqlite3_prepare_v2(queueDb, selectSql, -1, &selectStmt, nullptr);
  if (rc != SQLITE_OK || !selectStmt) {
    Serial.printf("SQLite select prepare failed: %s\n", sqlite3_errmsg(queueDb));
    if (selectStmt) sqlite3_finalize(selectStmt);
    return;
  }

  while ((rc = sqlite3_step(selectStmt)) == SQLITE_ROW) {
    long long rowId = sqlite3_column_int64(selectStmt, 0);
    const unsigned char* isoRaw = sqlite3_column_text(selectStmt, 1);
    float moisture = (float)sqlite3_column_double(selectStmt, 2);
    float temp = (float)sqlite3_column_double(selectStmt, 3);
    float hum = (float)sqlite3_column_double(selectStmt, 4);
    int rain = sqlite3_column_int(selectStmt, 5);

    if (!isoRaw) continue;
    const char* iso = (const char*)isoRaw;

    bool sent = postReadingPayload(moisture, rain, temp, hum, "hourly", iso);
    if (!sent) {
      // Stop early to preserve queue order when network remains unavailable.
      break;
    }

    markRecordUploaded(rowId);
  }

  sqlite3_finalize(selectStmt);
}

void finalizeCurrentHour(int nextYear, int nextMonth, int nextDay, int nextHour) {
  if (!currentBucket.initialized || currentBucket.sampleCount <= 0) {
    currentBucket.initialized = true;
    currentBucket.year = nextYear;
    currentBucket.month = nextMonth;
    currentBucket.day = nextDay;
    currentBucket.hour = nextHour;
    currentBucket.moistureSum = 0;
    currentBucket.tempSum = 0;
    currentBucket.humSum = 0;
    currentBucket.rainCount = 0;
    currentBucket.sampleCount = 0;
    return;
  }

  float avgMoisture = currentBucket.moistureSum / currentBucket.sampleCount;
  float avgTemp = currentBucket.tempSum / currentBucket.sampleCount;
  float avgHum = currentBucket.humSum / currentBucket.sampleCount;
  int rainDetected = currentBucket.rainCount > 0 ? 1 : 0;

  char hourIso[25];
  snprintf(
    hourIso,
    sizeof(hourIso),
    "%04d-%02d-%02dT%02d:00:00",
    currentBucket.year,
    currentBucket.month,
    currentBucket.day,
    currentBucket.hour
  );

  long long rowId = insertHourlyRecord(hourIso, avgMoisture, avgTemp, avgHum, rainDetected);
  bool sent = postReadingPayload(avgMoisture, rainDetected, avgTemp, avgHum, "hourly", hourIso);
  if (sent && rowId > 0) {
    markRecordUploaded(rowId);
  }

  bool dayChanged =
    nextYear != currentBucket.year ||
    nextMonth != currentBucket.month ||
    nextDay != currentBucket.day;

  if (dayChanged) {
    computeAndStoreDailyAverage(currentBucket.year, currentBucket.month, currentBucket.day);
  }

  currentBucket.initialized = true;
  currentBucket.year = nextYear;
  currentBucket.month = nextMonth;
  currentBucket.day = nextDay;
  currentBucket.hour = nextHour;
  currentBucket.moistureSum = 0;
  currentBucket.tempSum = 0;
  currentBucket.humSum = 0;
  currentBucket.rainCount = 0;
  currentBucket.sampleCount = 0;
}

void sampleAndAggregateSensors() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    Serial.println("Skipping sample, time unavailable");
    return;
  }

  float moisture = readSoilMoisturePercent();
  int rain = readRainDetected();
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
    Serial.println("DHT read failed for hourly aggregation");
    return;
  }

  char realtimeIso[25];
  strftime(realtimeIso, sizeof(realtimeIso), "%Y-%m-%dT%H:%M:%S", &timeinfo);
  postReadingPayload(moisture, rain, temp, hum, "realtime", realtimeIso);

  if (!currentBucket.initialized) {
    currentBucket.initialized = true;
    currentBucket.year = timeinfo.tm_year + 1900;
    currentBucket.month = timeinfo.tm_mon + 1;
    currentBucket.day = timeinfo.tm_mday;
    currentBucket.hour = timeinfo.tm_hour;
  }

  int sampleYear = timeinfo.tm_year + 1900;
  int sampleMonth = timeinfo.tm_mon + 1;
  int sampleDay = timeinfo.tm_mday;
  int sampleHour = timeinfo.tm_hour;

  bool hourChanged =
    sampleYear != currentBucket.year ||
    sampleMonth != currentBucket.month ||
    sampleDay != currentBucket.day ||
    sampleHour != currentBucket.hour;

  if (hourChanged) {
    finalizeCurrentHour(sampleYear, sampleMonth, sampleDay, sampleHour);
  }

  currentBucket.moistureSum += moisture;
  currentBucket.tempSum += temp;
  currentBucket.humSum += hum;
  currentBucket.rainCount += rain > 0 ? 1 : 0;
  currentBucket.sampleCount += 1;

  Serial.printf(
    "Hourly sample %04d-%02d-%02d %02d:%02d | M=%.1f T=%.1f H=%.1f R=%d (samples=%d)\n",
    sampleYear,
    sampleMonth,
    sampleDay,
    sampleHour,
    timeinfo.tm_min,
    moisture,
    temp,
    hum,
    rain,
    currentBucket.sampleCount
  );
}

void checkAndExecuteManualCommand() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String commandUrl = String(API_BASE_URL) + "/api/device/next-command?field_id=" + String(FIELD_ID);
  http.begin(commandUrl);

  int httpCode = http.GET();
  String response = http.getString();
  http.end();

  if (httpCode != 200) return;

  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, response);
  if (err) {
    Serial.printf("Command parse error: %s\n", err.c_str());
    return;
  }

  const char* cmd = doc["command"] | "";
  if (String(cmd).equalsIgnoreCase("now")) {
    Serial.println("Manual command received -> sending realtime reading");
    sendRealtimeReading();
  }
}

void setup() {
  Serial.begin(115200);
  dht.begin();

  analogReadResolution(12);
  pinMode(SOIL_PIN, INPUT);
  pinMode(RAIN_PIN, INPUT);

  connectWiFi();
  syncTime();
  initSDCard();

  Serial.println("Smart farm node ready.");
  Serial.println("Realtime auto upload enabled (every 15 seconds).");
  Serial.println("Hourly aggregation enabled.");
  Serial.println("Offline hourly records persisted in SQLite on SD card.");
  Serial.println("Send 'now' in Serial Monitor for realtime manual push.");
}

void loop() {
  if (millis() - lastSensorSampleMs >= sensorSampleIntervalMs) {
    sampleAndAggregateSensors();
    lastSensorSampleMs = millis();
  }

  if (millis() - lastCommandPollMs >= commandPollIntervalMs) {
    checkAndExecuteManualCommand();
    flushOfflineQueueFromSD();
    lastCommandPollMs = millis();
  }

  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.equalsIgnoreCase("now")) {
      sendRealtimeReading();
    }
  }

  delay(200);
}
