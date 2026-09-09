#pragma once
#include "Arduino.h"

// Host-compile / behavioural stub for the Arduino SD library (LEA6H fatfs on
// SPI). Same declarations, no filesystem behind it.
class File {
 public:
  operator bool() const { return false; }
  void close() {}
  int read() { return -1; }
  int read(void* buf, int len) { (void)buf; (void)len; return -1; }
  int peek() { return -1; }
  int available() { return 0; }
  void flush() {}
  size_t write(uint8_t data) { (void)data; return 1; }
  size_t write(const char* text) { (void)text; return 0; }
  size_t write(const uint8_t* buf, size_t len) { (void)buf; (void)len; return len; }
  int position() { return 0; }
  void seek(int pos) { (void)pos; }
  unsigned long size() { return 0; }
  const char* name() { return ""; }
  bool isDirectory() { return false; }
};

class SDClass {
 public:
  bool begin(int chipSelect = 4) { (void)chipSelect; return true; }
  void end() {}
  File open(const char* path, int mode = 0) { (void)path; (void)mode; return File(); }
  bool exists(const char* path) { (void)path; return false; }
  bool mkdir(const char* path) { (void)path; return true; }
  bool remove(const char* path) { (void)path; return true; }
  bool rmdir(const char* path) { (void)path; return true; }
};

extern SDClass SD;
