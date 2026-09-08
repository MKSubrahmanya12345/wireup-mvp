// Wireup behavioural runtime: the instrumented Arduino core that EXECUTES a
// generated sketch and records its pin levels, servo angles and serial output.
//
// It is compiled together with the sketch (which defines setup()/loop()) and
// run as a host process. The scenario (scheduled input events) and the trace
// (observed behaviour) are exchanged as plain-text files so no JSON parser is
// needed on the C++ side.

#include "Arduino.h"
#include "Wire.h"
#include "EEPROM.h"
#include "SPI.h"
#include "WiFi.h"
#include "Servo.h"

// The Arduino core's min/max function-like macros collide with std::min/max in
// <algorithm>; the runtime only needs the STL versions after this point.
#undef min
#undef max

#include <vector>
#include <map>
#include <string>
#include <cstdlib>
#include <fstream>
#include <algorithm>

/* ---- virtual time + state ------------------------------------------------- */

static unsigned long g_simClock = 0;      // virtual milliseconds
static unsigned long g_loopCount = 0;

static const int PIN_MAX = 64;
static int g_pinLevel[PIN_MAX];           // last written level, -1 = never
static int g_pinMode[PIN_MAX];            // 0 = INPUT, 1 = OUTPUT, 2 = INPUT_PULLUP
static int g_inputOverride[PIN_MAX];      // -1 = no override (reads HIGH)
static bool g_pinDriven[PIN_MAX];

/* serial */
static std::string g_serialLine;          // partial line being assembled
static std::vector<int> g_rxQueue;        // bytes to deliver to read()

/* eeprom */
static std::vector<uint8_t> g_eeprom;

/* trace */
struct PinEvent { int pin; int level; unsigned long atMs; };
struct ServoEvent { int pin; int angle; unsigned long atMs; };
struct SerialLine { std::string text; unsigned long atMs; };
static std::vector<PinEvent> g_pinEvents;
static std::vector<ServoEvent> g_servoEvents;
static std::vector<SerialLine> g_serialLines;

/* scenario */
struct ScheduledEvent { unsigned long atMs; int kind; int pin; int level; int byte; };
static std::vector<ScheduledEvent> g_schedule;
static size_t g_scheduleCursor = 0;

/* ---- hooks used by the inline methods in Arduino.h ------------------------ */

namespace wireup {

void serialWrite(const char* text) {
  if (!text) return;
  for (const char* p = text; *p; ++p) serialWriteChar(*p);
}

void serialWriteChar(char c) {
  if (c == '\n' || c == '\r') { serialNewline(); return; }
  g_serialLine.push_back(c);
}

void serialNewline() {
  if (g_serialLine.empty()) return;
  g_serialLines.push_back({ g_serialLine, g_simClock });
  g_serialLine.clear();
}

int serialAvailable() { return (int)g_rxQueue.size(); }
int serialRead() {
  if (g_rxQueue.empty()) return -1;
  int b = g_rxQueue.front();
  g_rxQueue.erase(g_rxQueue.begin());
  return b;
}
int serialPeek() { return g_rxQueue.empty() ? -1 : g_rxQueue.front(); }

void pinLevelChanged(int pin, int level) {
  if (pin < 0 || pin >= PIN_MAX) return;
  g_pinLevel[pin] = level;
  g_pinEvents.push_back({ pin, level, g_simClock });
}

void pinDriven(int pin, int value) {
  if (pin < 0 || pin >= PIN_MAX) return;
  g_pinDriven[pin] = true;
}

int inputLevel(int pin) {
  if (pin < 0 || pin >= PIN_MAX) return HIGH;
  if (g_inputOverride[pin] >= 0) return g_inputOverride[pin];
  if (g_pinMode[pin] == 1 && g_pinLevel[pin] >= 0) return g_pinLevel[pin];
  return HIGH;
}

void servoWrote(int pin, int angle) {
  g_pinDriven[pin] = true;
  g_servoEvents.push_back({ pin, angle, g_simClock });
}

bool eepromBegin(int size) {
  if (size > (int)g_eeprom.size()) g_eeprom.resize(size, 0);
  return true;
}
void eepromWrote(int index, uint8_t value) {
  if (index < 0) return;
  if (index >= (int)g_eeprom.size()) g_eeprom.resize(index + 1, 0);
  g_eeprom[index] = value;
}
uint8_t eepromRead(int index) {
  if (index < 0 || index >= (int)g_eeprom.size()) return 0;
  return g_eeprom[index];
}

} // namespace wireup

/* ---- core functions ------------------------------------------------------- */

HardwareSerial Serial;
HardwareSerial Serial1;
TwoWire Wire;
EEPROMClass EEPROM;
SPIClass SPI;
WiFiClass WiFi;

void pinMode(uint8_t pin, uint8_t mode) {
  if (pin >= PIN_MAX) return;
  g_pinMode[pin] = mode;
}

void digitalWrite(uint8_t pin, uint8_t value) {
  if (pin >= PIN_MAX) return;
  wireup::pinDriven(pin, value);
  if (g_pinLevel[pin] != (int)(value ? HIGH : LOW)) wireup::pinLevelChanged(pin, value ? HIGH : LOW);
}

int digitalRead(uint8_t pin) { return wireup::inputLevel(pin); }

int analogRead(uint8_t pin) { (void)pin; return 0; }

void analogWrite(uint8_t pin, int value) {
  if (pin >= PIN_MAX) return;
  wireup::pinDriven(pin, value);
  wireup::pinLevelChanged(pin, value > 127 ? HIGH : LOW);
}

