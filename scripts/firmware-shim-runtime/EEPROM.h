#pragma once
#include "Arduino.h"

/* Instrumented EEPROM with real storage, so PIN persistence (and its failure
   modes) are observable at runtime. */
class EEPROMClass {
 public:
  bool begin(size_t size) { return wireup::eepromBegin((int)size); }
  bool commit() { return true; }
  void end() {}
  uint8_t read(int index) { return wireup::eepromRead(index); }
  void write(int index, uint8_t value) { wireup::eepromWrote(index, value); }
  void update(int index, uint8_t value) { wireup::eepromWrote(index, value); }
  template <typename T> T& get(int index, T& value) {
    uint8_t* dst = reinterpret_cast<uint8_t*>(&value);
    for (size_t i = 0; i < sizeof(T); i++) dst[i] = wireup::eepromRead(index + (int)i);
    return value;
  }
  template <typename T> const T& put(int index, const T& value) {
    const uint8_t* src = reinterpret_cast<const uint8_t*>(&value);
    for (size_t i = 0; i < sizeof(T); i++) wireup::eepromWrote(index + (int)i, src[i]);
    return value;
  }
};
extern EEPROMClass EEPROM;
