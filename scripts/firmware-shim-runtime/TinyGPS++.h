#pragma once
#include "Arduino.h"

// Host-compile / behavioural stub for mikalhart/TinyGPSPlus (TinyGPS++.h).
// Same declarations, no UART stream behind it.

class TinyGPSLocation {
 public:
  double lat() { return 0.0; }
  double lng() { return 0.0; }
  bool isValid() { return false; }
  bool isUpdated() { return false; }
  uint32_t age() { return 0xFFFFFFFF; }
};

class TinyGPSDate {
 public:
  uint16_t year() { return 2000; }
  uint8_t month() { return 1; }
  uint8_t day() { return 1; }
  uint32_t value() { return 0; }
  bool isValid() { return false; }
  bool isUpdated() { return false; }
  uint32_t age() { return 0xFFFFFFFF; }
};

class TinyGPSTime {
 public:
  uint8_t hour() { return 0; }
  uint8_t minute() { return 0; }
  uint8_t second() { return 0; }
  uint8_t hundredths() { return 0; }
  uint32_t value() { return 0; }
  bool isValid() { return false; }
  bool isUpdated() { return false; }
  uint32_t age() { return 0xFFFFFFFF; }
};

class TinyGPSDecimal {
 public:
  double value() { return 0.0; }
  bool isValid() { return false; }
  bool isUpdated() { return false; }
  uint32_t age() { return 0xFFFFFFFF; }
};

class TinyGPSAltitude : public TinyGPSDecimal {
 public:
  double meters() { return 0.0; }
  double miles() { return 0.0; }
  double kilometers() { return 0.0; }
  double feet() { return 0.0; }
};

class TinyGPSSpeed : public TinyGPSDecimal {
 public:
  double kmph() { return 0.0; }
  double mph() { return 0.0; }
  double knots() { return 0.0; }
  double mps() { return 0.0; }
};

class TinyGPSCourse : public TinyGPSDecimal {
 public:
  double deg() { return 0.0; }
};

class TinyGPSInteger : public TinyGPSDecimal {};

class TinyGPSPlus {
 public:
  TinyGPSLocation location;
  TinyGPSDate date;
  TinyGPSTime time;
  TinyGPSAltitude altitude;
  TinyGPSSpeed speed;
  TinyGPSCourse course;
  TinyGPSInteger satellites;

  bool encode(char c) { (void)c; return false; }
  int libraryVersion() { return 22; }
  uint32_t charsProcessed() { return 0; }
  uint32_t sentencesWithFix() { return 0; }
  uint32_t failedChecksum() { return 0; }
  uint32_t passedChecksum() { return 0; }
  static float distanceBetween(double lat1, double long1, double lat2, double long2) {
    (void)lat1; (void)long1; (void)lat2; (void)long2; return 0.0f;
  }
  static double courseTo(double lat1, double long1, double lat2, double long2) {
    (void)lat1; (void)long1; (void)lat2; (void)long2; return 0.0;
  }
};
