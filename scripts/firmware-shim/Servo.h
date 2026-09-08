#pragma once
#include "Arduino.h"
class Servo {
 public:
  uint8_t attach(int pin) { (void)pin; return 0; }
  uint8_t attach(int pin, int min, int max) { (void)pin; (void)min; (void)max; return 0; }
  void detach() {}
  void write(int angle) { (void)angle; }
  void writeMicroseconds(int us) { (void)us; }
  int read() { return 0; }
  bool attached() { return false; }
};
