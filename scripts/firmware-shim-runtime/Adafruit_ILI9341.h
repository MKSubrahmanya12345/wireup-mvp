#pragma once
#include "Arduino.h"
#include "Adafruit_GFX.h"
#include "SPI.h"

// Host-compile / behavioural stub for the Adafruit ILI9341 SPI TFT driver.
// Same declarations, no hardware behind it.

#define ILI9341_BLACK       0x0000
#define ILI9341_NAVY        0x000F
#define ILI9341_DARKGREEN   0x03E0
#define ILI9341_DARKCYAN    0x03EF
#define ILI9341_MAROON      0x7800
#define ILI9341_PURPLE      0x780F
#define ILI9341_OLIVE       0x7BE0
#define ILI9341_LIGHTGREY   0xD69A
#define ILI9341_DARKGREY    0x7BEF
#define ILI9341_BLUE        0x001F
#define ILI9341_GREEN       0x07E0
#define ILI9341_CYAN        0x07FF
#define ILI9341_RED         0xF800
#define ILI9341_MAGENTA     0xF81F
#define ILI9341_YELLOW      0xFFE0
#define ILI9341_WHITE       0xFFFF
#define ILI9341_ORANGE      0xFD20

class Adafruit_ILI9341 : public Adafruit_GFX {
 public:
  // Hardware SPI: (cs, dc, rst). Only int8_t overloads, matching the real
  // library — a uint8_t variant makes `Adafruit_ILI9341 tft(10, 9, 8)` with
  // plain int macros ambiguous.
  Adafruit_ILI9341(int8_t cs, int8_t dc, int8_t rst = -1)
      : Adafruit_GFX(240, 320) { (void)cs; (void)dc; (void)rst; }
  // Software SPI: (cs, dc, mosi, sclk, rst, miso)
  Adafruit_ILI9341(int8_t cs, int8_t dc, int8_t mosi, int8_t sclk, int8_t rst, int8_t miso = -1)
      : Adafruit_GFX(240, 320) { (void)cs; (void)dc; (void)mosi; (void)sclk; (void)rst; (void)miso; }
  void begin(uint32_t freq = 0) { (void)freq; }
  void setAddrWindow(int16_t x, int16_t y, int16_t w, int16_t h) { (void)x; (void)y; (void)w; (void)h; }
  void pushColor(uint16_t color) { (void)color; }
  void fillScreen(uint16_t color) { (void)color; }
  void invertDisplay(bool invert) { (void)invert; }
  void drawPixel(int16_t x, int16_t y, uint16_t color) override { (void)x; (void)y; (void)color; }
  void drawLine(int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint16_t color) {
    (void)x0; (void)y0; (void)x1; (void)y1; (void)color;
  }
  void drawCircle(int16_t x0, int16_t y0, int16_t r, uint16_t color) { (void)x0; (void)y0; (void)r; (void)color; }
  void fillCircle(int16_t x0, int16_t y0, int16_t r, uint16_t color) { (void)x0; (void)y0; (void)r; (void)color; }
  void drawRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, uint16_t color) {
    (void)x; (void)y; (void)w; (void)h; (void)r; (void)color;
  }
  void fillRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, uint16_t color) {
    (void)x; (void)y; (void)w; (void)h; (void)r; (void)color;
  }
  void drawTriangle(int16_t x0, int16_t y0, int16_t x1, int16_t y1, int16_t x2, int16_t y2, uint16_t color) {
    (void)x0; (void)y0; (void)x1; (void)y1; (void)x2; (void)y2; (void)color;
  }
  void fillTriangle(int16_t x0, int16_t y0, int16_t x1, int16_t y1, int16_t x2, int16_t y2, uint16_t color) {
    (void)x0; (void)y0; (void)x1; (void)y1; (void)x2; (void)y2; (void)color;
  }
};
