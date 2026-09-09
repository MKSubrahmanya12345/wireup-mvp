/**
 * Commissioning plan — turning a finished hardware plan into the list of
 * things only a human can do.
 *
 * `instructions.md` is a static document emitted at the end. This is different:
 * it is a stateful, ordered queue whose results come back as facts. Every task
 * states why the agent cannot do it and what the agent will do with the answer,
 * and every task carries a default so the queue can never deadlock on silence.
 */

import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';

import type { HumanTask } from './types';

export interface CommissioningInput {
  components: ComponentSelection[];
  catalog: ComponentDefinition[];
  pinAssignments: PinAssignment[];
}

interface Draft {
  verb: HumanTask['verb'];
  title: string;
  why: string;
  thenWhat: string;
  steps?: string[];
  command?: string;
  answer: HumanTask['answer'];
  default?: string | number | boolean;
  risk?: HumanTask['risk'];
  hazard?: string;
  blocking?: boolean;
  dependsOn?: string[];
  fact?: string;
  group: string;
}

const SBC_IDS = new Set(['raspberry-pi-4b', 'raspberry-pi-5', 'raspberry-pi-zero-2-w']);
const CSI_CAMERA_IDS = new Set(['pi-camera-module-3', 'raspberry-pi-ai-camera']);
const USB_CAMERA_IDS = new Set(['usb-webcam-1080p']);
const LOCK_IDS = new Set(['solenoid-lock-12v']);
const DRIVER_IDS = new Set(['mosfet-low-side-driver']);

function build(drafts: Draft[]): HumanTask[] {
  const now = new Date().toISOString();
  return drafts.map((draft, index) => ({
    id: `t${String(index + 1).padStart(2, '0')}`,
    order: index + 1,
    verb: draft.verb,
    title: draft.title,
    why: draft.why,
    thenWhat: draft.thenWhat,
    ...(draft.steps ? { steps: draft.steps } : {}),
    ...(draft.command ? { command: draft.command } : {}),
    answer: draft.answer,
    ...(draft.default !== undefined ? { default: draft.default } : {}),
    risk: draft.risk ?? 'none',
    ...(draft.hazard ? { hazard: draft.hazard } : {}),
    blocking: draft.blocking ?? false,
    ...(draft.dependsOn ? { dependsOn: draft.dependsOn } : {}),
    ...(draft.fact ? { fact: draft.fact } : {}),
    group: draft.group,
    status: 'open' as const,
    createdAt: now,
  }));
}

/**
 * Derive the commissioning queue for a project.
 *
 * Ordered so that cheap, reversible questions come first and anything
 * destructive or mains-powered comes last — the human should never reach step 9
 * before the design decisions in step 1 are settled.
 */
