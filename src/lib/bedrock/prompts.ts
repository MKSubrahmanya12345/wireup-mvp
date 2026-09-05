/**
 * Bedrock prompt engineering.
 *
 * Two primary LLM operations (generation, validation) plus the targeted-fix
 * operation used by the agentic loop. Prompts are built from plain strings so
 * they are auditable and testable; the orchestrator decides WHEN they run.
 */

import type { ArtifactKind, ValidationIssueCode } from '@/types/validation';

/* ------------------------------------------------------------------------- */
/* Shared persona                                                             */
/* ------------------------------------------------------------------------- */

export const ENGINEER_PERSONA = `You are Wireup, a senior embedded hardware engineer agent.
You design real, buildable electronics projects: you pick real parts, respect datasheets,
plan power budgets, assign real pins, and write firmware that compiles.

Non-negotiable rules:
1. Only select components whose "componentId" appears in the COMPONENT DATABASE supplied to you.
   Never invent part names, part numbers or capabilities. If something suitable is missing,
   choose the closest catalog part and say so in "notes".
2. Every component needs a quantity and a concrete engineering reason for being in the build.
3. A microcontroller GPIO can never drive a motor, relay coil or high-current load directly.
   Always route through the appropriate driver from the catalog.
4. Every powered component needs an explicit power connection AND an explicit ground connection
   back to the common ground of the system. Missing ground is a fatal error.
5. Pin names must be real: use the exact pin names given in the catalog (GPIO25, IN1, OUT2, VCC, GND, A0, D5…).
6. Respect MCU pin restrictions listed in the MCU CAPABILITIES section (strapping pins, input-only pins,
   flash pins, pins shared with UART/I2C/SPI, ADC-capable pins, PWM-capable pins).
7. Do not fake precision. If a value is unknown, omit the field rather than guessing.
8. Answer with JSON ONLY. No markdown fences, no prose before or after, no trailing commas, no comments.

DIAGRAM GENERATION RULES (NON-NEGOTIABLE):
9. The backend, not the model, is the source of truth for diagram.json. Never invent diagram parts, pins, coordinates, or connections in prose or in an alternate schema.
10. The generated wiring graph must contain every electrical wire: signal, power, and ground. Every endpoint must use an exact catalog instance and exact catalog pin name.
11. A Wokwi export is a separate projection of the graph and MUST be the standard Wokwi shape: { version: 1, author, editor: "wokwi", parts: [], connections: [] }.
12. Wokwi parts use { type, id, top, left, attrs }; Wokwi connections are exactly ["partId:pin", "partId:pin", "color", []]. Do not put Wireup fields such as components, rails, groups, metadata, path, kind, or signal in diagram.json.
13. Use only verified simulator part ids and exact simulator pin names. If a catalog item has no verified simulator mapping, omit it from the Wokwi projection and report it; never guess a part id or pin name.
14. Preserve component instance identity when projecting: one Wokwi part per representable instance, unique ids, no duplicate wires, and no dangling endpoints. Wokwi attrs must be strings (for example an SSD1306 address is {"address":"0x3C"}).`;

/* ------------------------------------------------------------------------- */
/* CALL 1 — GENERATION                                                        */
/* ------------------------------------------------------------------------- */

