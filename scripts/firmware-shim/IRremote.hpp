#pragma once
#include "Arduino.h"

// Host-compile / behavioural stub for Arduino-IRremote (IRremote.hpp entry).
// Same declarations, no IR hardware behind it.
struct decode_results {
  uint32_t value = 0;
  int bits = 0;
  int decode_type = 0; // UNUSED first, matching the library's enum layout
  bool repeat = false;
  uint16_t address = 0;
  uint16_t command = 0;
};

enum ir_protocol_stub { UNUSED = 0, NEC = 1, SONY = 2, RC5 = 3, RC6 = 4 };

class IRrecv {
 public:
  explicit IRrecv(int recvPin) { (void)recvPin; }
  void enableIRIn() {}
  void disableIRIn() {}
  void resume() {}
  bool decode() { return false; }
  bool decode(decode_results* results) { (void)results; return false; }
  unsigned long decodedIRData = 0;
};

class IRsend {
 public:
  explicit IRsend(int sendPin = 3) { (void)sendPin; }
  void begin() {}
  void sendNEC(uint32_t data, int bits = 32) { (void)data; (void)bits; }
  void sendSony(uint32_t data, int bits = 12) { (void)data; (void)bits; }
  void sendRaw(const uint16_t* buf, int len, int hz) { (void)buf; (void)len; (void)hz; }
};
