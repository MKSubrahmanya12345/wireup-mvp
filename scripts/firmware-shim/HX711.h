#pragma once
#include "Arduino.h"

// Host-compile / behavioural stub for the bogde/HX711 load-cell amplifier
// library. Same declarations, no hardware behind it.
class HX711 {
 public:
  void begin(int pinDout, int pinSck) { (void)pinDout; (void)pinSck; }
  void setScale(float scale) { (void)scale; }
  void tare() {}
  float getScale() { return 1.0f; }
  bool isReady() { return true; }
  bool waitReadyTimeout(int timeoutMs) { (void)timeoutMs; return true; }
  bool waitReadyRetry(int retries, int delayMs) { (void)retries; (void)delayMs; return true; }
  long read() { return 0; }
  long readAverage(int times) { (void)times; return 0; }
  double getUnits(int times) { (void)times; return 0.0; }
  void powerDown() {}
  void powerUp() {}
  int getGain() { return 128; }
  void setGain(int gain) { (void)gain; }
};
