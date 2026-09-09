/**
 * Single board computers, cameras and door hardware.
 *
 * SBCs are seeded in the `microcontroller` category on purpose: that category
 * means "the thing being programmed", and every controller code path (profile
 * lookup, hardware defaults, power budgeting, wiring conflicts, simulation)
 * already keys on it in ~20 places. `metadata.kind = 'sbc'` is what
 * distinguishes an SBC from an MCU, and the runtime layer reads that to decide
 * between firmware and a Linux application.
 *
 * Values are only stated where they are actually known. The 40-pin header
 * exposes GPIO2-GPIO27; GPIO0/GPIO1 belong to the HAT EEPROM and are not
 * available, so they are absent rather than listed and then reserved.
 */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

/** The 26 usable GPIOs of the Raspberry Pi 40-pin header, with real alt functions. */
const PI_HEADER_GPIO: { name: string; type: 'digital' | 'i2c' | 'spi' | 'uart' | 'pwm'; signal: string; aliases?: string[] }[] = [
  { name: 'GPIO2', type: 'i2c', signal: 'I2C1 SDA (1.8 kΩ pull-up to 3.3 V on board)', aliases: ['2', 'SDA', 'SDA1'] },
  { name: 'GPIO3', type: 'i2c', signal: 'I2C1 SCL (1.8 kΩ pull-up to 3.3 V on board)', aliases: ['3', 'SCL', 'SCL1'] },
  { name: 'GPIO4', type: 'digital', signal: 'General purpose, also 1-Wire by default', aliases: ['4', 'GPCLK0'] },
  { name: 'GPIO5', type: 'digital', signal: 'General purpose', aliases: ['5'] },
  { name: 'GPIO6', type: 'digital', signal: 'General purpose', aliases: ['6'] },
  { name: 'GPIO7', type: 'spi', signal: 'SPI0 CE1', aliases: ['7', 'CE1'] },
  { name: 'GPIO8', type: 'spi', signal: 'SPI0 CE0', aliases: ['8', 'CE0'] },
  { name: 'GPIO9', type: 'spi', signal: 'SPI0 MISO', aliases: ['9', 'MISO'] },
  { name: 'GPIO10', type: 'spi', signal: 'SPI0 MOSI', aliases: ['10', 'MOSI'] },
  { name: 'GPIO11', type: 'spi', signal: 'SPI0 SCLK', aliases: ['11', 'SCLK', 'SCK'] },
  { name: 'GPIO12', type: 'pwm', signal: 'PWM0 (alt function)', aliases: ['12', 'PWM0'] },
  { name: 'GPIO13', type: 'pwm', signal: 'PWM1 (alt function)', aliases: ['13', 'PWM1'] },
  { name: 'GPIO14', type: 'uart', signal: 'UART0 TXD (/dev/serial0)', aliases: ['14', 'TXD', 'TX'] },
  { name: 'GPIO15', type: 'uart', signal: 'UART0 RXD (/dev/serial0)', aliases: ['15', 'RXD', 'RX'] },
  { name: 'GPIO16', type: 'digital', signal: 'General purpose', aliases: ['16'] },
  { name: 'GPIO17', type: 'digital', signal: 'General purpose', aliases: ['17'] },
  { name: 'GPIO18', type: 'pwm', signal: 'PWM0 (alt function), also I2S/PCM CLK', aliases: ['18', 'PWM0'] },
  { name: 'GPIO19', type: 'pwm', signal: 'PWM1 (alt function), also SPI1 MISO', aliases: ['19', 'PWM1'] },
  { name: 'GPIO20', type: 'spi', signal: 'SPI1 MOSI (alt)', aliases: ['20'] },
  { name: 'GPIO21', type: 'spi', signal: 'SPI1 SCLK (alt)', aliases: ['21'] },
  { name: 'GPIO22', type: 'digital', signal: 'General purpose', aliases: ['22'] },
  { name: 'GPIO23', type: 'digital', signal: 'General purpose', aliases: ['23'] },
  { name: 'GPIO24', type: 'digital', signal: 'General purpose', aliases: ['24'] },
  { name: 'GPIO25', type: 'digital', signal: 'General purpose', aliases: ['25'] },
  { name: 'GPIO26', type: 'digital', signal: 'General purpose', aliases: ['26'] },
  { name: 'GPIO27', type: 'digital', signal: 'General purpose, also used by some HATs', aliases: ['27'] },
];

