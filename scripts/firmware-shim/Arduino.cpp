#include "Arduino.h"
#include "Wire.h"
#include "EEPROM.h"
HardwareSerial Serial;
HardwareSerial Serial1;
TwoWire Wire;
EEPROMClass EEPROM;
void pinMode(uint8_t, uint8_t) {}
void digitalWrite(uint8_t, uint8_t) {}
int digitalRead(uint8_t) { return 0; }
int analogRead(uint8_t) { return 0; }
void analogWrite(uint8_t, int) {}
unsigned long millis() { return 0; }
unsigned long micros() { return 0; }
void delay(unsigned long) {}
void delayMicroseconds(unsigned int) {}
long map(long v, long, long, long lo, long) { return lo; }
long constrain(long v, long lo, long hi) { return v < lo ? lo : (v > hi ? hi : v); }
void tone(uint8_t, unsigned int, unsigned long) {}
void noTone(uint8_t) {}
void yield() {}
int main();
int main() { return 0; }
