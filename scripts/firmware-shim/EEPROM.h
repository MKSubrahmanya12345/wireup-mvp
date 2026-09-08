#pragma once
#include "Arduino.h"
class EEPROMClass {
 public:
  bool begin(size_t size) { (void)size; return true; }
  bool commit() { return true; }
  void end() {}
  uint8_t read(int index) { (void)index; return 0; }
  void write(int index, uint8_t value) { (void)index; (void)value; }
  void update(int index, uint8_t value) { (void)index; (void)value; }
  template <typename T> T& get(int index, T& value) { (void)index; return value; }
  template <typename T> const T& put(int index, const T& value) { (void)index; return value; }
};
extern EEPROMClass EEPROM;
