#pragma once
#include "Arduino.h"
typedef struct {
  float x, y, z;
} sensors_vec_t;
typedef struct {
  float temperature, pressure, altitude, humidity;
} sensors_baro_t;
typedef struct {
  float lux;
} sensors_light_t;
typedef struct {
  int32_t version;
  uint8_t sensor_id;
  uint8_t type;
  float max_value, min_value, resolution;
  int32_t min_delay;
} sensor_t;
typedef struct {
  int32_t version;
  uint8_t sensor_id;
  uint8_t type;
  float data[4];
  sensors_vec_t acceleration;
  sensors_vec_t magnetic;
  sensors_vec_t gyro;
  sensors_vec_t orientation;
  sensors_baro_t pressure;
  sensors_light_t light;
  float distance;
  uint32_t timestamp;
} sensors_event_t;
class Adafruit_Sensor {
 public:
  virtual ~Adafruit_Sensor() {}
  virtual bool getEvent(sensors_event_t* event) { (void)event; return true; }
  virtual void getSensor(sensor_t* sensor) { (void)sensor; }
  void enableAutoRange(bool enable) { (void)enable; }
};
