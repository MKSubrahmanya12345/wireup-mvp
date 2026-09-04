/**
 * Deterministic prompt analysis.
 *
 * Runs BEFORE any model call: it extracts platform hints, feature signals and
 * quantities straight from the text so the generation call is anchored in facts
 * rather than starting from a blank slate. The model may extend or correct this
 * draft, but the deterministic findings are always merged back in.
 */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  a: 1,
  an: 1,
  single: 1,
  two: 2,
  pair: 2,
  couple: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
};

export interface FeatureRule {
  feature: string;
  pattern: RegExp;
  /** Quantity key this feature can populate, e.g. `motors`. */
  quantityKey?: string;
  /** Nouns used when scanning for "two DC motors" style phrases. */
  quantityNouns?: string[];
}

export const FEATURE_RULES: FeatureRule[] = [
  { feature: 'bluetooth', pattern: /\b(blue\s*tooth|bluetooth|\bbt\b|ble\b|hc[-\s]?0[56]|spp|phone\s+control|control\s+from\s+(my\s+)?phone|android|app\s+control)\b/i, quantityKey: 'bluetooth_modules' },
  { feature: 'wifi', pattern: /\b(wi[-\s]?fi|wifi|web\s*server|http|mqtt|esp\s*now|websocket|ota)\b/i },
  { feature: 'motor_control', pattern: /\b(dc\s*motor|motor|motors|wheels?|drive\s*train|drivetrain|rc\s*car|robot\s*car|tank|rover|gear\s*motor)\b/i, quantityKey: 'motors', quantityNouns: ['dc motor', 'motor', 'gear motor', 'wheel motor'] },
  { feature: 'stepper', pattern: /\b(stepper|stepper\s*motor|nema\s*17|28byj|cnc|extruder)\b/i, quantityKey: 'steppers', quantityNouns: ['stepper', 'stepper motor'] },
  { feature: 'servo', pattern: /\b(servo|servos|sg90|mg99|pan\s*tilt|steering\s*servo)\b/i, quantityKey: 'servos', quantityNouns: ['servo', 'micro servo'] },
  { feature: 'temperature_humidity', pattern: /\b(dht\s*11|dht\s*22|am2302|temperature|humidity|thermometer|weather\s*station)\b/i },
  { feature: 'distance', pattern: /\b(ultrasonic|hc[-\s]?sr04|distance\s*sensor|range\s*finder|sonar|parking)\b/i, quantityKey: 'ultrasonic_sensors', quantityNouns: ['ultrasonic sensor', 'ultrasonic'] },
  { feature: 'motion', pattern: /\b(pir|motion|hc[-\s]?sr501|intruder|presence)\b/i },
  { feature: 'obstacle_avoidance', pattern: /\b(obstacle|ir\s*sensor|infrared\s*sensor|avoidance|collision)\b/i },
  { feature: 'line_following', pattern: /\b(line\s*follow|line\s*follower|line\s*tracking)\b/i },
  { feature: 'gas_air_quality', pattern: /\b(mq[-\s]?\d|gas|smoke|lpg|air\s*quality|flammable|co2)\b/i },
  { feature: 'soil_moisture', pattern: /\b(soil|moisture|plant|irrigation|garden)\b/i },
  { feature: 'light_sensing', pattern: /\b(ldr|photoresistor|light\s*sensor|brightness|ambient\s*light|cds)\b/i },
  { feature: 'imu', pattern: /\b(mpu\s*6050|imu|accelerometer|gyro(scope)?|tilt|balance|orientation)\b/i },
  { feature: 'display', pattern: /\b(lcd|oled|ssd1306|display|screen|1602|show\s+.*\s+on\s+screen)\b/i },
  { feature: 'lighting', pattern: /\b(led|leds|light|lights|lamp|neopixel|ws2812|rgb\s*led)\b/i, quantityKey: 'leds', quantityNouns: ['led', 'rgb led'] },
  { feature: 'sound', pattern: /\b(buzzer|piezo|alarm|beep|tone|speaker|sound)\b/i },
  { feature: 'high_current_switching', pattern: /\b(relay|pump|fan|lamp|mains|220v|110v|ac\s*load|solenoid)\b/i },
  { feature: 'user_input', pattern: /\b(button|push\s*button|pushbutton|switch|potentiometer|knob|joystick|encoder|throttle)\b/i, quantityKey: 'buttons', quantityNouns: ['button', 'push button', 'switch'] },
  { feature: 'battery_power', pattern: /\b(battery|batteries|lipo|li-po|18650|aa\s*cells|9v|power\s*bank|portable)\b/i },
  { feature: 'telemetry', pattern: /\b(telemetry|log(ging)?|readout|report|dashboard|sensor\s*data)\b/i },
  { feature: 'autonomy', pattern: /\b(autonomous|self[-\s]driving|navigate|avoid|wander|patrol|follow)\b/i },
];

