#pragma once
#include "Arduino.h"
class Stepper {
 public:
  Stepper(int steps, int pin1, int pin2) { (void)steps; (void)pin1; (void)pin2; }
  Stepper(int steps, int pin1, int pin2, int pin3, int pin4) { (void)steps; (void)pin1; (void)pin2; (void)pin3; (void)pin4; }
  void setSpeed(long rpm) { (void)rpm; }
  void step(int steps) { (void)steps; }
};
