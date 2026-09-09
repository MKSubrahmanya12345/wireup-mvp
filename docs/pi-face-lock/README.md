# Pi face-detector lock — master plan

**The prompt this has to work for:**

> using raspberry pi we need to make an external camera detect and store face
> data in a db and then it works as a face detector lock

**Verdict (2026-09-09):** Wireup cannot do this today, and not for one reason.
It emits *Arduino C++ firmware for one of three microcontrollers*, from a
51-part catalog. This project is a **Linux host + vision pipeline + persistent
data + physical actuator** system. Different artifact class.

This directory is the plan for closing that gap, plus the record of what has
been built.

---

## 1. Why today's pipeline silently fails on this prompt

Traced through the actual code:

| Stage | What happens | File |
| --- | --- | --- |
| Understanding | `PLATFORM_RULES` knows esp32/uno/nano/esp8266/rp2040/stm32. "raspberry pi" matches **nothing** (the rp2040 rule needs "pi **pico**") → no platform hint → model picks an ESP32. | `src/modules/project-understanding/heuristics.ts:71` |
| Components | `matchComponentStrict` (min score 55) has no Pi, no camera, no solenoid → `unknown_component` / `invented_component` → fixer substitutes closest real part (Pi→ESP32, solenoid→5 V relay) and the camera is dropped as `requirement_uncovered`. | `src/modules/components/service.ts:181` |
| Pin planning | 3 MCU profiles, no 40-pin Pi header, no CSI connector. | `src/modules/pin-planner/mcu-profiles.ts` |
| Codegen | every path emits `sketch.ino` with `void setup()`/`void loop()`/`#include <Arduino.h>`. | `src/modules/code-generator/templates.ts:655`, `rooting.ts:417` |
| Validation | `code_missing_setup_loop`, `code_unbalanced_braces` are Arduino-shaped; the compile gate is g++ against a stub Arduino core. | `src/modules/validator/rules.ts` |
| Simulation | 10 Wokwi boards, no Pi. | `src/modules/simulation/velxio-project.ts:103` |

The dangerous part: it does not error. It produces a clean, validated,
complete **ESP32 + relay** project that has nothing to do with the request.

---

## 2. Target architecture

Six layers. Only the bottom two exist today.

```
L6  HUMAN LOOP      hands & legs: ask / do / observe / verify   ← the agent's
                    only way to touch reality                      physical I/O
L5  DATA            persons, embeddings, audit log, retention
L4  VISION          capture → detect → embed → match → liveness
L3  RUNTIME         Linux host app: venv, systemd, config, logs  ← NEW concept
L2  FIRMWARE/IO     GPIO actuator driver, door state, LED/buzzer
L1  HARDWARE        SBC + camera + lock + power + safety         ← this increment
```

L1 is being built first because L3–L6 all read the catalog and the pin plan;
getting the ground truth wrong poisons everything above it.

---

## 3. Research findings (these drive the defaults)