export interface PlatformHint {
  platform: string;
  componentId?: string;
  confidence: number;
  matched: string;
}

const PLATFORM_RULES: { pattern: RegExp; platform: string; componentId?: string; confidence: number }[] = [
  { pattern: /\besp[\s-]?32\b/i, platform: 'esp32', componentId: 'esp32-devkit-v1', confidence: 0.98 },
  { pattern: /\barduino\s*uno\b|\buno\b/i, platform: 'arduino-uno', componentId: 'arduino-uno-r3', confidence: 0.95 },
  { pattern: /\barduino\s*nano\b|\bnano\b/i, platform: 'arduino-nano', componentId: 'arduino-nano', confidence: 0.9 },
  { pattern: /\barduino\b/i, platform: 'arduino', confidence: 0.6 },
  { pattern: /\besp[\s-]?8266\b|\bnode\s*mcu\b/i, platform: 'esp8266', confidence: 0.7 },
  { pattern: /\braspberry\s*pi\s*pico\b|\brp2040\b/i, platform: 'rp2040', confidence: 0.8 },
  { pattern: /\bstm32\b/i, platform: 'stm32', confidence: 0.7 },
];

export interface PromptAnalysis {
  prompt: string;
  features: string[];
  quantities: Record<string, number>;
  platformHints: PlatformHint[];
  detectedPlatform?: string;
  detectedPlatformComponentId?: string;
  powerHints: string[];
  communicationHints: string[];
  behaviourPhrases: string[];
  explicitParts: string[];
  notes: string[];
}

function extractQuantities(prompt: string, features: string[]): Record<string, number> {
  const quantities: Record<string, number> = {};

  for (const rule of FEATURE_RULES) {
    if (!rule.quantityKey || !rule.quantityNouns) continue;
    if (features.length > 0 && !features.includes(rule.feature)) continue;

    let best = 0;
    for (const noun of rule.quantityNouns) {
      const escaped = noun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const expression = new RegExp(
        `(\\b\\d{1,2}\\b|\\b${Object.keys(NUMBER_WORDS).join('|')}\\b)\\s+(?:[a-z0-9-]+\\s+){0,2}?${escaped}s?\\b`,
        'gi',
      );
      let match: RegExpExecArray | null;
      while ((match = expression.exec(prompt)) !== null) {
        const raw = (match[1] ?? '').toLowerCase();
        const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : (NUMBER_WORDS[raw] ?? 0);
        if (value > best) best = value;
      }
    }
    if (best > 0) quantities[rule.quantityKey] = best;
  }

  // Generic "<number> <noun>" sweep for parts we have explicit keys for.
  const generic = /(\b\d{1,2}\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b)\s+([a-z0-9-]+(?:\s+[a-z0-9-]+)?)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = generic.exec(prompt)) !== null) {
    const rawNumber = (match[1] ?? '').toLowerCase();
    const noun = (match[2] ?? '').toLowerCase().trim();
    const value = /^\d+$/.test(rawNumber) ? Number.parseInt(rawNumber, 10) : (NUMBER_WORDS[rawNumber] ?? 0);
    if (value <= 0) continue;

    if (/(motor)/.test(noun) && !/stepper|servo/.test(noun)) quantities.motors = Math.max(quantities.motors ?? 0, value);
    if (/servo/.test(noun)) quantities.servos = Math.max(quantities.servos ?? 0, value);
    if (/stepper/.test(noun)) quantities.steppers = Math.max(quantities.steppers ?? 0, value);
    if (/led/.test(noun)) quantities.leds = Math.max(quantities.leds ?? 0, value);
    if (/button|switch/.test(noun)) quantities.buttons = Math.max(quantities.buttons ?? 0, value);
    if (/sensor/.test(noun)) quantities.sensors = Math.max(quantities.sensors ?? 0, value);
  }

  return quantities;
}

function extractBehaviours(prompt: string): string[] {
  const behaviours: string[] = [];
  const clauses = prompt.split(/(?:,|;|\band\b|\bthen\b|\.)/i);

  const behaviourPattern =
    /\b(move|moves|drive|drives|spin|stop|stops|turn|turns|rotate|display|show|reads?|detect|avoid|follow|light|lights|beep|sound|alarm|report|send|publish|control|toggle|adjust|measure|warn|alert|reverse|brake|speed|steer)\b/i;

  for (const clause of clauses) {
    const trimmed = clause.trim().replace(/\s+/g, ' ');
    if (trimmed.length < 6) continue;
    if (behaviourPattern.test(trimmed)) behaviours.push(trimmed);
  }

  return behaviours.slice(0, 12);
}