export function planCommissioning(input: CommissioningInput): HumanTask[] {
  const { catalog, components, pinAssignments } = input;
  const ids = new Set(components.map((selection) => selection.componentId));
  const definitionOf = (id: string): ComponentDefinition | undefined => catalog.find((entry) => entry.id === id);

  const hasSbc = [...SBC_IDS].some((id) => ids.has(id));
  const sbc = [...SBC_IDS].map(definitionOf).find((entry): entry is ComponentDefinition => Boolean(entry));
  const csiCamera = [...CSI_CAMERA_IDS].find((id) => ids.has(id));
  const usbCamera = [...USB_CAMERA_IDS].find((id) => ids.has(id));
  const camera = csiCamera ?? usbCamera;
  const hasLock = [...LOCK_IDS].some((id) => ids.has(id));
  const driver = [...DRIVER_IDS].find((id) => ids.has(id));
  const hasReed = ids.has('door-reed-switch');
  const hasKeypad = ids.has('membrane-keypad-4x4');
  const hasMainsPsu = [...ids].some((id) => definitionOf(id)?.metadata.mains === true);

  const gateAssignment = pinAssignments.find((entry) => entry.targetComponentId === driver);
  const gatePin = gateAssignment?.pin ?? 'the assigned GPIO';
  const drafts: Draft[] = [];

  // ---------------------------------------------------------------- decisions

  if (hasSbc) {
    drafts.push({
      verb: 'ask',
      title: 'Which Pi and camera are you actually building with?',
      why: 'The prompt did not say, and the difference changes the capture stack, the ribbon cable and the frame rate budget.',
      thenWhat: 'I will pin the BOM to those parts and generate the matching capture configuration.',
      answer: {
        kind: 'choice',
        options: [
          { value: 'pi4+cam3', label: 'Pi 4B + Camera Module 3', note: 'Default. ~10-15 FPS at 640x480 with YuNet+SFace.' },
          { value: 'pi5+cam3', label: 'Pi 5 + Camera Module 3', note: '2-3x faster, needs active cooling and a 5 A supply.' },
          { value: 'zero2+aicam', label: 'Pi Zero 2 W + AI Camera (IMX500)', note: 'On-sensor inference; the only way a Zero is responsive.' },
          { value: 'pi4+webcam', label: 'Pi 4B + USB webcam', note: 'Easiest to wire, highest latency, hardest to mount flush.' },
        ],
      },
      default: 'pi4+cam3',
      blocking: true,
      fact: 'hw.variant',
      group: 'decisions',
    });
  }

  if (hasLock) {
    drafts.push({
      verb: 'ask',
      title: 'Is this door the only way in or out of an occupied room?',
      why: 'A fail-secure bolt stays locked when power dies. That is correct for a cupboard and a serious problem for a sole exit.',
      thenWhat: 'If yes I switch the actuator recommendation to fail-safe and add a mechanical override to the BOM and the build guide.',
      answer: { kind: 'choice', options: [
        { value: 'no', label: 'No — there is another way out', note: 'Fail-secure is fine.' },
        { value: 'yes', label: 'Yes — it is the only exit', note: 'I will switch to fail-safe and add an override.' },
        { value: 'unsure', label: 'Not sure', note: 'I will design for fail-safe and flag it for review.' },
      ] },
      default: 'no',
      blocking: true,
      fact: 'safety.sole_egress',
      group: 'decisions',
    });
  }

  // ------------------------------------------------------------- procurement

  const ribbonNote = definitionOf(csiCamera ?? '')?.metadata.ribbon;
  if (csiCamera && typeof ribbonNote === 'string') {
    drafts.push({
      verb: 'do',
      title: 'Order the right CSI ribbon length',
      why: 'I cannot see your door frame. The 150 mm ribbon in the box is too short for most installations and people discover this after mounting everything.',
      thenWhat: 'Nothing downstream — this is purely to stop you discovering it at step 11.',
      steps: [
        'Measure the cable run from the Pi enclosure to where the camera will sit.',
        'Order the 300 mm or 500 mm ribbon to match, with 50 mm of slack.',
      ],
      answer: { kind: 'text', placeholder: 'e.g. 400 mm run, ordered the 500 mm ribbon', expect: 'a length, or "already have one"' },
      default: 'already have a suitable ribbon',
      fact: 'procurement.ribbon',
      group: 'procurement',
    });
  }

  // ------------------------------------------------------------------ bringup

  if (sbc) {
    drafts.push({
      verb: 'do',
      title: `Flash ${sbc.name} with Raspberry Pi OS Lite 64-bit and reach it over SSH`,
      why: 'I have no way to write an SD card or to know your network. Until the board is reachable, nothing I generate can be run.',
      thenWhat: 'I will use the OS version you report to pick the camera stack (libcamera is the only supported stack on current releases).',
      steps: [
        'Image a 32 GB+ A2 microSD with Raspberry Pi OS Lite (64-bit) using Raspberry Pi Imager, with SSH enabled and your Wi-Fi or Ethernet preconfigured.',
        'Boot it, find it on the network, and log in.',
      ],
      command: 'ssh pi@raspberrypi.local',
      answer: { kind: 'boolean', expect: 'you get a shell prompt' },
      default: false,
      blocking: true,
      fact: 'host.reachable',
      group: 'bringup',
    });

    drafts.push({
      verb: 'observe',
      title: 'Report the OS release and the Python version',
      why: 'I cannot read your board. The camera stack and the pip packages depend on both.',
      thenWhat: 'I will pin the dependency set to what your OS actually ships.',
      command: 'cat /etc/os-release | head -3; python3 --version; uname -m',
      answer: { kind: 'terminal', expect: 'a Debian version line, "Python 3.11.x" (or newer) and "aarch64"' },
      default: 'Bookworm 64-bit, Python 3.11, aarch64',
      fact: 'host.os',
      group: 'bringup',
    });

    drafts.push({
      verb: 'do',
      title: 'Install the camera and vision dependencies',
      why: 'I cannot run apt or pip on your machine, and I will not claim a package works on a version I have not seen.',
      thenWhat: 'I generate the capture and recognition code against exactly these libraries.',
      command:
        camera && USB_CAMERA_IDS.has(camera)
          ? 'sudo apt update && sudo apt install -y python3-opencv python3-pip && pip install --break-system-packages numpy'
          : 'sudo apt update && sudo apt install -y python3-picamera2 python3-opencv python3-gpiozero && pip install --break-system-packages numpy imutils',
      answer: { kind: 'terminal', expect: 'no error lines; a final package summary' },
      default: 'installed',
      risk: 'caution',
      hazard: 'Installs system packages. Do this before you start editing configuration files.',
      fact: 'host.deps',
      group: 'bringup',
    });
  }

  // ------------------------------------------------------------------- camera

  if (camera) {
    const isCsi = CSI_CAMERA_IDS.has(camera);
    drafts.push({
      verb: 'observe',
      title: 'Confirm the camera is detected and report the sensor',
      why: 'Detection depends on the exact sensor. Guessing "some IMX" produces a capture config that silently streams at the wrong resolution.',
      thenWhat: `I generate the capture configuration for that specific sensor rather than a generic ${isCsi ? 'V4L2' : 'CSI'} path.`,
      command: isCsi ? 'libcamera-hello --list-cameras' : 'v4l2-ctl --list-devices && v4l2-ctl -d /dev/video0 --list-formats-ext',
      answer: {
        kind: 'terminal',
        expect: isCsi
          ? 'a line like "0 : imx708 [4608x2592]" — if it prints "No cameras available!" the ribbon is seated wrong, stop and tell me'
          : 'a device path plus a list of supported formats',
      },
      default: 'imx708',
      fact: 'camera.detected',
      group: 'bringup',
    });

    drafts.push({
      verb: 'verify',
      title: 'Grab one frame and confirm it is not black',
      why: 'A camera can be detected and still stream black frames — a lens cap, a ribbon seated one pin off, or a NoIR module in the dark.',
      thenWhat: 'If it fails I move to debug steps (exposure, ribbon reseat) instead of blaming the model.',
      command: isCsi
        ? 'libcamera-still -o /tmp/test.jpg --width 640 --height 480 && python3 -c "import cv2;print(cv2.imread(\'/tmp/test.jpg\').mean())"'
        : 'python3 -c "import cv2;c=cv2.VideoCapture(0);ok,f=c.read();print(ok, f.mean())"',
      answer: { kind: 'boolean', passWhen: 'the printed mean brightness is above 10 (a black frame prints ~0)' },
      default: false,
      fact: 'camera.streams',
      group: 'bringup',
    });
  }

  // -------------------------------------------------------------- bench wiring

  if (hasLock && driver) {
    const driverMeta = definitionOf(driver)?.metadata;
    const benchSteps = Array.isArray(driverMeta?.testSequence) ? (driverMeta?.testSequence as string[]) : [];
    drafts.push({
      verb: 'do',
      title: 'Bench-test the solenoid at 12 V before the Pi is involved',
      why: 'I cannot power your solenoid. Testing the load in isolation means a failure here can only be the solenoid or the supply, not the Pi, the code or the wiring.',
      thenWhat: 'A pass lets me attribute any later failure to the driver stage, not the load.',
      steps: [
        'Disconnect the Pi entirely from the circuit.',
        'Connect the solenoid straight across the 12 V supply and confirm the bolt moves.',
        'Fit the flyback diode ANTI-PARALLEL across the coil (cathode to +12 V). A diode in series is a short to nothing and the bolt will not move.',
        'Wire the MOSFET in series on the low side (drain to the solenoid negative, source to ground) and confirm it still moves.',
        ...benchSteps.filter((step) => typeof step === 'string' && !/^(leave|only then)/i.test(step)),
      ],
      answer: { kind: 'boolean', expect: 'the bolt retracts and springs back' },
      default: false,
      risk: 'caution',
      hazard: '12 V at ~1-2 A. Keep the supply current-limited on first test and do not hold the bolt energised for more than a few seconds.',
      fact: 'bench.lock_moves',
      group: 'wiring',
    });

    drafts.push({
      verb: 'observe',
      title: `Measure the gate voltage at ${gatePin} while driven high`,
      why: 'A multimeter is the only way to know whether a 3.3 V logic pin fully enhances your particular MOSFET. Datasheet thresholds are specified at currents you will not be at.',
      thenWhat: 'If it is under ~2.5 V the MOSFET is not a logic-level part and I swap it in the BOM rather than shipping a lock that half-opens and cooks the transistor.',
      steps: [
        'Tie the Pi ground and the 12 V supply ground together. Without a common ground nothing switches — this is the single most common failure.',
        'Drive the GPIO high from software, then measure gate-to-ground.',
      ],
      command: 'python3 -c "from gpiozero import OutputDevice; import time; d=OutputDevice(\'GPIO17\'); d.on(); time.sleep(10)"',
      answer: { kind: 'measurement', unit: 'V', expect: '3.0-3.3 V. Under 2.5 V means the MOSFET is not logic level.' },
      default: 3.3,
      risk: 'caution',
      fact: 'gpio.drive_voltage',
      group: 'wiring',
    });

    drafts.push({
      verb: 'verify',
      title: 'Drive the GPIO and confirm the bolt retracts',
      why: 'This closes the whole actuator chain: code → GPIO → gate → MOSFET → coil → bolt. No simulation can tell me it worked.',
      thenWhat: 'A pass unlocks the install stage. A failure re-plans the driver stage with your measurement as evidence.',
      command: 'python3 -c "from gpiozero import OutputDevice; import time; d=OutputDevice(\'GPIO17\'); d.on(); time.sleep(2); d.off()"',
      answer: { kind: 'boolean', passWhen: 'the bolt retracts for 2 s and springs back' },
      default: false,
      fact: 'gpio.lock_actuates',
      group: 'wiring',
    });
  }

  if (hasReed) {
    drafts.push({
      verb: 'verify',
      title: 'Confirm the door contact reads open and closed correctly',
      why: 'I cannot open your door. Without this the system can only assume it closed.',
      thenWhat: 'Enables "unlocked but never opened" and "opened without unlocking" detection in the firmware.',
      command: 'python3 -c "from gpiozero import Button; import time; s=Button(27, pull_up=True); print(s.is_pressed); time.sleep(5); print(s.is_pressed)"',
      answer: { kind: 'boolean', passWhen: 'the two printed values differ when you open and close the door' },
      default: false,
      fact: 'door.sensor_reads',
      group: 'wiring',
    });
  }

  // ------------------------------------------------------------------- install

  if (camera && hasLock) {
    drafts.push({
      verb: 'observe',
      title: 'Mount the camera and measure the install geometry',
      why: 'I cannot see your doorway. Detection size thresholds and lens choice fall straight out of these numbers.',
      thenWhat: 'I compute the minimum face size for the detector and tell you if the field of view cannot cover the approach.',
      steps: [
        'Mount the camera, then stand where a user would stand to unlock.',
        'Measure the camera height, and the distance from the lens to your face.',
        'Note the lighting: is the door backlit, dim, or outdoors?',
      ],
      answer: { kind: 'measurement', unit: 'mm', expect: 'height and distance, e.g. "1520 mm high, 700 mm away, indoor corridor, backlit"' },
      default: '1520 mm high, 700 mm away, indoor, evenly lit',
      fact: 'install.geometry',
      group: 'install',
    });
  }

  // -------------------------------------------------------------------- vision

  if (camera) {
    drafts.push({
      verb: 'observe',
      title: 'Stand at the door and report the live detection stats',
      why: 'Frame rate and detected face size at your real mounting position are the only numbers that matter. Benchmark numbers from someone else bench are not evidence.',
      thenWhat: 'I tune the capture resolution, the detector input size and the frame skip to hit a responsive lock without dropping below your detection distance.',
      command: 'facelock probe --frames 60',
      answer: { kind: 'terminal', expect: 'an fps number and a detected face box size in pixels, e.g. "12.4 fps, face 96x96 px"' },
      default: '10 fps, face 96x96 px',
      fact: 'vision.fps',
      group: 'vision',
    });
  }

  // ---------------------------------------------------------------- enrollment

  drafts.push({
    verb: 'do',
    title: 'Enroll each person who needs access',
    why: 'I have no camera and no idea who should be allowed in. Enrollment is inherently a physical, consensual act.',
    thenWhat: 'Each enrollment writes a person plus embeddings into the face database and logs consent.',
    steps: [
      'Run the enrollment command once per person, using their name.',
      'Have them move their head slowly through about 10 samples — front, left, right, slight up and down.',
      'Enroll the lighting conditions you actually have, not studio light.',
    ],
    command: 'facelock enroll --name "Ada Lovelace" --samples 10 --consent',
    answer: { kind: 'number', expect: 'the number of people enrolled' },
    default: 1,
    risk: 'caution',
    hazard: 'Biometric data. Capture written consent and tell each person what is stored and how to have it deleted.',
    fact: 'enroll.count',
    group: 'enrollment',
  });

  drafts.push({
    verb: 'verify',
    title: 'Hold up a photo of an enrolled face and confirm it is rejected',
    why: 'The cheapest attack on a face lock is a phone screen. If this passes, the lock is decorative.',
    thenWhat: 'A pass closes the anti-spoofing requirement. A fail upgrades the liveness check, with your result as the evidence.',
    answer: { kind: 'boolean', passWhen: 'the door stays locked and the attempt is logged as a rejected spoof' },
    default: false,
    fact: 'spoof.photo_rejected',
    group: 'security',
  });

  // ------------------------------------------------------------------ security

  drafts.push({
    verb: 'verify',
    title: 'An enrolled person unlocks the door within 2 seconds',
    why: 'End-to-end latency is the difference between a lock people use and a lock people prop open. I cannot time it.',
    thenWhat: 'A pass confirms the whole pipeline. A fail sends me back to the vision tuning stage with real numbers.',
    answer: { kind: 'boolean', passWhen: 'the bolt retracts within about 2 s of the person presenting' },
    default: false,
    fact: 'e2e.unlocks',
    group: 'security',
  });

  drafts.push({
    verb: 'verify',
    title: 'An unknown person is refused and the attempt is logged',
    why: 'Deny-by-default is the security property that matters, and only a real stranger can test it.',
    thenWhat: 'A pass confirms the default-deny path and the audit log. A fail raises a blocking security issue, not a warning.',
    answer: { kind: 'boolean', passWhen: 'the door stays locked and an event appears in the audit log' },
    default: false,
    fact: 'e2e.denies',
    group: 'security',
  });

  if (hasLock) {
    drafts.push({
      verb: 'observe',
      title: 'Pull the power and report what the door does',
      why: 'The one test no generated README has ever asked, and the one where a wrong answer means somebody gets trapped.',
      thenWhat: 'I record the real fail-state in the build guide. If it contradicts the catalog I raise a validation issue instead of quietly overwriting it.',
      steps: [
        'Stand on the safe side of the door, or hold it open.',
        'Remove power from the Pi.',
        'Report whether the door ends up locked or unlocked.',
      ],
      answer: { kind: 'choice', options: [
        { value: 'locked', label: 'Stays locked (fail-secure)', note: 'Matches the catalog. Correct for a cupboard or a secondary door.' },
        { value: 'unlocked', label: 'Unlocks (fail-safe)', note: 'Required where the door is a fire exit. I will record this and check it matches your egress answer.' },
        { value: 'other', label: 'Something else', note: 'I will raise it as a validation issue rather than assume.' },
      ] },
      default: 'locked',
      risk: 'high',
      hazard: 'Do not do this alone on a door that is the only way out of an occupied room, and never on a door that could close behind you.',
      fact: 'safety.power_loss_state',
      group: 'security',
    });
  }

  if (hasMainsPsu) {
    drafts.push({
      verb: 'observe',
      title: 'Confirm the mains supplies are enclosed and strain-relieved',
      why: 'I cannot inspect your installation, and a lock that fails because someone tugged a cable is still a failed lock.',
      thenWhat: 'Recorded in the build guide as a completed safety check.',
      answer: { kind: 'boolean', expect: 'no exposed mains terminals and cables that cannot be pulled out' },
      default: false,
      risk: 'high',
      hazard: 'Mains voltage. If you are not qualified to be working inside the enclosure, stop and get someone who is.',
      fact: 'safety.mains_enclosed',
      group: 'security',
    });
  }

  if (hasKeypad) {
    drafts.push({
      verb: 'verify',
      title: 'Confirm the PIN fallback unlocks the door with the camera covered',
      why: 'A fallback you have never tested is not a fallback. Cameras fail, and people change their hair.',
      thenWhat: 'A pass closes the fallback requirement. A fail keeps it as a blocking issue.',
      answer: { kind: 'boolean', passWhen: 'the bolt retracts after the correct PIN with the camera covered' },
      default: false,
      fact: 'fallback.pin_unlocks',
      group: 'security',
    });
  }

  return build(drafts);
}
