#pragma once
#include "Arduino.h"
class SPISettings {
 public:
  SPISettings(uint32_t clock, uint8_t bitOrder, uint8_t dataMode) { (void)clock; (void)bitOrder; (void)dataMode; }
};
class SPIClass {
 public:
  void begin() {}
  void end() {}
  void beginTransaction(SPISettings settings) { (void)settings; }
  void endTransaction() {}
  uint8_t transfer(uint8_t data) { return data; }
};
extern SPIClass SPI;