unsigned long millis() { return g_simClock; }
unsigned long micros() { return g_simClock * 1000UL; }

static void applyScheduled() {
  while (g_scheduleCursor < g_schedule.size() && g_schedule[g_scheduleCursor].atMs <= g_simClock) {
    const ScheduledEvent& ev = g_schedule[g_scheduleCursor++];
    if (ev.kind == 0) { // PIN
      if (ev.pin >= 0 && ev.pin < PIN_MAX) g_inputOverride[ev.pin] = ev.level;
    } else {            // SERIAL
      g_rxQueue.push_back(ev.byte);
    }
  }
}

void delay(unsigned long ms) {
  for (unsigned long i = 0; i < ms; ++i) {
    g_simClock += 1;
    applyScheduled();
  }
}

void delayMicroseconds(unsigned int us) {
  unsigned long ms = (us + 999UL) / 1000UL;
  for (unsigned long i = 0; i < ms; ++i) {
    g_simClock += 1;
    applyScheduled();
  }
}

long map(long value, long fromLow, long fromHigh, long toLow, long toHigh) {
  if (fromHigh == fromLow) return toLow;
  return toLow + (value - fromLow) * (toHigh - toLow) / (fromHigh - fromLow);
}

long constrain(long value, long low, long high) { return value < low ? low : (value > high ? high : value); }

void tone(uint8_t pin, unsigned int frequency, unsigned long duration) {
  (void)frequency; (void)duration;
  if (pin >= PIN_MAX) return;
  wireup::pinDriven(pin, 1);
  wireup::pinLevelChanged(pin, HIGH);
}

void noTone(uint8_t pin) {
  if (pin >= PIN_MAX) return;
  wireup::pinLevelChanged(pin, LOW);
}

void shiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t value) {
  (void)clockPin; (void)bitOrder; (void)value;
  if (dataPin < PIN_MAX) wireup::pinDriven(dataPin, 1);
}

uint8_t shiftIn(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder) {
  (void)dataPin; (void)clockPin; (void)bitOrder;
  return 0;
}

unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout) {
  (void)pin; (void)state; (void)timeout;
  return 0;
}

void yield() {}

/* ---- scenario + trace I/O ------------------------------------------------- */

static std::string escapeText(const std::string& in) {
  std::string out;
  out.reserve(in.size());
  for (char c : in) {
    if (c == '\\') out += "\\\\";
    else if (c == '\n' || c == '\r') out += ' ';
    else out += c;
  }
  return out;
}

static bool loadScenario(const char* path) {
  if (!path || !*path) return true;
  std::ifstream in(path);
  if (!in.is_open()) return false;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty() || line[0] == '#') continue;
    ScheduledEvent ev{ 0, 0, 0, 0, 0 };
    char kind[16];
    if (sscanf(line.c_str(), "%15s", kind) != 1) continue;
    if (std::string(kind) == "PIN") {
      int atMs = 0, pin = 0, level = 0;
      if (sscanf(line.c_str(), "%*s %d %d %d", &atMs, &pin, &level) == 3) {
        ev.atMs = atMs; ev.kind = 0; ev.pin = pin; ev.level = level ? HIGH : LOW;
        g_schedule.push_back(ev);
      }
    } else if (std::string(kind) == "SERIAL") {
      int atMs = 0; char b = 0;
      if (sscanf(line.c_str(), "%*s %d %c", &atMs, &b) == 2) {
        ev.atMs = atMs; ev.kind = 1; ev.byte = (int)(unsigned char)b;
        g_schedule.push_back(ev);
      }
    }
  }
  std::sort(g_schedule.begin(), g_schedule.end(),
            [](const ScheduledEvent& a, const ScheduledEvent& b) { return a.atMs < b.atMs; });
  return true;
}

static void dumpTrace(const char* path) {
  if (!path || !*path) return;
  std::ofstream out(path);
  if (!out.is_open()) return;
  for (const SerialLine& s : g_serialLines) out << "serial " << s.atMs << " " << escapeText(s.text) << "\n";
  for (const PinEvent& e : g_pinEvents) out << "pin " << e.pin << " " << e.level << " " << e.atMs << "\n";
  for (const ServoEvent& e : g_servoEvents) out << "servo " << e.pin << " " << e.angle << " " << e.atMs << "\n";
  for (int i = 0; i < PIN_MAX; ++i) if (g_pinDriven[i]) out << "driven " << i << "\n";
  out << "sim " << g_simClock << " " << g_loopCount << "\n";
}

/* ---- entry point ---------------------------------------------------------- */

void setup();
void loop();

int main(int argc, char** argv) {
  for (int i = 0; i < PIN_MAX; ++i) {
    g_pinLevel[i] = -1;
    g_pinMode[i] = 0;
    g_inputOverride[i] = -1;
    g_pinDriven[i] = false;
  }

  const char* scenario = std::getenv("WIREUP_SCENARIO");
  const char* traceOut = std::getenv("WIREUP_TRACE_OUT");
  const char* simMsEnv = std::getenv("WIREUP_SIM_MS");
  unsigned long simMs = simMsEnv && *simMsEnv ? (unsigned long)std::strtoul(simMsEnv, nullptr, 10) : 6000UL;

  loadScenario(scenario);

  setup();

  const unsigned long LOOP_LIMIT = 200000UL;
  while (g_simClock < simMs && g_loopCount < LOOP_LIMIT) {
    g_simClock += 1;
    applyScheduled();
    loop();
    g_loopCount += 1;
  }

  dumpTrace(traceOut);
  return 0;
}