export const GENERATION_JSON_CONTRACT = `Return a single JSON object with EXACTLY this shape:

{
  "project": { "name": "<short kebab or title case name>", "summary": "<1-2 sentences>" },

  "requirements": {
    "goal": "<what the user wants to end up with>",
    "summary": "<concise engineering summary>",
    "requirements": ["<explicit functional requirement>"],
    "inputs": ["<sensor/user/network input>"],
    "outputs": ["<motor/led/display/network output>"],
    "behaviors": ["<observable behavior, e.g. 'moves forward while F is held'>"],
    "constraints": ["<platform, size, voltage, cost constraints>"],
    "platformRequirements": ["<e.g. 'ESP32 required by user'>"],
    "communicationRequirements": ["<e.g. 'Bluetooth Classic SPP from a phone'>"],
    "powerRequirements": ["<e.g. 'motors need 6-9 V at up to 2 A stall'>"],
    "quantities": { "motors": 2 },
    "features": ["<signal tokens, e.g. 'bluetooth', 'motor_control', 'obstacle_avoidance'>"],
    "assumptions": ["<what you assumed because the prompt was silent>"],
    "ambiguities": ["<open question the user should answer>"]
  },

  "components": [
    {
      "componentId": "<exact id from COMPONENT DATABASE>",
      "name": "<catalog name>",
      "quantity": 2,
      "role": "controller|driver|sensor|actuator|communication|power|input|display|passive|prototyping|other",
      "reason": "<why this part, why this quantity>",
      "required": true,
      "instanceLabels": ["Left motor", "Right motor"],
      "notes": "<optional caveat>"
    }
  ],

  "hardwarePlan": {
    "summary": "<how the hardware hangs together>",
    "architecture": [
      { "id": "power", "name": "Power subsystem", "description": "...", "kind": "controller|power|drive|sensing|communication|actuation|support", "componentIds": ["battery-2s-lipo"] }
    ],
    "subsystems": [
      { "id": "drive", "name": "Drive train", "description": "...", "componentIds": [], "inputs": ["GPIO25..GPIO14"], "outputs": ["motor A", "motor B"] }
    ],
    "signalFlow": ["Bluetooth command", "Command parser", "Movement controller", "L298N driver", "DC motors"],
    "compatibility": [
      { "a": "<componentId>", "b": "<componentId>", "compatible": true, "reason": "<voltage/logic/current reasoning>" }
    ],
    "power": {
      "supplyComponentId": "<catalog id of the supply>",
      "supplyVoltage": 7.4,
      "notes": ["<budget reasoning: mA per rail, regulator drops, driver losses>"]
    },
    "risks": ["<what could go wrong and how the design mitigates it>"]
  },

  "pinAssignments": [
    {
      "componentId": "<catalog id of the peripheral>",
      "instanceIndex": 1,
      "pin": "<peripheral pin name, e.g. IN1>",
      "mcuPin": "<exact MCU pin name, e.g. GPIO25>",
      "purpose": "<what this pin does>",
      "signal": "digital|analog|pwm|uart|i2c|spi|one_wire|motor_drive|enable|interrupt",
      "direction": "input|output",
      "protocol": "gpio|uart|i2c|spi|adc|pwm|one_wire|other",
      "required": true
    }
  ],
  These are SUGGESTIONS. The deterministic pin planner validates every one against the MCU
  capability profile and overrides anything illegal. The pin planner's output — not this list —
  is the single source of truth that wiring, diagram.json and firmware are all built from.

  "wiring": [
    {
      "fromComponentId": "<catalog id>", "fromInstanceIndex": 1, "fromPin": "<pin>",
      "toComponentId": "<catalog id>", "toInstanceIndex": 1, "toPin": "<pin>",
      "kind": "power|ground|signal",
      "signal": "digital|analog|pwm|uart|i2c|spi|one_wire|motor_drive|enable|interrupt|power|ground",
      "explanation": "<why this wire exists>"
    }
  ],
  Include EVERY wire: signal wires, power wires and ground wires. Also include non-MCU wires
  such as motor driver outputs to motors, and sensor VCC/GND to the rail.

  "softwarePlan": {
    "architecture": "<firmware architecture in a few sentences>",
    "language": "arduino-cpp",
    "framework": "Arduino",
    "modules": [{ "id": "command_parser", "name": "Command parser", "responsibility": "...", "dependsOn": ["bluetooth_link"] }],
    "libraries": [{ "name": "...", "import": "...", "purpose": "...", "manager": "arduino", "builtIn": false }],
    "controlStates": [{ "id": "idle", "name": "Idle", "description": "...", "transitions": [{ "to": "forward", "when": "command 'F' received" }] }],
    "inputHandling": ["<how inputs are read/debounced/parsed>"],
    "sensorLogic": ["<sampling rates, filtering, thresholds>"],
    "actuatorLogic": ["<how outputs are driven, PWM frequencies, ramping>"],
    "communication": { "protocol": "Bluetooth Classic SPP", "transport": "Serial2/BluetoothSerial", "details": "...", "commandSet": [{ "command": "F", "meaning": "forward", "response": "ok:F" }] },
    "safety": ["<watchdog, failsafe timeout, current limiting>"],
    "loopStrategy": "<non-blocking millis based loop description>",
    "files": [{ "path": "sketch.ino", "purpose": "..." }]
  },
  Do NOT write firmware source in this call. Firmware is produced by a separate, later step that
  receives the authoritative pin plan resolved by the backend. Your job here is the DESIGN:
  parts, requirements, software architecture. The softwarePlan must describe behaviour well
  enough that firmware can be written from it plus the pin map alone.

  "libraries": [{ "name": "...", "import": "...", "purpose": "...", "manager": "arduino", "version": "", "repository": "", "builtIn": false }],

  "instructions": {
    "markdown": "<full README-style markdown>",
    "sections": [
      { "id": "overview", "title": "Overview", "body": "...", "order": 1 },
      { "id": "bill-of-materials", "title": "Bill of materials", "body": "...", "order": 2 },
      { "id": "wiring", "title": "Wiring", "body": "...", "order": 3 },
      { "id": "power", "title": "Power", "body": "...", "order": 4 },
      { "id": "software-setup", "title": "Software setup", "body": "...", "order": 5 },
      { "id": "flashing", "title": "Flashing", "body": "...", "order": 6 },
      { "id": "usage", "title": "Usage", "body": "...", "order": 7 },
      { "id": "troubleshooting", "title": "Troubleshooting", "body": "...", "order": 8 }
    ]
  },

  "notes": ["<anything the reviewer should know>"]
}`;

