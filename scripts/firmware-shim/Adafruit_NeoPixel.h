#pragma once
#include "Arduino.h"
#define NEO_GRB 0x01
#define NEO_RGB 0x00
#define NEO_KHZ800 0x00
class Adafruit_NeoPixel {
 public:
  Adafruit_NeoPixel(uint16_t n, int16_t pin = -1, uint16_t type = NEO_GRB + NEO_KHZ800) { (void)n; (void)pin; (void)type; }
  void begin() {}
  void show() {}
  void setPin(int16_t pin) { (void)pin; }
  void setPixelColor(uint16_t n, uint32_t color) { (void)n; (void)color; }
  void setPixelColor(uint16_t n, uint8_t r, uint8_t g, uint8_t b) { (void)n; (void)r; (void)g; (void)b; }
  void fill(uint32_t color = 0, uint16_t first = 0, uint16_t count = 0) { (void)color; (void)first; (void)count; }
  void clear() {}
  void setBrightness(uint8_t brightness) { (void)brightness; }
  uint16_t numPixels() { return 0; }
  uint32_t Color(uint8_t r, uint8_t g, uint8_t b) { return (uint32_t)r << 16 | (uint32_t)g << 8 | b; }
  static uint32_t ColorHSV(uint16_t hue, uint8_t sat = 255, uint8_t val = 255) { (void)hue; (void)sat; (void)val; return 0; }
};
