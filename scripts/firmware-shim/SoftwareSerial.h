#pragma once
#include "Arduino.h"
class SoftwareSerial : public HardwareSerial {
 public:
  SoftwareSerial(uint8_t rxPin, uint8_t txPin, bool invert = false) { (void)rxPin; (void)txPin; (void)invert; }
  void begin(unsigned long baud) { (void)baud; }
  bool listen() { return true; }
  bool isListening() { return true; }
  bool overflow() { return false; }
};
