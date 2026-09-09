# Things only you can answer

**How to use this file.** Every question below has a **Default** — that is what
the build assumes if you never answer. So nothing blocks. Reply in chat
("Q3 = B"), or edit the `Answer:` line directly and commit it. I re-read this
file at the start of every increment.

Status legend: 🔴 open · 🟡 assumed default in use · 🟢 answered by you

---

## Tier 1 — changes the architecture if I guess wrong

### Q1. Which Pi? 🔴
The whole vision stack is chosen around this.

| Option | Notes |
| --- | --- |
| **A. Pi 4B 4 GB** | **Default.** ~10–15 FPS with YuNet+SFace at 640×480. Cheap, cool enough passively, USB-C 5 V/3 A. |
| B. Pi 5 (8 GB) | 2–3× faster, lets you run a bigger detector + anti-spoof together. Needs active cooling and a 5 V/5 A supply. |
| C. Zero 2 W | Cheap and tiny, but recognition drops to ~1–2 FPS [3](https://pyimagesearch.com/2018/06/25/raspberry-pi-face-recognition/). Only viable with the IMX500 AI Camera [5](https://www.raspberrypi.com/news/raspberry-pi-ai-camera-on-sale-now/). Not recommended for a door. |

`Answer: A (default)`

### Q2. Camera 🔴
| Option | Notes |
| --- | --- |
| **A. Camera Module 3** | **Default.** 12 MP, autofocus, 75° FOV, CSI. Works with `Picamera2`. |
| B. Camera Module 3 **NoIR** | Same, no IR filter. Pick this if the doorway is dark; pair with an IR LED ring. Low light is where accuracy actually dies [2](https://fast.io/resources/openclaw-raspberry-pi-facial-recognition-door-access-control-agent/). |
| C. Raspberry Pi AI Camera (IMX500) | Inference on the sensor, $70, frees the CPU entirely [5](https://www.raspberrypi.com/news/raspberry-pi-ai-camera-on-sale-now/). Best perf ceiling, more setup. |
| D. USB webcam | Simplest to wire, worst latency and enclosure options. |

`Answer: A (default)`

### Q3. Lock hardware 🔴
| Option | Notes |
| --- | --- |
| **A. 12 V solenoid bolt** | **Default.** Fail-**secure** (locked with no power). Switched by a logic-level MOSFET, low-side, with a flyback diode across the coil [3](https://www.reddit.com/r/AskElectronics/comments/76r4wi/solid_state_relay_or_mosfet_to_switch_12v_2a_load/). |
| B. Electric strike | Replaces the strike plate, needs door-frame surgery, but the door still opens with a key. |
| C. Servo-driven latch | Cheapest, slowest, easiest to force. |

`Answer: A (default)`

### Q4. Fail-secure or fail-safe? 🔴
What happens **when power dies**.

- **A. Fail-secure — door stays LOCKED.** **Default.** Better security. Bad if it's the only exit.
- B. Fail-safe — door UNLOCKS on power loss. Required by fire code in most jurisdictions for occupied buildings; in the UK a fail-secure latch pulls in extra safety mechanisms and battery backup measured in days [2](https://forums.raspberrypi.com/viewtopic.php?t=178939).

**If this is the only door into an occupied room, pick B.** I will not nag, but I will generate a hard warning into the instructions either way.

`Answer: A (default) — confirm it is not the sole means of egress`

---

## Tier 2 — I can build either way, tell me your taste

### Q5. Recognition stack 🟡
**Default: OpenCV YuNet (detect) + SFace (128-d embed), ONNX, via `opencv-contrib-python`.** dlib's `face_recognition` scores 99.38% on LFW but is not meaningfully more accurate than YuNet in practice and costs far more CPU [4](https://medium.com/pythons-gurus/what-is-the-best-face-detector-ab650d8c1225).

Match threshold default: **cosine distance < 0.40**, plus requiring the same face in **3 consecutive frames** before unlocking.

`Answer: default`

### Q6. Anti-spoofing level 🟡
A photo held up to the camera defeats a bare embedder.

- **A. Passive texture check** — LBP + Laplacian variance, ~5 ms. **Default.** [1](https://github.com/olekacak/Face-Recognition)
- B. **+ active blink** — Eye Aspect Ratio over 2 s. Adds friction, stops casual photo attacks. [1](https://github.com/olekacak/Face-Recognition)
- C. **+ MiniFASNet** — real model, ~37 ms, best of the cheap options. [3](https://github.com/Qengineering/Face-Recognition-Raspberry-Pi-64-bits)

`Answer: A (default), B toggled by config`

### Q7. Face database 🟡
**Default: SQLite at `/var/lib/facelock/faces.db`, encrypted embeddings, `journal_mode=WAL`.** Tables: `person`, `embedding`, `event` (audit log). SQLite is right for one door; say Postgres if you want several doors on one server.

`Answer: default`

### Q8. Network exposure 🟡
**Default: offline.** No inbound ports, no cloud. Local read-only web UI on `127.0.0.1` only, reachable via SSH tunnel. Enrollment happens over SSH with a script.

`Answer: default`

---

## Tier 3 — privacy & legal (you own this, I can only scaffold it)

### Q9. Biometric policy 🟡
Face embeddings are special-category data in most of the world. Defaults I'll generate unless told otherwise:
- written consent captured at enrollment (a `--consent` flag that logs who/when),
- **retention 90 days** after a person is removed, then hard delete,
- embeddings stored **encrypted at rest**, raw frames **never** written to disk,
- every access decision appended to an append-only audit log,
- a `forget --person X` command that actually deletes.

`Answer: default — review for your jurisdiction`

### Q10. Manual override 🔴
Every real install needs one. Options: hidden mechanical key, keypad PIN fallback, or a physical bypass button inside. **Default: keypad PIN fallback** (Wireup already has a PIN state machine I can port — see `src/modules/code-generator/behaviours/access-control.ts`).

`Answer: keypad PIN fallback (default)`

---

## Tier 4 — facts only your eyes and tape measure know

I will ask for these **at the moment I need them**, through the hands-and-legs
task queue (see `HANDS-AND-LEGS.md`), not upfront. But if you already know,
fill them in now and it saves a round trip:

| Fact | Why I need it | Value |
| --- | --- | --- |
| Mounting height & distance, camera → face | Lens FOV and detect-size thresholds | ? |
| Doorway lighting (bright / dim / backlit / night) | Decides NoIR + IR ring | ? |
| Door & frame material | Strike vs solenoid vs servo | ? |
| Is there mains power at the door? | Decides PoE/splitter/battery | ? |
| Existing 12 V wiring? | Solenoid supply route | ? |
| Number of people to enroll | DB sizing, threshold tuning | ? |
| Is this the only exit from the room? | Fail-secure legality (Q4) | ? |

---

## Tier 5 — procurement (I can't buy, you can)

Against the Q1–Q4 defaults:

- [ ] Raspberry Pi 4B (4 GB)
- [ ] Official Pi 5 V/3 A USB-C supply (**not** a phone charger — brownouts are the #1 cause of "works then doesn't")
- [ ] Camera Module 3 + CSI ribbon (**check ribbon length**, the 150 mm one is too short for most door frames)
- [ ] 32 GB+ A2 microSD (or Pi 4 + SSD for the write churn of the audit log)
- [ ] 12 V solenoid bolt
- [ ] 12 V / 2 A supply for the solenoid
- [ ] Logic-level N-MOSFET (IRLZ44N or AO3414/AO3422 class — must fully turn on at **3.3 V** gate [3](https://www.reddit.com/r/AskElectronics/comments/76r4wi/solid_state_relay_or_mosfet_to_switch_12v_2a_load/))
- [ ] Flyback diode (1N4007 or Schottky, across the coil — **not** in series [1](https://raspberrypi.stackexchange.com/questions/31388/cannot-open-12v-solenoid-valve))
- [ ] 10 kΩ gate pull-down + 220 Ω gate resistor
- [ ] Door reed switch (state feedback)
- [ ] Status LED + buzzer
- [ ] Keypad (Q10 fallback)
- [ ] Heatsink + fan (Pi 4B throttles at 80 °C in an enclosure)

---

## Changelog

- 2026-09-09 — file created, all defaults set from research. `MK` to confirm Tier 1.