function headerPins(): ReturnType<typeof pin>[] {
  return PI_HEADER_GPIO.map((entry) =>
    pin(entry.name, entry.type, 'bidirectional', {
      signal: entry.signal,
      voltage: 3.3,
      aliases: entry.aliases,
    }),
  );
}

/**
 * Raspberry Pi 4 Model B.
 *
 * 3.3 V logic, no ADC on the header, 16 mA per GPIO with a 50 mA total across
 * all GPIO. Powered from USB-C at 5 V; the official supply is 3 A and anything
 * weaker causes the exact class of intermittent failure that is hardest to
 * diagnose in the field (camera brownouts, SD card corruption).
 */
export const SBCS: ComponentDefinition[] = [
  def({
    id: 'raspberry-pi-4b',
    name: 'Raspberry Pi 4 Model B',
    category: 'microcontroller',
    description:
      'Broadcom BCM2711 quad-core Cortex-A72 Linux single board computer. 40-pin GPIO header at 3.3 V logic with 26 usable GPIO, two CSI/DSI lanes, gigabit Ethernet, dual micro-HDMI, 2× USB 3.0 and 2× USB 2.0. Powered over USB-C at 5 V; the official supply delivers 3 A. No analog input on the header.',
    voltage: 5,
    minVoltage: 4.75,
    maxVoltage: 5.25,
    currentRequirements: {
      typicalMa: 600,
      maxMa: 3000,
      note: 'Idle ~600 mA, ~1.2 A under a vision workload, up to 3 A with camera, USB SSD and cooling. Total current across all GPIO must stay under 50 mA (16 mA per pin).',
    },
    communicationProtocols: ['i2c', 'spi', 'uart', 'pwm', 'usb', 'ethernet', 'wifi', 'bluetooth', 'ble', 'csi', 'gpio'],
    compatibleMicrocontrollers: [],
    pins: [
      pin('USB-C', 'power', 'power', {
        required: true,
        signal: '5 V power input (USB-C). Use a supply rated for 3 A.',
        voltage: 5,
        minVoltage: 4.75,
        maxVoltage: 5.25,
        aliases: ['5V IN', 'VBUS', 'PWR IN'],
      }),
      pin('5V', 'power', 'power', { required: false, signal: '5 V output, straight from the USB-C input', voltage: 5, aliases: ['5V0', 'VCC'] }),
      pin('3V3', 'power', 'power', { required: false, signal: '3.3 V output from the on-board regulator, ~1.1 A shared with the board', voltage: 3.3, aliases: ['3.3V'] }),
      pin('GND', 'ground', 'ground', { required: true, signal: 'Common ground. Must be shared with every external supply in the build.', aliases: ['VSS', '0V'] }),
      ...headerPins(),
      pin('CAM1', 'signal', 'input', {
        required: false,
        signal: '2-lane MIPI CSI-2 camera connector (15-pin ribbon). Carries power, I2C and the differential lanes.',
        aliases: ['CSI', 'CAMERA', 'CSI1'],
      }),
      pin('USB2.0', 'signal', 'bidirectional', { required: false, signal: 'USB 2.0 host port (480 Mbit/s)', voltage: 5, aliases: ['USB-A', 'USB'] }),
      pin('USB3.0', 'signal', 'bidirectional', { required: false, signal: 'USB 3.0 host port (5 Gbit/s)', voltage: 5, aliases: ['USB-A', 'USB'] }),
    ],
    libraryRequirements: [
      { name: 'gpiozero', import: 'gpiozero', manager: 'pip', purpose: 'High level GPIO access (LED, OutputDevice, Button)', builtIn: false },
      { name: 'picamera2', import: 'picamera2', manager: 'pip', purpose: 'libcamera based camera capture for Raspberry Pi OS', builtIn: false },
      { name: 'opencv-contrib-python', import: 'cv2', manager: 'pip', purpose: 'Face detection (YuNet) and recognition (SFace) plus image processing', builtIn: false },
    ],
    exampleUsage: [
      'Face recognition door lock with a CSI camera and a MOSFET driven solenoid',
      'Local MQTT/HTTP sensor gateway with a SQLite store',
      'Timelapse or motion triggered capture with libcamera',
    ],
    aliases: ['raspberry pi 4', 'raspberry pi 4b', 'raspberry pi 4 model b', 'pi 4', 'pi 4b', 'rpi 4', 'rpi4', 'bcm2711'],
    keywords: ['raspberry', 'pi', 'raspberry pi', 'sbc', 'linux', 'arm', 'cortex-a72', 'single board computer', 'bcm2711', 'camera', 'csi'],
    simulator: { part: 'wokwi-raspberry-pi-4', supported: false, notes: 'No faithful Wokwi part: a Linux SBC with a CSI camera cannot be simulated there. Report honestly rather than faking it.' },
    metadata: {
      kind: 'sbc',
      runtime: 'linux',
      os: 'Raspberry Pi OS Lite 64-bit (Bookworm or newer)',
      mcuProfileId: 'raspberry-pi-4b',
      logicVoltage: 3.3,
      usbPowered: true,
      usbVoltage: 5,
      usbMaxCurrentMa: 3000,
      onboardRegulator: 'On-board switching regulators generating 3.3 V / 1.8 V and the DRAM rails from the 5 V USB-C input',
      cpu: 'Broadcom BCM2711',
      cores: 4,
      clockMhz: 1500,
      ramMb: 4096,
      // Deliberately 0: the 40-pin header has no ADC. Anything demanding analog
      // input must fail loudly instead of being assigned a fake "A0".
      adcResolutionBits: 0,
      adcChannels: 'None on the 40-pin header — use an external ADC over I2C or SPI',
      inputOnlyPins: [],
      reservedPins: [],
      reservedReason: 'GPIO0/GPIO1 are used by the HAT EEPROM and are not present on the header.',
      strappingPins: [],
      defaultI2c: { sda: 'GPIO2', scl: 'GPIO3' },
      defaultSpi: { mosi: 'GPIO10', miso: 'GPIO9', sck: 'GPIO11', cs: 'GPIO8' },
      defaultUart: [{ id: '/dev/serial0', tx: 'GPIO14', rx: 'GPIO15', note: 'Primary UART; enable with raspi-config if the Linux console is attached to it' }],
      bluetooth: { classic: true, ble: true, library: 'BlueZ / bluepy' },
      maxGpioSinkMa: 16,
      recommendedGpioSinkMa: 8,
      gpioTotalMaxMa: 50,
      gpioTotalNote: 'The 50 mA total across all GPIO, not the 16 mA per pin, is the limit that surprises people.',
      cameraInterface: 'csi',
      recommendedSupply: 'psu-5v-3a-usbc',
      recommendedSupplyReason: 'Under-rated supplies cause camera brownouts and SD card corruption that look like software bugs.',
      bootMedia: 'microSD (A2 rated) or USB SSD',
      thermalNote: 'Throttles at 80 °C; a passive heatsink is the minimum for a continuous vision workload in an enclosure.',
    },
  }),

  def({
    id: 'raspberry-pi-zero-2-w',
    name: 'Raspberry Pi Zero 2 W',
    category: 'microcontroller',
    description:
      'Broadcom BCM2710A1 quad-core Cortex-A53 Linux single board computer with 512 MB RAM, 2.4 GHz Wi-Fi and Bluetooth. Unpopulated 40-pin GPIO header with the same pinout as the Pi 4B, one CSI connector, micro-USB power. Roughly a third of the Pi 4B compute — enough for capture, not for real-time recognition on the CPU.',
    voltage: 5,
    minVoltage: 4.75,
    maxVoltage: 5.25,
    currentRequirements: {
      typicalMa: 350,
      maxMa: 1500,
      note: 'Idle ~350 mA, ~700 mA with the camera streaming. A 2.5 A supply is comfortable.',
    },
    communicationProtocols: ['i2c', 'spi', 'uart', 'pwm', 'wifi', 'bluetooth', 'ble', 'csi', 'gpio'],
    compatibleMicrocontrollers: [],
    pins: [
      pin('PWR IN', 'power', 'power', {
        required: true,
        signal: '5 V power input (micro-USB)',
        voltage: 5,
        minVoltage: 4.75,
        maxVoltage: 5.25,
        aliases: ['5V IN', 'VBUS', 'USB'],
      }),
      pin('5V', 'power', 'power', { required: false, signal: '5 V output from the micro-USB input', voltage: 5, aliases: ['5V0', 'VCC'] }),
      pin('3V3', 'power', 'power', { required: false, signal: '3.3 V output, limited by the on-board regulator', voltage: 3.3, aliases: ['3.3V'] }),
      pin('GND', 'ground', 'ground', { required: true, signal: 'Common ground', aliases: ['VSS', '0V'] }),
      ...headerPins(),
      pin('CAM1', 'signal', 'input', {
        required: false,
        signal: 'MIPI CSI-2 camera connector (22-pin Zero ribbon, different from the Pi 4 ribbon)',
        aliases: ['CSI', 'CAMERA'],
      }),
    ],
    libraryRequirements: [
      { name: 'gpiozero', import: 'gpiozero', manager: 'pip', purpose: 'High level GPIO access', builtIn: false },
      { name: 'picamera2', import: 'picamera2', manager: 'pip', purpose: 'libcamera based camera capture', builtIn: false },
    ],
    exampleUsage: [
      'Low power capture node that ships frames to a bigger host for inference',
      'Battery powered sensor logger with Wi-Fi upload',
    ],
    aliases: ['pi zero 2 w', 'pi zero 2', 'raspberry pi zero 2 w', 'rpi zero 2', 'zero 2w'],
    keywords: ['raspberry', 'pi', 'zero', 'sbc', 'linux', 'arm', 'low power', 'single board computer'],
    simulator: { part: 'wokwi-raspberry-pi-zero-2-w', supported: false, notes: 'Not simulatable in Wokwi.' },
    metadata: {
      kind: 'sbc',
      runtime: 'linux',
      os: 'Raspberry Pi OS Lite 64-bit',
      mcuProfileId: 'raspberry-pi-zero-2-w',
      logicVoltage: 3.3,
      usbPowered: true,
      usbVoltage: 5,
      usbMaxCurrentMa: 1500,
      onboardRegulator: 'On-board regulators from the 5 V micro-USB input',
      cpu: 'Broadcom BCM2710A1',
      cores: 4,
      clockMhz: 1000,
      ramMb: 512,
      adcResolutionBits: 0,
      inputOnlyPins: [],
      reservedPins: [],
      strappingPins: [],
      defaultI2c: { sda: 'GPIO2', scl: 'GPIO3' },
      defaultSpi: { mosi: 'GPIO10', miso: 'GPIO9', sck: 'GPIO11', cs: 'GPIO8' },
      defaultUart: [{ id: '/dev/serial0', tx: 'GPIO14', rx: 'GPIO15' }],
      bluetooth: { classic: true, ble: true, library: 'BlueZ / bluepy' },
      maxGpioSinkMa: 16,
      recommendedGpioSinkMa: 8,
      gpioTotalMaxMa: 50,
      cameraInterface: 'csi',
      ribbonNote: 'Uses the narrower 22-pin Zero ribbon, not the 15-pin Pi 4 ribbon.',
      performanceNote: 'Recognition on the CPU runs around 1-2 FPS here. Pair with the IMX500 AI camera or offload inference if you need a responsive lock.',
    },
  }),

  def({
    id: 'raspberry-pi-5',
    name: 'Raspberry Pi 5',
    category: 'microcontroller',
    description:
      'Broadcom BCM2712 quad-core Cortex-A76 Linux single board computer, 2-3x the Pi 4B, with a PCIe 2.0 lane, dual 4K micro-HDMI and an on-board real-time clock. 40-pin header with the same GPIO numbering as the Pi 4B. Needs active cooling under sustained load and a 5 V / 5 A USB-C supply.',
    voltage: 5,
    minVoltage: 4.75,
    maxVoltage: 5.25,
    currentRequirements: {
      typicalMa: 900,
      maxMa: 5000,
      note: 'Idle ~900 mA; a 5 A USB-C PD supply is required to get the full 1.6 A on the USB ports. Throttles without active cooling.',
    },
    communicationProtocols: ['i2c', 'spi', 'uart', 'pwm', 'usb', 'ethernet', 'wifi', 'bluetooth', 'ble', 'csi', 'pcie', 'gpio'],
    compatibleMicrocontrollers: [],
    pins: [
      pin('USB-C', 'power', 'power', {
        required: true,
        signal: '5 V USB-C power input, USB-PD negotiated at up to 5 A',
        voltage: 5,
        minVoltage: 4.75,
        maxVoltage: 5.25,
        aliases: ['5V IN', 'VBUS', 'PWR IN'],
      }),
      pin('5V', 'power', 'power', { required: false, signal: '5 V output', voltage: 5, aliases: ['5V0', 'VCC'] }),
      pin('3V3', 'power', 'power', { required: false, signal: '3.3 V output', voltage: 3.3, aliases: ['3.3V'] }),
      pin('GND', 'ground', 'ground', { required: true, signal: 'Common ground', aliases: ['VSS', '0V'] }),
      ...headerPins(),
      pin('CAM1', 'signal', 'input', { required: false, signal: '2-lane MIPI CSI-2 camera connector (15-pin ribbon)', aliases: ['CSI', 'CAMERA', 'CAM0'] }),
      pin('USB3.0', 'signal', 'bidirectional', { required: false, signal: 'USB 3.0 host port', voltage: 5, aliases: ['USB-A', 'USB'] }),
    ],
    libraryRequirements: [
      { name: 'gpiozero', import: 'gpiozero', manager: 'pip', purpose: 'High level GPIO access', builtIn: false },
      { name: 'picamera2', import: 'picamera2', manager: 'pip', purpose: 'libcamera based camera capture', builtIn: false },
      { name: 'opencv-contrib-python', import: 'cv2', manager: 'pip', purpose: 'Face detection and recognition', builtIn: false },
    ],
    exampleUsage: ['Face recognition with detection, recognition and anti-spoofing all on device', 'Multi-camera capture node'],
    aliases: ['raspberry pi 5', 'pi 5', 'rpi 5', 'rpi5'],
    keywords: ['raspberry', 'pi', 'pi 5', 'sbc', 'linux', 'arm', 'cortex-a76', 'single board computer'],
    simulator: { part: 'wokwi-raspberry-pi-5', supported: false, notes: 'Not simulatable in Wokwi.' },
    metadata: {
      kind: 'sbc',
      runtime: 'linux',
      os: 'Raspberry Pi OS Lite 64-bit (Bookworm or newer)',
      mcuProfileId: 'raspberry-pi-5',
      logicVoltage: 3.3,
      usbPowered: true,
      usbVoltage: 5,
      usbMaxCurrentMa: 5000,
      cpu: 'Broadcom BCM2712',
      cores: 4,
      clockMhz: 2400,
      ramMb: 8192,
      adcResolutionBits: 0,
      inputOnlyPins: [],
      reservedPins: [],
      strappingPins: [],
      defaultI2c: { sda: 'GPIO2', scl: 'GPIO3' },
      defaultSpi: { mosi: 'GPIO10', miso: 'GPIO9', sck: 'GPIO11', cs: 'GPIO8' },
      defaultUart: [{ id: '/dev/serial0', tx: 'GPIO14', rx: 'GPIO15' }],
      bluetooth: { classic: true, ble: true, library: 'BlueZ / bluepy' },
      maxGpioSinkMa: 16,
      recommendedGpioSinkMa: 8,
      gpioTotalMaxMa: 50,
      cameraInterface: 'csi',
      recommendedSupply: 'psu-5v-5a-usbc',
      thermalNote: 'Requires active cooling under sustained load.',
    },
  }),
];

