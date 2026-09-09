#pragma once
#include "Arduino.h"
#include "Wire.h"

// Host-compile / behavioural stub for the JeeLabs RTClib (DS1307/DS3231/PCF8520).
// Same declarations, no bus behind it.
class TimeSpan;

class DateTime {
 public:
  DateTime() {}
  DateTime(uint16_t year, uint8_t month, uint8_t day, uint8_t hour = 0, uint8_t min = 0, uint8_t sec = 0)
      : y(year), m(month), d(day), hh(hour), mm(min), ss(sec) {}
  explicit DateTime(uint32_t t) { (void)t; }
  uint16_t year() const { return y; }
  uint8_t month() const { return m; }
  uint8_t day() const { return d; }
  uint8_t hour() const { return hh; }
  uint8_t minute() const { return mm; }
  uint8_t second() const { return ss; }
  uint8_t dayOfTheWeek() const { return 0; }
  uint32_t unixtime() const { return 0; }

 private:
  uint16_t y = 2000;
  uint8_t m = 1, d = 1, hh = 0, mm = 0, ss = 0;
};

class RTC_DS1307 {
 public:
  bool begin(TwoWire* wire = nullptr) { (void)wire; return true; }
  static bool start(TwoWire* wire = nullptr) { (void)wire; return true; }
  void adjust(const DateTime& dt) { (void)dt; }
  bool isrunning() { return true; }
  DateTime now() { return DateTime(); }
  int readnvram(int address) { (void)address; return 0; }
  void writenvram(int address, uint8_t value) { (void)address; (void)value; }
};

class RTC_DS3231 {
 public:
  bool begin(TwoWire* wire = nullptr) { (void)wire; return true; }
  static bool start(TwoWire* wire = nullptr) { (void)wire; return true; }
  void adjust(const DateTime& dt) { (void)dt; }
  bool lostPower() { return false; }
  DateTime now() { return DateTime(); }
  float getTemperature() { return 25.0f; }
};

class RTC_PCF8520 {
 public:
  bool begin(TwoWire* wire = nullptr) { (void)wire; return true; }
  static bool start(TwoWire* wire = nullptr) { (void)wire; return true; }
  void adjust(const DateTime& dt) { (void)dt; }
  bool initialized() { return true; }
  DateTime now() { return DateTime(); }
};
