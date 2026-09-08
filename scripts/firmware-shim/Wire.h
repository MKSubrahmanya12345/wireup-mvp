#pragma once
#include "Arduino.h"
class TwoWire {
 public:
  void begin() {}
  void begin(int address) { (void)address; }
  void setClock(uint32_t freq) { (void)freq; }
  void beginTransmission(int address) { (void)address; }
  uint8_t endTransmission(bool stop = true) { (void)stop; return 0; }
  uint8_t requestFrom(int address, int quantity) { (void)address; (void)quantity; return 0; }
  size_t write(uint8_t value) { (void)value; return 1; }
  int available() { return 0; }
  int read() { return 0; }
};
extern TwoWire Wire;