/**
 * Cameras.
 *
 * Both declare `noSupplyPins`: they are bus powered over the ribbon / USB
 * cable, so they have no supply rail of their own to budget — exactly the
 * rationale the catalog integrity check already uses for two-terminal parts.
 */
export const CAMERAS: ComponentDefinition[] = [
  def({
    id: 'pi-camera-module-3',
    name: 'Raspberry Pi Camera Module 3',
    category: 'sensor',
    description:
      '12 MP Sony IMX708 autofocus camera on a 15-pin MIPI CSI-2 ribbon. 75° horizontal field of view, phase detect autofocus, HDR. Powered and controlled entirely over the ribbon. Supported by libcamera / Picamera2 with no third party driver.',
    voltage: 3.3,
    currentRequirements: { typicalMa: 250, maxMa: 400, note: 'Drawn from the host over the ribbon; budget it against the host supply, not the GPIO.' },
    communicationProtocols: ['csi', 'i2c'],
    compatibleMicrocontrollers: ['raspberry-pi-4b', 'raspberry-pi-5'],
    pins: [
      pin('CSI', 'signal', 'output', {
        required: true,
        signal: '2-lane MIPI CSI-2 link plus I2C control and power, all over the ribbon',
        aliases: ['CAM', 'RIBBON', 'MIPI'],
      }),
    ],
    libraryRequirements: [
      { name: 'picamera2', import: 'picamera2', manager: 'pip', purpose: 'Capture via libcamera; provides autofocus and still/video configuration', builtIn: false },
    ],
    exampleUsage: ['Face recognition at a doorway', 'Motion triggered capture', 'Live preview stream over the network'],
    // "camera" and "pi camera" are exact aliases on purpose: they make the
    // plain Camera Module 3 win over the AI Camera for an unqualified "camera",
    // which is the sane default. The AI Camera is a deliberate upgrade, not the
    // thing you get by accident.
    aliases: ['camera', 'pi camera', 'camera module 3', 'cam module 3', 'imx708 camera', 'pi cam 3', 'raspberry pi camera module 3'],
    keywords: ['camera', 'csi', 'imx708', 'autofocus', 'vision', 'face', '12mp', 'mipi'],
    simulator: { part: 'wokwi-camera-module-3', supported: false, notes: 'No camera support in Wokwi.' },
    metadata: {
      kind: 'camera',
      noSupplyPins: true,
      sensor: 'Sony IMX708',
      resolutionMp: 12,
      resolution: '4608x2592',
      fieldOfViewDeg: 75,
      focus: 'autofocus (phase detect)',
      minFocusDistanceCm: 10,
      hdr: true,
      interface: 'csi',
      ribbon: '15-pin 15-way ribbon — the 150 mm cable included in the box is too short for most door frames, order the 300 mm or 500 mm version',
      driverStack: 'libcamera / Picamera2',
      lowLightNote: 'Standard module needs light. For a dark doorway use Camera Module 3 NoIR with an IR LED ring.',
      faceRecognitionNote: 'At 1080p a Pi 4B manages a handful of FPS with detection alone; scale the capture to 640x480 for a responsive lock.',
    },
  }),

  def({
    id: 'raspberry-pi-ai-camera',
    name: 'Raspberry Pi AI Camera (IMX500)',
    category: 'sensor',
    description:
      'Sony IMX500 intelligent vision sensor with an on-sensor AI accelerator. Runs a neural network on the sensor itself and outputs metadata (boxes, landmarks, embeddings) alongside the image, leaving the host CPU almost free. 12 MP stills, 4056x3040, CSI-2 ribbon.',
    voltage: 3.3,
    currentRequirements: { typicalMa: 400, maxMa: 700, note: 'Higher than a passive module because the accelerator is on the sensor.' },
    communicationProtocols: ['csi', 'i2c'],
    compatibleMicrocontrollers: ['raspberry-pi-4b', 'raspberry-pi-5', 'raspberry-pi-zero-2-w'],
    pins: [
      pin('CSI', 'signal', 'output', {
        required: true,
        signal: '2-lane MIPI CSI-2 link plus I2C control and power over the ribbon',
        aliases: ['CAM', 'RIBBON', 'MIPI'],
      }),
    ],
    libraryRequirements: [
      { name: 'picamera2', import: 'picamera2', manager: 'pip', purpose: 'Capture and IMX500 metadata plumbing', builtIn: false },
      { name: 'imx500-module', import: 'imx500', manager: 'pip', purpose: 'Model upload and on-sensor inference for the IMX500', builtIn: false },
    ],
    exampleUsage: ['Face detection and landmarking at full frame rate on a Pi Zero 2 W', 'Always-on person detection with the host mostly idle'],
    aliases: ['ai camera', 'imx500 camera', 'pi ai camera', 'raspberry pi ai camera'],
    keywords: ['camera', 'ai', 'imx500', 'npu', 'edge inference', 'csi', 'vision', 'face'],
    simulator: { part: 'wokwi-ai-camera', supported: false, notes: 'Not simulatable.' },
    metadata: {
      kind: 'camera',
      noSupplyPins: true,
      sensor: 'Sony IMX500',
      resolutionMp: 12,
      fieldOfViewDeg: 79,
      interface: 'csi',
      onSensorInference: true,
      driverStack: 'libcamera / Picamera2 with the imx500 firmware package',
      whyItMatters: 'Inference on the sensor is the only way to get real-time recognition on a Pi Zero 2 W.',
      tradeoff: 'Model upload and tooling are more involved than a plain CSI camera.',
    },
  }),

  def({
    id: 'usb-webcam-1080p',
    name: 'USB Webcam 1080p (UVC)',
    category: 'sensor',
    description:
      'Generic USB Video Class webcam at 1080p 30 fps with a built-in microphone. Bus powered, no driver install, works with OpenCV VideoCapture out of the box. Higher latency than a CSI camera and bulkier to mount flush in a door frame.',
    voltage: 5,
    currentRequirements: { typicalMa: 200, maxMa: 500, note: 'Bus powered from the host USB port. Counts against the host supply and the USB port budget.' },
    communicationProtocols: ['usb'],
    compatibleMicrocontrollers: ['raspberry-pi-4b', 'raspberry-pi-5'],
    pins: [
      pin('USB', 'signal', 'bidirectional', {
        required: true,
        signal: 'USB 2.0 connection carrying both video and power',
        voltage: 5,
        aliases: ['USB-A', 'V4L2'],
      }),
    ],
    libraryRequirements: [
      { name: 'opencv-contrib-python', import: 'cv2', manager: 'pip', purpose: 'Capture through VideoCapture (V4L2 backend)', builtIn: false },
    ],
    exampleUsage: ['Quick prototype before committing to a CSI camera', 'Capture at a distance where autofocus matters less'],
    aliases: ['webcam', 'usb camera', 'logitech c920', 'uvc camera'],
    keywords: ['camera', 'usb', 'webcam', 'uvc', 'v4l2', 'video', 'face'],
    simulator: { part: 'wokwi-usb-webcam', supported: false, notes: 'Not simulatable.' },
    metadata: {
      kind: 'camera',
      noSupplyPins: true,
      interface: 'usb',
      resolution: '1920x1080',
      fps: 30,
      focus: 'fixed or autofocus depending on the model',
      driverStack: 'UVC / V4L2',
      tradeoff: 'Easiest to wire, worst latency and hardest to mount flush. Fine for a prototype, not for a tidy install.',
    },
  }),
];
