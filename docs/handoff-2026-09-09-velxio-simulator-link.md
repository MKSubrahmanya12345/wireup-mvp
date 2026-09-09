# Handoff — the registry ↔ Velxio simulator link (the "48 simulatable objects" batch)

**Branch:** `arena/01a0875b-wireup-mvp`
**Date:** 2026-09-09
**Status:** typecheck clean; `next build` clean; `verify:contracts` 28/28;
`verify:cad-link` ok (95 parts); `verify:offline` pass; `verify:behavioral` 19/19;
**new gate `verify:simulator` pass** (41 claims, 43 part mappings, 10 board
mappings, end-to-end projection 37 peripherals / 70 wires, zero drops).

---

## 1. What was asked

The admin panel, the 3D CAD helper and the Arduino Uno are considered finished
and correct — do not regress them. Cross-check **everything** the way the Uno
was done, and — for now — only add/confirm simulator support in the style of
**the 48 Velxio-simulatable objects**. Nothing else this round.

## 2. Where "48" comes from, and what the real truth is

Velxio's own `docs/THIRD_PARTY.md` (vendored at `external/velxio`) documents
**"Available Wokwi Components (48)"** — the DynamicComponent set: 4 boards,
6 sensors, 3 displays, 5 input, 5 output, 2 motors, 4 passive, and 19 "other".
That doc names 29 of them explicitly.

The prose is not machine-checkable, so the gate derives the truth from **code**:

1. `external/velxio/frontend/public/components-metadata.json` — 156 part ids,
   each with a `tagName`;
2. the pinned runtime element set — `@wokwi/elements@1.9.2` (extracted from the
   published tarball: 50 real tags after excluding the `wokwi-show-pins` docs
   helper) plus the locally defined `wokwi-capacitor`/`wokwi-inductor` and the
   `velxio-*` custom elements found by scanning the vendored frontend source —
   **91 runtime-definable tags**;
3. `frontend/src/simulation/parts/PartSimulationRegistry` — the `register(...)`
   calls that decide whether a part actually *behaves* (reacts to pins) rather
   than just rendering. 75 ids are registered.

Rule: `supported: true` is only claimed when Velxio **renders the element AND
registers behaviour** for it (the render-only set is limited to the SPICE
passives and the wiring medium: resistor, capacitor, capacitor-electrolytic,
inductor, breadboard, breadboard-mini).

37 of the 156 metadata ids are **not runtime-definable** in the pinned build
(batteries, BJTs, MOSFETs, diodes, op-amps, regulators, the 74HC series, power
supplies) — their metadata was generated from a newer element set than the
build ships. Claiming any of them would draw a part with no pins. None are
claimed.

## 3. The cross-check verdicts (all 95 parts)

### Fixed — the dishonest claim

| Part | Was | Now |
| --- | --- | --- |
| `ds18b20-temperature` | `supported: true`, `wokwi-ds18b20` | `supported: false` — Velxio has **no** DS18B20 element (absent from the pinned npm set, the metadata and the simulation registry; the exporter table already refused it). The old claim would have drawn a pinless part and silently dropped every wire. |

### Confirmed — wrongly pessimistic, now `supported: true` with verified parts

