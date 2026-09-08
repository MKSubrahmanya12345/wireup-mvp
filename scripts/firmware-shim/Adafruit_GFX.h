#pragma once
#include "Arduino.h"
class Adafruit_GFX {
 public:
  Adafruit_GFX(int w, int h) : WIDTH(w), HEIGHT(h) {}
  virtual ~Adafruit_GFX() {}
  const int WIDTH, HEIGHT;
  virtual void drawPixel(int16_t x, int16_t y, uint16_t color) { (void)x; (void)y; (void)color; }
  void setCursor(int16_t x, int16_t y) { (void)x; (void)y; }
  void setTextColor(uint16_t color) { (void)color; }
  void setTextColor(uint16_t color, uint16_t background) { (void)color; (void)background; }
  void setTextSize(uint8_t size) { (void)size; }
  void setTextWrap(bool wrap) { (void)wrap; }
  void setRotation(uint8_t rotation) { (void)rotation; }
  int16_t width() const { return static_cast<int16_t>(WIDTH); }
  int16_t height() const { return static_cast<int16_t>(HEIGHT); }
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
  size_t println(char c) { return print(c); }
  size_t println(int v, int base = DEC) { return print(v, base); }
  size_t println(unsigned long v, int base = DEC) { return print(v, base); }
  void fillRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) { (void)x; (void)y; (void)w; (void)h; (void)color; }
  void drawRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) { (void)x; (void)y; (void)w; (void)h; (void)color; }
};
