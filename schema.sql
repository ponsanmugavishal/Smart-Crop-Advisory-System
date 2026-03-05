CREATE DATABASE IF NOT EXISTS smart_farm;
USE smart_farm;

CREATE TABLE IF NOT EXISTS farmer (
    farmer_id INT AUTO_INCREMENT PRIMARY KEY,
    farmer_name VARCHAR(120) NOT NULL,
    email VARCHAR(150) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS field (
    field_id INT AUTO_INCREMENT PRIMARY KEY,
    farmer_id INT NOT NULL,
    field_name VARCHAR(120) NOT NULL,
    location_label VARCHAR(200),
    area_acres DECIMAL(8,2) DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_field_farmer FOREIGN KEY (farmer_id)
        REFERENCES farmer(farmer_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    INDEX idx_field_farmer (farmer_id),
    INDEX idx_field_active (is_active)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sensor_type (
    sensor_type_id INT AUTO_INCREMENT PRIMARY KEY,
    sensor_code VARCHAR(50) NOT NULL UNIQUE,
    sensor_name VARCHAR(120) NOT NULL,
    unit VARCHAR(40)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS field_sensor (
    field_sensor_id INT AUTO_INCREMENT PRIMARY KEY,
    field_id INT NOT NULL,
    sensor_type_id INT NOT NULL,
    device_uid VARCHAR(100),
    installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active TINYINT(1) DEFAULT 1,
    CONSTRAINT fk_field_sensor_field FOREIGN KEY (field_id)
        REFERENCES field(field_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_field_sensor_type FOREIGN KEY (sensor_type_id)
        REFERENCES sensor_type(sensor_type_id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,
    UNIQUE KEY uq_field_sensor (field_id, sensor_type_id),
    INDEX idx_field_sensor_field (field_id),
    INDEX idx_field_sensor_active (is_active)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sensor_reading (
    reading_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    field_id INT NOT NULL,
    moisture_percent DECIMAL(5,2) NOT NULL,
    rain_detected TINYINT(1) NOT NULL,
    temperature_c DECIMAL(5,2) NOT NULL,
    humidity_percent DECIMAL(5,2) NOT NULL,
    source_type ENUM('scheduled', 'realtime') NOT NULL DEFAULT 'scheduled',
    recorded_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reading_field FOREIGN KEY (field_id)
        REFERENCES field(field_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    INDEX idx_reading_field_time (field_id, recorded_at),
    INDEX idx_reading_time (recorded_at),
    INDEX idx_reading_source (source_type)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recommendation (
    recommendation_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    field_id INT NOT NULL,
    reading_id BIGINT,
    irrigation_action TEXT NOT NULL,
    crop_health_status VARCHAR(60) NOT NULL,
    resource_optimization_tip TEXT NOT NULL,
    confidence_score DECIMAL(4,2) NOT NULL,
    generated_summary TEXT NOT NULL,
    generated_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_recommend_field FOREIGN KEY (field_id)
        REFERENCES field(field_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_recommend_reading FOREIGN KEY (reading_id)
        REFERENCES sensor_reading(reading_id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,
    INDEX idx_recommend_field_time (field_id, generated_at)
) ENGINE=InnoDB;

-- Seed baseline metadata
INSERT INTO farmer (farmer_name, email)
SELECT 'Default Farmer', 'farmer@example.com'
WHERE NOT EXISTS (SELECT 1 FROM farmer);

INSERT INTO field (farmer_id, field_name, location_label, area_acres)
SELECT 1, 'Field A', 'North Plot', 2.50
WHERE NOT EXISTS (SELECT 1 FROM field WHERE field_name = 'Field A');

INSERT INTO field (farmer_id, field_name, location_label, area_acres)
SELECT 1, 'Field B', 'South Plot', 1.75
WHERE NOT EXISTS (SELECT 1 FROM field WHERE field_name = 'Field B');

INSERT INTO sensor_type (sensor_code, sensor_name, unit)
SELECT 'SOIL_MOISTURE', 'Capacitive Soil Moisture Sensor', '%'
WHERE NOT EXISTS (SELECT 1 FROM sensor_type WHERE sensor_code = 'SOIL_MOISTURE');

INSERT INTO sensor_type (sensor_code, sensor_name, unit)
SELECT 'RAIN', 'Rain Sensor', 'binary'
WHERE NOT EXISTS (SELECT 1 FROM sensor_type WHERE sensor_code = 'RAIN');

INSERT INTO sensor_type (sensor_code, sensor_name, unit)
SELECT 'DHT22_TEMP', 'DHT22 Temperature', '°C'
WHERE NOT EXISTS (SELECT 1 FROM sensor_type WHERE sensor_code = 'DHT22_TEMP');

INSERT INTO sensor_type (sensor_code, sensor_name, unit)
SELECT 'DHT22_HUM', 'DHT22 Humidity', '%'
WHERE NOT EXISTS (SELECT 1 FROM sensor_type WHERE sensor_code = 'DHT22_HUM');
