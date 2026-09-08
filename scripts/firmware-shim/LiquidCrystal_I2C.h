#pragma once
#include "Arduino.h"
#include "Wire.h"
class LiquidCrystal_I2C {
 public:
  LiquidCrystal_I2C(uint8_t address, uint8_t columns, uint8_t rows) { (void)address; (void)columns; (void)rows; }
  void init() {}
  void begin(uint8_t columns = 16, uint8_t rows = 2) { (void)columns; (void)rows; }
  void clear() {}
  void home() {}
  void setCursor(uint8_t column, uint8_t row) { (void)column; (void)row; }
  void backlight() {}
  void noBacklight() {}
  void cursor() {}
  void noCursor() {}
  void blink() {}
  void noBlink() {}
  void display() {}
  void noDisplay() {}
  void createChar(uint8_t location, const uint8_t* bytes) { (void)location; (void)bytes; }
  size_t print(const char* s) { return std::strlen(s); }
  size_t print(const String& s) { return s.length(); }
  size_t print(char c) { (void)c; return 1; }
  size_t print(int v, int base = DEC) { (void)v; (void)base; return 1; }
  size_t print(unsigned int v, int base = DEC) { (void)v; (void)base; return 1; }
  size_t print(long v, int base = DEC) { (void)v; (void)base; return 1; }
  size_t print(unsigned long v, int base = DEC) { (void)v; (void)base; return 1; }
  size_t print(double v, int decimals = 2) { (void)v; (void)decimals; return 1; }
  size_t println(double v, int decimals = 2) { return print(v, decimals); }
  size_t println(const char* s = "") { return print(s); }
  size_t println(const String& s) { return print(s); }
};
