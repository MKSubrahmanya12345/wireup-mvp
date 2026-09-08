#pragma once
#include "Arduino.h"

/* Instrumented servo: every write is recorded so the evaluator can assert on
   lock/unlock angles. */
class Servo {
 public:
  uint8_t attach(int pin) { _pin = pin; return 0; }
  uint8_t attach(int pin, int min, int max) { (void)min; (void)max; _pin = pin; return 0; }
  void detach() { _pin = -1; }
  void write(int angle) {
    _angle = angle;
    if (_pin >= 0) wireup::servoWrote(_pin, angle);
  }
  void writeMicroseconds(int us) { (void)us; }
  int read() { return _angle; }
  bool attached() { return _pin >= 0; }
 private:
  int _pin = -1;
  int _angle = 0;
};
