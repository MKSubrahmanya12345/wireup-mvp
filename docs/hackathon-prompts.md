# 50 Hackathon demo prompts for Wireup

Every prompt below only uses parts that exist in the bundled component catalog,
so each one should plan, wire and generate a complete `sketch.ino` +
`diagram.json` + instructions. Difficulty: 🟢 starter · 🟡 standard · 🔴 spicy
(power rails, multiple subsystems, or tricky logic).

Paste them as-is into the prompt box, or let participants riff on them.

---

## Smart home & city

1. 🟢 Smart dustbin — a servo opens the lid when I wave over the ultrasonic
   sensor, a red LED and buzzer warn when the bin is nearly full.
2. 🟢 Automatic plant waterer — read a soil moisture sensor and run a 5 V
   submersible pump through a relay when the soil dries out; LCD shows the
   moisture percentage.
3. 🟢 Smart street light — an LDR detects night-time and a PIR detects people;
   light the LED only when both are true.
4. 🟡 Bluetooth home automation — an HC-05 receives single-letter commands from
   a phone and toggles two relays (lamp + fan) and reports state back over
   serial.
5. 🔴 Gas leak safety station — an MQ-2 sensor sounds an active buzzer above a
   threshold, switches a 12 V exhaust fan via relay, and shows the reading on a
   1602 LCD.
6. 🟡 Climate-controlled fan — a DHT22 drives a 12 V PWM fan with a
   potentiometer-set target temperature; LCD shows measured vs target.
7. 🟡 Sunrise curtains — an LDR triggers a DC motor (with driver + limit
   switch as end stop) to open/close a curtain; a toggle switch overrides it
   manually.
8. 🟢 Smart doorbell — a pushbutton plays a two-tone melody on a passive buzzer
   and blinks a WS2812 LED ring while it rings.

## Security & access

9. 🟡 Keypad door lock — a 4x4 membrane keypad enters a code, a servo moves the
   bolt, the LCD shows LOCKED/OPEN/DENIED and a buzzer chirps on each keypress.
10. 🟢 Motion alarm — a PIR triggers an active buzzer and alternating red/blue
    LEDs; a toggle switch arms and disarms the system.
11. 🟢 Bag or bike shake alarm — a tilt sensor plus vibration motor and buzzer
    go off when the bag is moved; a hidden pushbutton silences it.
12. 🟡 People counter — two IR obstacle sensors across a doorway count people
    in and out and a 2004 LCD shows occupancy.
13. 🟡 Universal remote switch — an IR receiver (TSOP38238) learns buttons from
    any TV remote and toggles two relays; feedback on a 1602 LCD.
14. 🟢 Door-left-open alarm — a limit switch on the frame beeps and counts how
    many seconds the door has been open on an LCD.

## Weather & environment

15. 🟡 Desk weather station — a DHT22 plus BME280 feed an SSD1306 OLED with
    temperature, humidity and pressure, refreshed every 2 seconds.
16. 🟡 Air quality monitor — an MQ-2 with threshold alarms on a buzzer and an
    OLED showing live ppm; a pushbutton mutes the alarm for 60 s.
17. 🔴 Mini greenhouse controller — BME280 + soil moisture + a pump + an
    exhaust fan, all coordinated with hysteresis and a 2004 LCD dashboard.
18. 🟢 Light logger — a BH1750 lux sensor on an OLED with three LEDs marking
    dark / indoor / bright bands.
19. 🔴 Water tank level gauge — an HC-SR04 looks down into the tank, a 10-bar
    LED graph shows the level, and a relay + pump auto-refill above/below two
    thresholds.

## Agriculture, food & lab

20. 🟡 Automatic fish feeder — an RTC DS3231 rotates a servo feeder twice a
    day; a pushbutton feeds manually and an LCD shows the next feeding time.
21. 🔴 Egg incubator — a DHT22 + relay-driven lamp heater + 12 V fan hold
    37.5 °C; LCD shows the setpoint and a buzzer alarms when out of range.
22. 🟡 Portion-control pet feeder — a keypad selects a small/medium/large
    portion, a servo dispenses it, and a countdown to the next meal shows on
    the LCD.
23. 🔴 Fertilizer dosing station — an RTC triggers a 12 V peristaltic pump
    three times a day; the OLED logs the last and next dose times.
24. 🟡 Battery lab bench — an INA219 measures volts/amps/watts of a project
    running off a 2S LiPo through a buck converter; OLED shows live readings.

## Robotics & vehicles

25. 🟡 Bluetooth RC car — two DC motors on an L298N driven over HC-05; the
    transmitter side is a second Arduino with a joystick module.
