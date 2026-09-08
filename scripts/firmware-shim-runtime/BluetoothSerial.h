#pragma once
#include "Arduino.h"
class BluetoothSerial : public HardwareSerial {
 public:
  bool begin(const char* name, bool isMaster = false) { (void)name; (void)isMaster; return true; }
  bool hasClient() { return false; }
  void end() {}
};
