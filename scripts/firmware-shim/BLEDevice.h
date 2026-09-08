#pragma once
#include "Arduino.h"
#include <string>
class BLEValue {};
class BLECharacteristic {
 public:
  void setValue(const char* value) { (void)value; }
  void setValue(const std::string& value) { (void)value; }
  void notify() {}
};
class BLEService {
 public:
  BLECharacteristic* createCharacteristic(const char* uuid, int properties) { (void)uuid; (void)properties; return nullptr; }
  void start() {}
};
class BLEAdvertising {
 public:
  void start() {}
  void stop() {}
};
class BLEServer {
 public:
  BLEService* createService(const char* uuid) { (void)uuid; return nullptr; }
  BLEAdvertising* getAdvertising() { return nullptr; }
};
class BLEDeviceClass {
 public:
  static BLEServer* createServer() { return nullptr; }
  static void init(const std::string& name) { (void)name; }
  static BLEAdvertising* getAdvertising() { return nullptr; }
};
#define BLEDevice BLEDeviceClass
#define BLE_READ 0x02
#define BLE_WRITE 0x08
#define BLE_NOTIFY 0x10
