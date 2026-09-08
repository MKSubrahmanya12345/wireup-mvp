#pragma once
#include "Adafruit_GFX.h"
#include "Wire.h"
#define SSD1306_SWITCHCAPVCC 0x2
#define SSD1306_EXTERNALVCC 0x1
#define SSD1306_BLACK 0
#define SSD1306_WHITE 1
#define SSD1306_INVERSE 2
class Adafruit_SSD1306 : public Adafruit_GFX {
 public:
  Adafruit_SSD1306(int width, int height, TwoWire* wire = &Wire, int reset = -1)
      : Adafruit_GFX(width, height) { (void)wire; (void)reset; }
  bool begin(uint8_t switchvcc = SSD1306_SWITCHCAPVCC, uint8_t i2caddr = 0x3C, bool reset = true) {
    (void)switchvcc; (void)i2caddr; (void)reset; return true;
  }
  void clearDisplay() {}
  void display() {}
  void invertDisplay(bool invert) { (void)invert; }
  void dimDisplay(bool dim) { (void)dim; }
  void drawPixel(int16_t x, int16_t y, uint16_t color) override { (void)x; (void)y; (void)color; }
};