export interface GenerationPromptInput {
  prompt: string;
  requirementsDraft: string;
  catalogContext: string;
  mcuContext: string;
  extraGuidance?: string;
}

export function buildGenerationUserPrompt(input: GenerationPromptInput): string {
  return `USER PROJECT REQUEST:
"""
${input.prompt}
"""

PRE-ANALYSIS (heuristics — verify, correct or extend it, do not copy blindly):
${input.requirementsDraft}

COMPONENT DATABASE (the ONLY parts you may use):
${input.catalogContext}

MCU CAPABILITIES (pin restrictions and protocol pins):
${input.mcuContext}
${input.extraGuidance ? `\nADDITIONAL GUIDANCE:\n${input.extraGuidance}\n` : ''}
${GENERATION_JSON_CONTRACT}

Design the complete project now. Reply with the JSON object only.`;
}

/* ------------------------------------------------------------------------- */
/* CALL 2 — FIRMWARE (against the resolved pin map, never its own pins)       */
/* ------------------------------------------------------------------------- */

export const FIRMWARE_PERSONA = `FIRMWARE AUTHORING LAW (NON-NEGOTIABLE):
F1. The RESOLVED PIN MAP supplied to you is the single source of truth for every GPIO.
    Do NOT select, infer, modify, re-number or optimize pins. Not one.
F2. Reference pins ONLY through the PIN_* constants listed in the map
    (e.g. pinMode(PIN_LED_5MM_1_A, OUTPUT); digitalWrite(PIN_LED_5MM_1_A, HIGH);).
    Never write a bare pin number or a bare A<n> literal as a pin argument,
    and never redeclare or redefine a PIN_* constant — the build injects them.
F3. If you want a friendly alias, define it IN TERMS OF the map constant:
    const int BUTTON_PIN = PIN_PUSHBUTTON_6MM_1_1;  — never a literal.
F4. Shared bus pins (I2C SDA/SCL, SPI) are owned by their library: call Wire.begin()
    in setup() before any I2C init, and never pinMode()/digitalWrite() those pins.
F5. If a behaviour seems to need a pin that is not in the map, do NOT invent one.
    Implement what the map allows and add a "notes" entry describing the gap.`;