**Vision stack.** dlib's `face_recognition` scores 99.38% on LFW and ~95%+ in
real doorway conditions, but only reaches 1–2 FPS on a Pi with the classic
OpenCV pipeline [3](https://pyimagesearch.com/2018/06/25/raspberry-pi-face-recognition/),
and YuNet matches dlib closely enough on accuracy that dlib's far higher
processing time is hard to justify [4](https://medium.com/pythons-gurus/what-is-the-best-face-detector-ab650d8c1225).
Resolution is the dominant FPS knob — one project went 0.5 → 5 FPS purely by
scaling the frame [1](https://core-electronics.com.au/guides/face-recognition-with-raspberry-pi-and-opencv/).
→ **Default: OpenCV YuNet + SFace.** (`HUMAN-INPUT.md` Q5)

**Low light, not model choice, is what breaks accuracy.** Pairing a Pi NoIR
camera with IR LED illumination is recommended for 24-hour operation
[2](https://fast.io/resources/openclaw-raspberry-pi-facial-recognition-door-access-control-agent/).
→ offered as Q2 option B.

**Anti-spoofing is not optional for a lock.** Cheap passive texture analysis
(LBP + Laplacian variance) is ~5 ms; a real MiniFASNet model costs ~37 ms
[3](https://github.com/Qengineering/Face-Recognition-Raspberry-Pi-64-bits).
Eye Aspect Ratio blink detection is the cheap active option
[1](https://github.com/olekacak/Face-Recognition).
→ **Default: passive, blink toggleable.** (Q6)

**On-sensor inference is a real escape hatch.** The IMX500 AI Camera runs models
on the sensor for $70, leaving the Pi CPU free
[5](https://www.raspberrypi.com/news/raspberry-pi-ai-camera-on-sale-now/).
→ in the catalog as an option.

**Lock driving.** Switch the solenoid low-side with a logic-level MOSFET
(IRLZ44N / AO3414-class — it must saturate at a **3.3 V** gate, which is the
usual way this circuit fails), gate resistor, 10 kΩ gate pull-down, flyback
diode **anti-parallel across the coil** (a diode in series is a common and
confusing mistake [1](https://raspberrypi.stackexchange.com/questions/31388/cannot-open-12v-solenoid-valve)),
and a **common ground** between the Pi and the 12 V supply — no common ground
is the single most frequent "the transistor won't switch" cause
[4](https://forums.raspberrypi.com/viewtopic.php?t=75057). Never fit the diode
on an AC supply [2](https://forums.raspberrypi.com/viewtopic.php?t=178939).
→ baked into the `solenoid-lock-12v` + `mosfet-low-side-driver` catalog entries.

**Fail-secure has legal teeth.** UK guidance suggests a fail-secure latch pulls
in extra safety mechanisms and battery backup measured in days, and regulation
depends on the building type [2](https://forums.raspberrypi.com/viewtopic.php?t=178939).
→ surfaced as a blocking question (Q4) plus a generated warning.

---

## 4. Roadmap

| # | Increment | Status |
| --- | --- | --- |
| 1 | **SBC ground truth** — Pi/camera/lock/PSU catalog entries, 40-pin host profile, platform heuristics, offline proof (`npm run verify:sbc`, 64 checks) | ✅ done |
| 2 | **Hands & legs** — human task protocol, commissioning planner, API, UI tab, orchestrator wiring, offline proof (`npm run verify:human`, 44 checks) | ✅ done |
| 1.5 | **Host interface routing + multi-rail power** — CSI/USB pins routed to connectors not GPIO; the solenoid lands on a real 12 V rail | ⬜ next (both are printed as `GAP` by the verify script today) |
| 3 | **Runtime concept** — `runtime` on the project (mcu-firmware vs linux-app), Python codegen path, venv/systemd/config artifacts | ⬜ |
| 4 | **Data layer** — data-model artifact, schema + migrations, retention/consent | ⬜ |
| 5 | **Vision pipeline plan** — detector/embedder/threshold/liveness as planned, configurable artifacts | ⬜ |
| 6 | **Security semantics** — port `access-control` state machine to Python, fail-secure, lockout, audit log, behaviour-evaluator assertions | ⬜ |
| 7 | **Commissioning loop** — the agent drives real bring-up through L6 tasks end to end | ⬜ |

---

## 5. Design decisions (and why)

**SBCs live in the `microcontroller` catalog category, with `metadata.kind = 'sbc'`.**
Every controller-ish code path (`profilesForSelections`, hardware defaults,
power budgeting, wiring conflicts, simulation) already keys on
`category === 'microcontroller'` in ~20 places. A separate `sbc` category would
mean 20 edits and a real chance of silently breaking existing projects. The
category means *"the thing being programmed"*; `metadata.kind` distinguishes
an SBC from an MCU, and the new runtime layer (increment 3) reads that.
Revisit if it starts to hurt.

**Cameras are `sensor` category with `metadata.kind = 'camera'`.** Same
reasoning — the power planner already budgets sensors onto the logic rail.

**Nothing in the catalog invents a capability it doesn't have.** The Pi profile
has no ADC (true — the 40-pin header has none), so any plan needing analog
fails loudly instead of silently assigning "A0".

---

## 6. Files

| File | What |
| --- | --- |
| `HUMAN-INPUT.md` | **Start here.** Every decision, with the default I'm building to. |
| `HANDS-AND-LEGS.md` | The human-as-a-tool protocol: how the agent uses your hands, eyes and legs. |
| `README.md` | This file. |
