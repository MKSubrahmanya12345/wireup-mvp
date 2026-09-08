#pragma once
#include "Arduino.h"
#define DHT11 11
#define DHT22 22
#define DHT21 21
#define NAN (0.0f / 0.0f)
class DHT {
 public:
  DHT(uint8_t pin, uint8_t type, uint8_t count = 6) { (void)pin; (void)type; (void)count; }
  void begin(uint8_t usec = 55) { (void)usec; }
  float readTemperature(bool force = false) { (void)force; return 21.5f; }
  float readHumidity(bool force = false) { (void)force; return 45.0f; }
  float read(bool force = false) { (void)force; return 21.5f; }
  float convertCtoF(float c) { return c * 1.8f + 32.0f; }
  float computeHeatIndex(float temperature, float percentHumidity, bool isFahrenheit = false) {
    (void)temperature; (void)percentHumidity; (void)isFahrenheit; return 0.0f;
  }
};
