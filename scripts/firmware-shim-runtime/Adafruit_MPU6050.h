#pragma once
#include "Adafruit_Sensor.h"
#include "Wire.h"
class Adafruit_MPU6050 : public Adafruit_Sensor {
 public:
  bool begin(uint8_t address = 0x68, uint8_t sensorId = 0x68, bool wireBegin = true) {
    (void)address; (void)sensorId; (void)wireBegin; return true;
  }
  bool getEvent(sensors_event_t* event) override { (void)event; return true; }
  void getSensor(sensor_t* sensor) override { (void)sensor; }
  void setAccelerometerRange(int range) { (void)range; }
  void setGyroRange(int range) { (void)range; }
  void setFilterBandwidth(int bandwidth) { (void)bandwidth; }
  int8_t getTemperature() { return 25; }
};
#define MPU6050_RANGE_2_G 0
#define MPU6050_RANGE_16_G 3
#define MPU6050_GYRO_RANGE_250_DEG 0
#define MPU6050_BAND_21_HZ 0
