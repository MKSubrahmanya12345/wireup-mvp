// Minimal host-side stub of the Arduino core, for syntax/type checking only.
#pragma once
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cmath>
#include <string>

#define HIGH 0x1
#define LOW 0x0
#define INPUT 0x0
#define OUTPUT 0x1
#define INPUT_PULLUP 0x2
#define LSBFIRST 0
#define MSBFIRST 1
#define LED_BUILTIN 13
#define A0 14
#define A1 15
#define A2 16
#define A3 17
#define A4 18
#define A5 19
#define A6 20
#define A7 21
#define min(a, b) ((a) < (b) ? (a) : (b))
#define max(a, b) ((a) > (b) ? (a) : (b))
#define abs(x) ((x) > 0 ? (x) : -(x))
#define sq(x) ((x) * (x))
#define lowByte(w) ((uint8_t)((w)&0xff))
#define highByte(w) ((uint8_t)((w) >> 8))
#define bitRead(value, bit) (((value) >> (bit)) & 0x01)
#define bitSet(value, bit) ((value) |= (1UL << (bit)))
#define bitClear(value, bit) ((value) &= ~(1UL << (bit)))
#define bitWrite(value, bit, bitvalue) ((bitvalue) ? bitSet(value, bit) : bitClear(value, bit))
#define DEC 10
#define HEX 16
#define OCT 8
#define BIN 2

#ifndef isnan
#define isnan(x) std::isnan(x)
#endif
#ifndef isinf
#define isinf(x) std::isinf(x)
#endif

typedef bool boolean;
typedef uint8_t byte;
typedef unsigned int word;

void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t value);
int digitalRead(uint8_t pin);
int analogRead(uint8_t pin);
void analogWrite(uint8_t pin, int value);
unsigned long millis();
unsigned long micros();
void delay(unsigned long ms);
void delayMicroseconds(unsigned int us);
long map(long value, long fromLow, long fromHigh, long toLow, long toHigh);
long constrain(long value, long low, long high);
void tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0);
void noTone(uint8_t pin);
void shiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t value);
uint8_t shiftIn(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder);
unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout = 1000000UL);
void yield();

class String : public std::string {
 public:
  String() : std::string() {}
  String(const char* s) : std::string(s ? s : "") {}
  String(const std::string& s) : std::string(s) {}
  String(int v) : std::string(std::to_string(v)) {}
  String(unsigned int v) : std::string(std::to_string(v)) {}
  String(long v) : std::string(std::to_string(v)) {}
  String(unsigned long v) : std::string(std::to_string(v)) {}
  String(float v, unsigned int decimals = 2) : std::string(std::to_string(v)) { (void)decimals; }
  String(double v, unsigned int decimals = 2) : std::string(std::to_string(v)) { (void)decimals; }
  String operator+(const String& other) const { return String(std::string(*this) + std::string(other)); }
  String& operator+=(const String& other) { append(std::string(other)); return *this; }
  bool operator==(const String& other) const { return std::string(*this) == std::string(other); }
  int toInt() const { return atoi(c_str()); }
  float toFloat() const { return static_cast<float>(atof(c_str())); }
  String substring(unsigned int from) const { return String(std::string::substr(from)); }
  String substring(unsigned int from, unsigned int to) const { return String(std::string::substr(from, to - from)); }
  void trim() {}
  int indexOf(char c) const { auto p = find(c); return p == npos ? -1 : static_cast<int>(p); }
  bool startsWith(const String& s) const { return rfind(std::string(s), 0) == 0; }
  void toCharArray(char* buf, unsigned int len) const { snprintf(buf, len, "%s", c_str()); }
  unsigned int length() const { return static_cast<unsigned int>(std::string::size()); }
};

class HardwareSerial {
 public:
  void begin(unsigned long baud) { (void)baud; }
  void end() {}
  int available() { return 0; }
  int read() { return -1; }
  int peek() { return -1; }
  void flush() {}
  size_t print(const char* s) { return std::strlen(s); }
  size_t print(const String& s) { return s.length(); }
  size_t print(char c) { (void)c; return 1; }
  size_t print(int v, int base = DEC) { (void)v; (void)base; return 1; }
  size_t print(unsigned int v, int base = DEC) { (void)v; (void)base; return 1; }
  size_t print(long v, int base = DEC) { (void)v; (void)base; return 1; }
  size_t print(unsigned long v, int base = DEC) { (void)v; (void)base; return 1; }
  size_t print(double v, int decimals = 2) { (void)v; (void)decimals; return 1; }
  size_t println() { return 1; }
  size_t println(const char* s) { return print(s); }
  size_t println(const String& s) { return print(s); }
  size_t println(char c) { return print(c); }
  size_t println(int v, int base = DEC) { return print(v, base); }
  size_t println(unsigned int v, int base = DEC) { return print(v, base); }
  size_t println(long v, int base = DEC) { return print(v, base); }
  size_t println(unsigned long v, int base = DEC) { return print(v, base); }
  size_t println(double v, int decimals = 2) { return print(v, decimals); }
};

extern HardwareSerial Serial;
extern HardwareSerial Serial1;

// Minimal PROGMEM helpers so sketches written for AVR still typecheck.
#define PROGMEM
#define F(string_literal) string_literal
typedef void (*FnPtr)();
#define pgm_read_byte(addr) (*(const unsigned char*)(addr))
#define pgm_read_word(addr) (*(const unsigned short*)(addr))