| Catalog part | Simulator part | Velxio model | What is honestly NOT modelled |
| --- | --- | --- | --- |
| `pir-sensor-hc-sr501` | `wokwi-pir-motion-sensor` | registered (OUT idles LOW, pulses on trigger) | sensitivity/delay pots, 30 s warm-up |
| `mpu6050-imu` | `wokwi-mpu6050` | registered (I2C registers, respects AD0) | XDA/XCL aux bus |
| `mq-2-gas-sensor` | `wokwi-gas-sensor` | registered (AOUT/DOUT vs configured level) | heater warm-up, 24–48 h burn-in |
| `ir-receiver-tsop38238` | `wokwi-ir-receiver` | registered (DATA idle HIGH, pulses LOW, paired remote) | carrier/AGC internals |
| `load-cell-hx711` | `wokwi-hx711` | registered (DT/SCK protocol, settable weight) | the bridge/load cell itself |
| `rgb-led-common-cathode` | `wokwi-rgb-led` | registered (digital + PWM per channel) | series resistors (wiring graph) |
| `joystick-module-2axis` | `wokwi-analog-joystick` | registered (HORZ/VERT/SEL) | dead-band spring physics |
| `rotary-encoder-ky040` | `wokwi-ky-040` | registered (real quadrature + SW) | contact bounce |
| `a4988-stepper-driver` | `wokwi-a4988` | registered (advances a paired stepper on STEP) | VREF trim, decay mode |
| `stepper-motor-nema17` | `wokwi-stepper-motor` | registered (step/dir rotation) | torque, inertia, stall |

### Deliberately NOT claimed (and why the note says so)

| Part | Reason |
| --- | --- |
| `relay-module-5v-1ch` | Velxio's relay model is a **bare** SPDT relay (COIL±/COM/NO/NC) with no VCC/GND/IN module pins — mapping the opto-isolated module onto it would fake its input stage. |
| `stepper-28byj48-uln2003` | Velxio's stepper is bipolar A+/A-/B+/B- step/dir; the BYJ-48 is unipolar IN1–IN4 through a ULN2003. Every coil would miswire. |
| `ldr-photoresistor` (bare cell) | The Velxio part is the 4-pin **module** (VCC/GND/DO/AO); the catalog entry is the bare 2-pin CdS cell — a lookalike substitution. The bare cell stays honest; the module shape is covered by other entries. |
| `dht11` | Only a DHT22 model exists; the protocols differ in scale/timing. |
| DC motors, fans, pumps, solenoids, BLDC/ESC, soil sensor, limit switch, IR obstacle, bh1750, ina219, bme280, HC-05/06, esp8266 | No element in the pinned build — unchanged, notes kept. |

### Added — members of the simulatable set that were missing from the catalog

| Catalog id | Simulator part | Notes |
| --- | --- | --- |
| `arduino-mega` | `wokwi-arduino-mega` → board `arduino-mega` | Full 75-pin entry (D0–D53, A0–A15, power) + a complete `mcu-profiles.ts` capability profile (4 UARTs, SPI 50–53, I2C 20/21, PWM 2–13/44–46, A8–A15 are ADC8–15 too). Velxio's `BoardKind` union has `arduino-mega`. |
| `lcd-2004-i2c` | `wokwi-lcd2004` | HD44780 over the emulated PCF8574 backpack; 20×4. |
| `seven-segment-1digit` | `wokwi-7segment` (attrs `digits:1`) | COM maps to COM.1; segments light from wired pins. |
| `led-bar-graph-10` | `wokwi-led-bar-graph` | 20 pins, all 10 segments independent. |
| `led-ring-ws2812-8` | `wokwi-led-ring` | 8 pixels, fully interactive (unlike the 1-pixel strip model). |
| `slide-potentiometer-10k` | `wokwi-slide-potentiometer` | WIPER→SIG. |
| `dip-switch-8` | `wokwi-dip-switch-8` | Poles 1A/1B…8B; side A is the sense side. |
| `ntc-thermistor-module` | `wokwi-ntc-temperature-sensor` | Single analog OUT. |
| `tilt-sensor-module` | `wokwi-tilt-switch` | Digital OUT, pulses while the ball rolls. |

Deliberately skipped (velxio-simulatable but out of the named-48 scope this
round, listed for the next batch): `ili9341` (SPI TFT), `neopixel-matrix`,
`gps-neo6m`, `ds3231`, biaxial stepper, IR remote (a handheld transmitter, not a
build component), nano-rp2040-connect, franzininho, rotary-dialer, sound/flame/
heart-beat sensors, logic gates / flip-flops / optocouplers / e-paper (breadboard
education parts, not project hardware).

