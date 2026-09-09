#pragma once
/*
 * Host-compile shim for the TMCStepper library (Trinamic TMC2209 and friends).
 *
 * The behavioural emulator compiles generated sketches with g++ on the host, so
 * every library a catalog part declares needs a header here or the sketch fails
 * to build and the run degrades to structural-only checks. This mirrors the
 * public API surface without any UART traffic: the calls are no-ops and the
 * getters return plausible idle values.
 */
#include "Arduino.h"

#define TMC2209_SLAVE_ADDR 0b00

class TMCStepper {
 public:
  virtual ~TMCStepper() {}
  void begin() {}
  /** Motor RMS current in mA (the setter the generated code cares about). */
  void rms_current(uint16_t mA) { current_ = mA; }
  void rms_current(uint16_t mA, float hold) { current_ = mA; (void)hold; }
  uint16_t rms_current() { return current_; }
  void microsteps(uint16_t ms) { microsteps_ = ms; }
  uint16_t microsteps() { return microsteps_; }
  void toff(uint8_t value) { toff_ = value; }
  uint8_t toff() { return toff_; }
  void blank_time(uint8_t value) { (void)value; }
  void hysteresis_start(uint8_t value) { (void)value; }
  void hysteresis_end(int8_t value) { (void)value; }
  void en_spreadCycle(bool enable) { spread_ = enable; }
  bool en_spreadCycle() { return spread_; }
  void pwm_autoscale(bool enable) { (void)enable; }
  void pwm_autograd(bool enable) { (void)enable; }
  void intpol(bool enable) { (void)enable; }
  void I_scale_analog(bool enable) { (void)enable; }
  void internal_Rsense(bool enable) { (void)enable; }
  void shaft(bool invert) { (void)invert; }
  void iholddelay(uint8_t value) { (void)value; }
  void ihold(uint8_t value) { (void)value; }
  void irun(uint8_t value) { (void)value; }
  void TPOWERDOWN(uint8_t value) { (void)value; }
  void TCOOLTHRS(uint32_t value) { (void)value; }
  void TPWMTHRS(uint32_t value) { (void)value; }
  void SGTHRS(uint8_t value) { sgthrs_ = value; }
  uint8_t SGTHRS() { return sgthrs_; }
  uint16_t SG_RESULT() { return 0; }
  /** No driver is present on the host, so report "idle and healthy". */
  uint32_t DRV_STATUS() { return 0; }
  uint8_t test_connection() { return 0; }
  uint16_t cs2rms(uint8_t cs) { (void)cs; return current_; }
  bool stst() { return true; }
  bool otpw() { return false; }
  bool ot() { return false; }
  uint32_t GCONF() { return 0; }
  uint16_t version() { return 0x21; }

 protected:
  uint16_t current_ = 0;
  uint16_t microsteps_ = 16;
  uint8_t toff_ = 5;
  uint8_t sgthrs_ = 0;
  bool spread_ = false;
};

class TMC2209Stepper : public TMCStepper {
 public:
  TMC2209Stepper(HardwareSerial* serial, float rSense, uint8_t addr) { (void)serial; (void)rSense; (void)addr; }
  TMC2209Stepper(uint16_t rx, uint16_t tx, float rSense, uint8_t addr) { (void)rx; (void)tx; (void)rSense; (void)addr; }
  void beginSerial(uint32_t baud) { (void)baud; }
  void push() {}
};

class TMC2208Stepper : public TMC2209Stepper {
 public:
  TMC2208Stepper(HardwareSerial* serial, float rSense) : TMC2209Stepper(serial, rSense, 0) {}
  TMC2208Stepper(uint16_t rx, uint16_t tx, float rSense) : TMC2209Stepper(rx, tx, rSense, 0) {}
};

class TMC2130Stepper : public TMCStepper {
 public:
  TMC2130Stepper(uint16_t cs) { (void)cs; }
  TMC2130Stepper(uint16_t cs, float rSense) { (void)cs; (void)rSense; }
  void sgt(int8_t value) { (void)value; }
  void diag1_stall(bool enable) { (void)enable; }
};
