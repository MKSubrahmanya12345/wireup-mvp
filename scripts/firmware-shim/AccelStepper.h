#pragma once
#include "Arduino.h"
#define FULL2WIRE 2
#define FULL3WIRE 3
#define FULL4WIRE 4
#define HALF3WIRE 6
#define HALF4WIRE 8
#define DRIVER 1
class AccelStepper {
 public:
  AccelStepper(uint8_t interface = 4, uint8_t pin1 = 2, uint8_t pin2 = 3, uint8_t pin3 = 4, uint8_t pin4 = 5, bool enable = true) {
    (void)interface; (void)pin1; (void)pin2; (void)pin3; (void)pin4; (void)enable;
  }
  void setMaxSpeed(float speed) { (void)speed; }
  void setSpeed(float speed) { (void)speed; }
  void setAcceleration(float acceleration) { (void)acceleration; }
  void moveTo(long absolute) { (void)absolute; }
  void move(long relative) { (void)relative; }
  void run() {}
  void runSpeed() {}
  bool runToNewPosition(long position) { (void)position; return true; }
  void stop() {}
  long currentPosition() { return 0; }
  long distanceToGo() { return 0; }
  void setCurrentPosition(long position) { (void)position; }
  void disableOutputs() {}
  void enableOutputs() {}
};
