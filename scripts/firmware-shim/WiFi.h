#pragma once
#include "Arduino.h"
#define WL_CONNECTED 3
#define WL_IDLE_STATUS 0
#define WL_DISCONNECTED 6
class WiFiClient : public HardwareSerial {};
class WiFiServer {
 public:
  WiFiServer(uint16_t port) { (void)port; }
  void begin() {}
  WiFiClient available() { return WiFiClient(); }
};
class WiFiClass {
 public:
  int begin(const char* ssid) { (void)ssid; return WL_CONNECTED; }
  int begin(const char* ssid, const char* passphrase) { (void)ssid; (void)passphrase; return WL_CONNECTED; }
  void disconnect(bool wifioff = false) { (void)wifioff; }
  int status() { return WL_CONNECTED; }
  String localIP() { return String("192.168.1.50"); }
  String SSID() { return String("ssid"); }
  int8_t RSSI() { return -50; }
  void mode(uint8_t mode) { (void)mode; }
};
extern WiFiClass WiFi;
#define WIFI_STA 1
#define WIFI_AP 2
#define WIFI_AP_STA 3
