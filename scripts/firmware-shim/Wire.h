#pragma once
#include "Arduino.h"
class TwoWire {
 public:
  void begin() {}
  void begin(int address) { (void)address; }
  /*
   * Remappable cores (ESP32, RP2040, SAMD) route the bus to any two GPIOs with
   * Wire.begin(sda, scl). The generated sketches pass the planned pin constants
   * there, so the shim must accept the two-argument form or every ESP32 I2C
   * sketch fails type-checking with "no matching function for call to begin".
   */
  bool begin(int sda, int scl, uint32_t frequency = 0) {
    (void)sda;
    (void)scl;
    (void)frequency;
    return true;
  }
  void setClock(uint32_t freq) { (void)freq; }
  void beginTransmission(int address) { (void)address; }
  uint8_t endTransmission(bool stop = true) { (void)stop; return 0; }
  uint8_t requestFrom(int address, int quantity) { (void)address; (void)quantity; return 0; }
  size_t write(uint8_t value) { (void)value; return 1; }
  int available() { return 0; }
  int read() { return 0; }
};
extern TwoWire Wire;