## 4. The latent bug the new gate caught

`toggle-switch-spdt` had claimed `wokwi-slide-switch` since before this batch,
but the element names its poles **1/2/3** (2 = common) while the catalog says
COM/NO/NC. Every wire to a simulated slide switch was silently dropped on
Velxio import. `wokwi-membrane-keypad` and `wokwi-breadboard` were also
pass-throughs (warning noise). All three now have explicit pin maps, and the
end-to-end section of the gate makes a pass-through warning a failure.

## 5. Machinery added

| Path | What it is |
| --- | --- |
| `src/modules/simulation/velxio-parts.ts` | The static truth: `VELXIO_SIMULATED_METADATA_IDS` (75 registered ids), `VELXIO_RUNTIME_ONLY_REGISTERED_IDS` (registered but metadata-absent: custom chips, 74hc595, pcf8574, lcd2002, ili9341-cap-touch, raspberry-pi-3), `VELXIO_RENDER_ONLY_METADATA_IDS` (passives + breadboard), `VELXIO_NPM_ELEMENT_TAGS` (the pinned-build tag list: 50 from npm 1.9.2 + 2 locally defined, provenance-commented), and `checkSimulatorClaims()` used by the gate. |
| `scripts/verify-simulator-link.ts` | The gate: catalog claims → exporter tables → vendored metadata → runtime-definable tags → `BoardKind` union → simulation-registry cross-check (both directions) → **end-to-end projection** of a synthetic Mega + every supported peripheral with zero dropped parts/wires. Also prints an opportunities report (deliberate, not auto-applied). |
| `pnpm verify:simulator` | The script entry. |
| Pin maps in `diagram-generator/wokwi.ts` | `wokwi-analog-joystick`, `wokwi-gas-sensor`, `wokwi-ir-receiver`, `wokwi-hx711`, `wokwi-ky-040`, `wokwi-a4988`, `wokwi-stepper-motor`, `wokwi-ntc-temperature-sensor`, `wokwi-tilt-switch`, `wokwi-slide-potentiometer`, `wokwi-dip-switch-8`, `wokwi-7segment`, `wokwi-led-bar-graph`, `wokwi-led-ring`, `wokwi-microsd-card`, `wokwi-ds1307`, `wokwi-slide-switch`, `wokwi-membrane-keypad` + footprints. |
| Exporter tables in `velxio-project.ts` | `+ dip-switch-8, tilt-switch, ky-040` mappings; `BOARD_KIND_BY_CATALOG_ID['arduino-mega']`; both tables now `export`ed (the gate imports them). |
| Shims | `HX711.h`, `SD.h`, `RTClib.h`, `IRremote.hpp` in both `scripts/firmware-shim/` (compile gate) and `scripts/firmware-shim-runtime/` (behavioural runtime) — the repo rule "a declared library needs a shim header" is preserved for every flipped/added part. |
| README | Gate table row + the catalog table regenerated from the seed (was stale at 51 parts, now 95). |

## 6. How to extend (the next simulatable batch)

1. Pick a part from the opportunities report or the skip list above.
2. Verify against the vendored truth: element tag runtime-definable AND
   `register(...)` present (or explicitly render-only).
3. Catalog entry with pins that alias-match the element's real pins (extract
   them from the element source — never from memory), CAD comes free via the
   derived tier and `verify:cad-link` checks the anchors.
4. Pin map in `wokwi.ts` if names differ; exporter mapping if new; note what is
   NOT modelled.
5. Shim header for any declared library.
6. `pnpm verify:simulator && pnpm verify:cad-link && pnpm verify:contracts &&
   pnpm typecheck && pnpm build`.
7. If Velxio is ever updated, the gate's registry cross-check fails in both
   directions — resolve by updating `velxio-parts.ts` alongside the vendor bump.