26. 🟡 Obstacle-avoiding robot — an HC-SR04 mounted on a sweeping servo looks
    left/right and an L298N drives two DC motors around obstacles.
27. 🔴 Line follower — three IR obstacle sensors, a DRV8833 and N20 encoder
    motors; an OLED displays live speed from the encoders.
28. 🔴 4-servo robotic arm — two 2-axis joysticks + a PCA9685 servo driver move
    the arm, a pushbutton opens/closes the gripper, MG996R carries the elbow.
29. 🟡 Pan-tilt camera mount — two servos aimed by two potentiometers, with
    limit switches as soft end stops.
30. 🔴 Motorized camera slider — a NEMA17 on an A4988, slide potentiometer for
    speed, a limit switch to home the carriage, and a pushbutton to start a
    pass.
31. 🟡 Railway crossing — an IR sensor "sees" the train, a servo drops the
    barrier, red LEDs alternate and a buzzer sounds until it passes.
32. 🟢 Garage parking assistant — an HC-SR04 measures distance to the wall;
    green/yellow/red LEDs light in sequence and the buzzer pitch rises as you
    approach.
33. 🔴 Mini parking gate — a servo barrier plus IR entry/exit sensors keep
    count of free slots on a 7-segment display; full lot = barrier stays down.
34. 🟡 Elevator prototype — a 28BYJ-48 stepper moves the "cab" between three
    floors with limit-switch detection, a keypad picks the floor and a 7-segment
    shows where it is.

## Health & wearables

35. 🟡 Fall detector — an MPU6050 spots a sudden free-fall/impact, sounds a
    buzzer and blinks red; a pushbutton cancels a false alarm within 5 s.
36. 🟢 Posture buddy — an MPU6050 strapped to the back runs a vibration coin
    motor after 10 seconds of slouching.
37. 🟢 Touchless sanitizer dispenser — an HC-SR04 detects a hand and a servo
    (or 5 V pump) presses out one dose; LCD counts dispenses today.
38. 🟡 Medicine reminder — an RTC + buzzer + blinking LED at programmed times;
    a pushbutton acknowledges and the LCD shows the next dose.
39. 🟡 Step counter — an MPU6050 counts steps onto an OLED; hitting the daily
    goal lights up a WS2812 ring celebration.
40. 🟢 Bike turn signals — two pushbuttons flash left/right WS2812B strip
    segments with buzzer ticks; a third button does an emergency-hazard mode.

## Games & fun

41. 🟢 Reaction duel — a random LED, first player to slap their pushbutton
    wins; a 7-segment and LCD keep score across rounds.
42. 🟡 Simon Says — four LEDs, four pushbuttons, passive buzzer tones, level
    number on the LCD.
43. 🔴 Snake on a matrix — joystick plays Snake on an 8x8 WS2812 matrix; the
    LCD shows score and high score.
44. 🟢 DIY piano — a 4x4 keypad maps to notes on a passive buzzer; an OLED
    displays the note names as you play.
45. 🟢 Electronic dice — a pushbutton "rolls", the 1-digit 7-segment cycles
    randomly and settles on 1–6.
46. 🟡 Mood lamp — a WS2812B strip with a potentiometer for brightness, a slide
    pot for hue, and a toggle switch to flip between solid/fade/rainbow modes.
47. 🟡 Whack-a-mole — four LEDs pop up at random, hit the matching pushbutton
    before the timeout; LCD score, buzzer on miss.

## IoT & cameras

48. 🟡 WiFi weather tile — an ESP32 pulls temperature/humidity from a BME280
    and renders it on an OLED; a blue LED flag when humidity crosses 70 %.
49. 🔴 Motion photo trap — a Raspberry Pi 5 with the camera module saves a
    photo when a PIR fires; a USB webcam covers a second angle and an LED shows
    armed status.
50. 🟡 GPS speed alarm — a NEO-6M module shows speed and satellites on an OLED;
    past a set speed a buzzer and red LED warn the driver.

---

### Tips for a good demo prompt

* **Name concrete parts** ("HC-SR04", "L298N", "MG996R") — the planner matches
  the catalog better and judges can see real hardware reasoning.
* **State the behavior**, not just the parts: thresholds, what triggers what,
  and what the display should show.
* **Mention power** when it matters (12 V actuators, servos, pumps) so the
  power budget has something interesting to do.
* Riffs are fine: "same dustbin but with a WS2812 ring instead of an LED" or
  "make it battery powered with a 9 V block" — every change should land as a
  targeted revision, not a rebuild.