function extractExplicitParts(prompt: string): string[] {
  const parts = new Set<string>();
  const partPattern =
    /\b(esp32|esp-32|arduino\s*uno|arduino\s*nano|l298n|l293d|tb6612fng|a4988|hc-05|hc-06|hc-sr04|dht11|dht22|mpu6050|mq-\d|ssd1306|lcd\s*1602|sg90|mg996r|28byj-?48|nema\s*17|lm7805|ams1117|lm2596|ws2812b?|neopixel|pir|ldr)\b/gi;

  let match: RegExpExecArray | null;
  while ((match = partPattern.exec(prompt)) !== null) {
    parts.add((match[1] ?? '').toLowerCase().replace(/\s+/g, ' '));
  }
  return [...parts];
}

function extractVoltageHints(prompt: string): string[] {
  const hints: string[] = [];
  const voltPattern = /\b(\d{1,2}(?:\.\d)?)\s*v(?:olts?)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = voltPattern.exec(prompt)) !== null) {
    hints.push(`${match[1]} V supply mentioned in the prompt`);
  }
  if (/\busb\b/i.test(prompt)) hints.push('USB 5 V power mentioned');
  if (/\bmains|wall\s*adapter|ac\s*adapter/i.test(prompt)) hints.push('Mains/wall adapter supply mentioned');
  return [...new Set(hints)];
}

/** Run the deterministic pre-analysis. Never throws. */
export function analyzePrompt(prompt: string): PromptAnalysis {
  const text = prompt ?? '';
  const notes: string[] = [];

  const features: string[] = [];
  for (const rule of FEATURE_RULES) {
    if (rule.pattern.test(text)) features.push(rule.feature);
  }

  const platformHints: PlatformHint[] = [];
  for (const rule of PLATFORM_RULES) {
    const match = rule.pattern.exec(text);
    if (match) platformHints.push({ platform: rule.platform, confidence: rule.confidence, matched: match[0], ...(rule.componentId ? { componentId: rule.componentId } : {}) });
  }
  platformHints.sort((a, b) => b.confidence - a.confidence);

  const top = platformHints[0];
  if (platformHints.length > 1) {
    notes.push(`Multiple platform mentions detected: ${platformHints.map((hint) => hint.platform).join(', ')}. Using "${top?.platform ?? 'none'}".`);
  }
  if (top && top.confidence < 0.8) {
    notes.push(`Platform hint "${top.platform}" is weak — the model should confirm or pick a suitable controller.`);
  }

  const quantities = extractQuantities(text, features);
  const communicationHints: string[] = [];
  if (features.includes('bluetooth')) communicationHints.push('Bluetooth link to a phone/host required');
  if (features.includes('wifi')) communicationHints.push('Wi-Fi connectivity required');
  if (features.includes('telemetry')) communicationHints.push('Telemetry/reporting output required');

  const powerHints = extractVoltageHints(text);
  if (features.includes('battery_power')) powerHints.push('Battery powered — portable supply required');
  if (features.includes('motor_control')) powerHints.push('Motor loads present — a supply with headroom above stall current is required');

  const explicitParts = extractExplicitParts(text);
  const behaviours = extractBehaviours(text);

  if (features.length === 0) notes.push('No known feature signals matched — relying on the model to interpret the request.');
  if (behaviours.length === 0) notes.push('No explicit behaviour phrases detected.');

  return {
    prompt: text,
    features,
    quantities,
    platformHints,
    ...(top ? { detectedPlatform: top.platform } : {}),
    ...(top?.componentId ? { detectedPlatformComponentId: top.componentId } : {}),
    powerHints: [...new Set(powerHints)],
    communicationHints,
    behaviourPhrases: behaviours,
    explicitParts,
    notes,
  };
}

/** Compact JSON rendering used inside the generation prompt. */
export function formatAnalysisForPrompt(analysis: PromptAnalysis): string {
  return JSON.stringify(
    {
      detectedPlatform: analysis.detectedPlatform ?? null,
      detectedPlatformComponentId: analysis.detectedPlatformComponentId ?? null,
      features: analysis.features,
      quantities: analysis.quantities,
      explicitPartsMentioned: analysis.explicitParts,
      communicationHints: analysis.communicationHints,
      powerHints: analysis.powerHints,
      behaviourPhrases: analysis.behaviourPhrases,
      notes: analysis.notes,
    },
    null,
    2,
  );
}