export const FIRMWARE_JSON_CONTRACT = `Return a single JSON object with EXACTLY this shape:

{
  "files": [
    { "path": "sketch.ino", "language": "arduino", "purpose": "<one line>", "content": "<complete, compilable source>" }
  ],
  "notes": ["<anything the reviewer should know, including map gaps>"]
}

Firmware rules: complete and compilable, no placeholders, no TODOs, no pseudo-code.
Implement setup() and loop() and the FULL behaviour described by the software plan,
including the communication failsafe when the build has motors and a control link.
Include ONLY the libraries listed below — no extra headers (e.g. do not include
Adafruit_Sensor.h for an SSD1306 display). Write I2C addresses as hex literals taken
from the component data (#define OLED_ADDRESS 0x3C, never a decimal). Buttons use
INPUT_PULLUP (pressed == LOW) with software debounce. Refresh a display after every
state change and once at the end of setup(). Prefer a non-blocking millis() loop.`;

export interface FirmwarePromptInput {
  /** Original user request. */
  prompt: string;
  /** Normalised requirements (goal, behaviours, safety) as formatted text. */
  requirements: string;
  /** The software plan produced from the design call, as formatted text. */
  softwarePlan: string;
  /**
   * The authoritative pin map rendered by `formatResolvedPinMapForPrompt`.
   * This is the ONLY pin information the model may act on.
   */
  resolvedPinMap: string;
  /** Serial links (id, pins, baud) the pin planner reserved, as formatted text. */
  serialLinks: string;
  /** I2C buses (SDA/SCL, devices @ addresses) as formatted text. */
  i2cBuses: string;
  /** Library manifest entries as formatted text (name + header + purpose). */
  libraries: string;
  controllerName: string;
  projectName: string;
}

export function buildFirmwareUserPrompt(input: FirmwarePromptInput): string {
  return `PROJECT: ${input.projectName}
CONTROLLER: ${input.controllerName}

ORIGINAL USER REQUEST:
"""
${input.prompt}
"""

REQUIREMENTS:
${input.requirements}

SOFTWARE PLAN (implement exactly this behaviour):
${input.softwarePlan}

RESOLVED PIN MAP — AUTHORITATIVE. Every GPIO the firmware touches MUST come from this map.
The constants below are declared for you in the final sketch; reference them by name:
${input.resolvedPinMap}

SERIAL LINKS RESERVED BY THE PIN PLANNER (use these exact ids/pins):
${input.serialLinks}

I2C BUS(ES) (shared; addresses are fixed — call Wire.begin() first, never pinMode SDA/SCL):
${input.i2cBuses}

LIBRARIES AVAILABLE (the ONLY headers you may include):
${input.libraries}

${FIRMWARE_JSON_CONTRACT}

Write the complete firmware now. Reply with the JSON object only.`;
}

/* ------------------------------------------------------------------------- */
/* CALL 3 — VALIDATION                                                        */
/* ------------------------------------------------------------------------- */

export const ISSUE_CODE_LIST: ValidationIssueCode[] = [
  'missing_controller',
  'missing_component',
  'unknown_component',
  'invented_component',
  'incompatible_components',
  'gpio_conflict',
  'reserved_pin_used',
  'input_only_pin_driven',
  'capability_mismatch',
  'motor_on_mcu_pin',
  'missing_ground',
  'missing_power',
  'invalid_voltage',
  'output_to_output',
  'unknown_pin',
  'dangling_reference',
  'duplicate_connection',
  'floating_required_pin',
  'diagram_out_of_sync',
  'diagram_missing_component',
  'diagram_missing_connection',
  'code_pin_mismatch',
  'code_missing_include',
  'code_stray_include',
  'code_i2c_address_invalid',
  'code_missing_bus_init',
  'code_missing_setup_loop',
  'code_unbalanced_braces',
  'library_missing',
  'library_unused',
  'instructions_missing_section',
  'instructions_out_of_sync',
  'power_budget_exceeded',
  'requirement_uncovered',
];

