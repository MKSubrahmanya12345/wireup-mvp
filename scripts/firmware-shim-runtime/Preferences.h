#pragma once
#include "Arduino.h"
class Preferences {
 public:
  bool begin(const char* name, bool readOnly = false) { (void)name; (void)readOnly; return true; }
  void end() {}
  bool putInt(const char* key, int32_t value) { (void)key; (void)value; return true; }
  int32_t getInt(const char* key, int32_t defaultValue = 0) { (void)key; return defaultValue; }
  bool putString(const char* key, const char* value) { (void)key; (void)value; return true; }
  String getString(const char* key, const char* defaultValue = "") { (void)key; return String(defaultValue); }
  bool clear() { return true; }
};