export const VALIDATION_JSON_CONTRACT = `Return a single JSON object with EXACTLY this shape:

{
  "verdict": "approve" | "needs_changes" | "reject",
  "confidence": 0.0,
  "issues": [
    {
      "code": "<one of the allowed issue codes>",
      "severity": "error" | "warning" | "info",
      "domain": "requirements|components|compatibility|pins|wiring|power|code|diagram|libraries|instructions",
      "message": "<one line, specific, names the exact pin/part/file>",
      "details": "<why it is wrong, with the engineering reasoning>",
      "fixHint": "<the smallest change that fixes it>",
      "target": {
        "artifact": "requirements|components|hardwarePlan|pinAssignments|wiring|softwarePlan|code|diagram|libraries|instructions",
        "componentId": "<optional>",
        "componentInstanceId": "<optional>",
        "selectionId": "<optional>",
        "pin": "<optional>",
        "assignmentId": "<optional>",
        "connectionId": "<optional>",
        "filePath": "<optional>",
        "library": "<optional>",
        "sectionId": "<optional>"
      }
    }
  ],
  "notes": ["<positive observations or context for the fixer>"]
}

Allowed issue codes: ${ISSUE_CODE_LIST.join(', ')}.

Review standards:
- Be adversarial. Your job is to find what a hardware reviewer would reject.
- Only report an issue if you can point at concrete evidence in the supplied project.
- "error" means the build is broken or unsafe. "warning" means risky or suboptimal. "info" is advisory.
- Do NOT report style preferences, do NOT invent issues to look thorough, and do NOT restate the design.
- Check especially: hand-written pin constants that disagree with pinAssignments, I2C addresses that are
  not hex literals or differ from the catalog, Wire.begin() missing when an I2C device is used, includes for
  libraries that are not in the plan, GPIO conflicts, reserved/strapping/input-only pins, motors driven from GPIO,
  missing ground or power connections, voltage mismatches between logic and drive rails,
  power budget versus supply capability, code pin numbers versus pinAssignments,
  missing #include for every used library, diagram references that do not exist,
  and requirements from the user prompt that the design does not actually cover.
- Prefer at most 12 well-argued issues over a long shallow list.`;

export interface ValidationPromptInput {
  prompt: string;
  requirements: string;
  components: string;
  hardwarePlan: string;
  pinAssignments: string;
  wiring: string;
  softwarePlan: string;
  code: string;
  diagram: string;
  libraries: string;
  instructions: string;
  catalogContext: string;
  mcuContext: string;
  ruleEngineFindings: string;
  iteration: number;
}

export function buildValidationUserPrompt(input: ValidationPromptInput): string {
  return `You are reviewing iteration ${input.iteration} of a generated hardware project.

ORIGINAL USER REQUEST:
"""
${input.prompt}
"""

REQUIREMENTS:
${input.requirements}

SELECTED COMPONENTS (with quantities and reasons):
${input.components}

HARDWARE PLAN / POWER BUDGET:
${input.hardwarePlan}

PIN ASSIGNMENTS:
${input.pinAssignments}

WIRING GRAPH:
${input.wiring}

SOFTWARE PLAN:
${input.softwarePlan}

SOURCE CODE:
${input.code}

DIAGRAM (diagram.json summary):
${input.diagram}

LIBRARIES (libraries.json):
${input.libraries}

INSTRUCTIONS:
${input.instructions}

COMPONENT DATABASE (ground truth for parts, pins and electrical limits):
${input.catalogContext}

MCU CAPABILITIES:
${input.mcuContext}

DETERMINISTIC RULE ENGINE FINDINGS (already detected — confirm, extend, or refute with reasoning;
do not simply repeat them):
${input.ruleEngineFindings}

${VALIDATION_JSON_CONTRACT}

Reply with the JSON object only.`;
}

/* ------------------------------------------------------------------------- */
/* CALL 4 — TARGETED FIX                                                      */
/* ------------------------------------------------------------------------- */

export const FIX_JSON_CONTRACT = `Return a single JSON object with EXACTLY this shape:

{
  "changes": [
    { "artifact": "<artifact>", "op": "<op>", "reason": "<why>", "issueId": "<id>", ...op payload }
  ],
  "notes": ["<anything the orchestrator should know>"]
}

Allowed ops (payload keys in brackets):
- artifact "pinAssignments":
  - "set_pin_assignment"      [assignmentId?, assignment: { pin, targetInstanceId, targetPin, purpose?, signal?, direction?, protocol?, rationale? }]
  - "remove_pin_assignment"   [assignmentId]
- artifact "wiring":
  - "add_connection"          [connection: { fromComponentId, fromInstanceIndex, fromPin, toComponentId, toInstanceIndex, toPin, kind, signal, explanation }]
  - "replace_connection"      [connectionId, connection?|fromPin?|toPin?]
  - "remove_connection"       [connectionId]
- artifact "components":
  - "add_component"           [componentId, quantity, reason, role, required?]
  - "replace_component"       [selectionId, componentId?, quantity?, reason?, role?]
  - "remove_component"        [selectionId]
  - "set_quantity"            [selectionId, quantity]
- artifact "code":
  - "patch_code_file"         [path, mode: "replace"|"append"|"prepend"|"find_replace"|"regex_replace", content?|find?|replace?]
  - "add_code_file"           [path, language, content, purpose?]
  - "remove_code_file"        [path]
- artifact "libraries":
  - "add_library"             [library: { name, import, purpose, manager?, version?, builtIn? }]
  - "remove_library"          [libraryName]
  - "set_libraries"           [libraries: [...]]
- artifact "instructions":
  - "patch_instructions"      [sectionId, mode: "replace"|"append", content]
- artifact "requirements":
  - "set_field"               [field, value]
- any artifact:
  - "rerun_stage"             [stage: "pins"|"wiring"|"diagram"|"instructions"|"libraries"|"code"]

Hard rules for fixing:
1. MINIMAL, TARGETED changes only. Fix the reported issues and nothing else.
2. NEVER restate or rewrite artifacts that are not broken. Do not return a whole new project.
3. Preserve every id you are not explicitly changing (instanceIds, connectionIds, assignmentIds).
4. Use exact catalog component ids and exact pin names from the supplied data.
5. Prefer "rerun_stage" when an artifact is merely out of sync with an upstream artifact
   (e.g. diagram after a pin change) instead of hand-editing it.
6. The pin plan is the single source of truth and is OWNED by the backend. NEVER patch
   firmware to introduce, move or renumber a GPIO pin yourself — code patches must reference
   the PIN_* constants declared in the supplied pin map. After any pin change the backend
   re-synchronises firmware, wiring and diagram automatically; your job is the upstream fix.`;

export interface FixPromptInput {
  prompt: string;
  issues: string;
  projectContext: string;
  relevantArtifact: string;
  artifactKind: ArtifactKind;
  catalogContext: string;
  mcuContext: string;
  iteration: number;
}

export function buildFixUserPrompt(input: FixPromptInput): string {
  return `Iteration ${input.iteration}: the generated project FAILED validation. Produce a targeted changeset.

ORIGINAL USER REQUEST:
"""
${input.prompt}
"""

VALIDATION ISSUES TO FIX:
${input.issues}

CURRENT PROJECT STATE (ids are authoritative — reference them exactly):
${input.projectContext}

PRIMARY ARTIFACT UNDER REPAIR ("${input.artifactKind}"):
${input.relevantArtifact}

COMPONENT DATABASE:
${input.catalogContext}

MCU CAPABILITIES:
${input.mcuContext}

${FIX_JSON_CONTRACT}

Reply with the JSON object only.`;
}
