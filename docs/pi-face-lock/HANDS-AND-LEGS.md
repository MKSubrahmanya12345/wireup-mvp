# Hands & legs — the human-as-a-tool protocol

> *"the AI uses the human's hands and legs as a tool itself"*

An agent building physical hardware has a hard limit: it can reason about
reality but cannot touch it. It cannot plug in a ribbon cable, read the text on
a screen, smell a burnt MOSFET, or measure a door frame. Today Wireup papers
over this by emitting `instructions.md` — a static document, produced at the
*end*, that nobody reports back into. That is a dead end, and it is why
generated hardware projects "finish" without ever working.

This document specifies the replacement: **the human is a callable tool,
invoked mid-run, whose return value is a grounded fact.**

---

## 1. Where this sits

The pattern is established in agent frameworks — LangGraph's
`interrupt()`/resume, CrewAI's `HumanTool`, HumanLayer's `human_as_tool()`
[1](https://www.permit.io/blog/human-in-the-loop-for-ai-agents-best-practices-frameworks-use-cases-and-demo),
and the "human as a tool" evolution of HITL where the human is *invoked during
reasoning* rather than auditing a finished result
[2](https://www.turingpost.com/p/humanaico). LangChain's interrupt model even
separates four decision types — approve / edit / reject / **respond**, where
`respond` is the one that means "the human *is* the tool"
[3](https://docs.langchain.com/oss/python/langchain/human-in-the-loop).

What none of those frameworks have is the thing hardware needs: **the human as
a sensor and actuator, not just an approver.** So the protocol adds two verbs
they don't have — `do` and `observe` — and requires the return value to be
structured evidence, not prose.

---

## 2. The four verbs

| Verb | Meaning | Returns | Blocks the run? |
| --- | --- | --- | --- |
| `ask` | A decision only the human can make. Always offered with a default. | `choice` \| `text` \| `number` | Yes, if `blocking` |
| `do` | A physical action: plug it in, run this command, press it, solder it. | `text` + `terminal` \| `photo` | Yes |
| `observe` | Report what reality says: LED colour, screen text, multimeter value. | `measurement` \| `text` \| `boolean` \| `photo` | Yes |
| `verify` | A check with an explicit pass criterion. The agent grades the answer itself. | `boolean` + evidence | Yes |

`do` and `observe` are the new ones. `ask` ≈ `respond`, and an approval
task ≈ `approve`/`reject`.

### Shape

```ts
interface HumanTask {
  id: string;
  verb: 'ask' | 'do' | 'observe' | 'verify';
  title: string;                 // one line, imperative: "Plug the CSI ribbon into CAM1"
  why: string;                   // why the agent cannot do this itself
  thenWhat: string;              // what the agent will do with the answer — always stated
  steps?: string[];              // ordered sub-steps for `do`
  command?: string;              // exact command, copy-pasteable, for `do`
  answer: AnswerSpec;            // choice | text | number | boolean | measurement | terminal | photo
  default?: unknown;             // used if the human skips — never blocks forever
  risk?: 'none' | 'caution' | 'high';   // high = mains / structural / destructive
  blocking: boolean;
  dependsOn?: string[];
  fact?: string;                 // fact key this task grounds, e.g. "camera.detected"
}
```

### Lifecycle

```
open ──claim──▶ claimed ──submit──▶ submitted ──▶ accepted
  │                                     │
  └──skip──▶ skipped (default applied)  └──▶ rejected (re-asked, with the reason)
```

Every transition is an event on the project log, so the agent console shows
exactly who did what and when.

---

## 3. Return values are facts, not messages

This is the part that makes it worth building. A completed task with a `fact`
key writes into `project.humanFacts`:

```ts
{ key: 'camera.detected', value: 'imx708',
  sourceTaskId: 'task_07', at: '2026-09-09T…', confidence: 'reported' }
```

Downstream stages read facts **instead of guessing**:

| Fact | Changes |
| --- | --- |
| `camera.detected = 'imx708'` | codegen emits `Picamera2` config for that sensor, not a generic V4L2 path |
| `gpio.lock_actuates = true` | closes the actuator loop; if `false`, the agent replans the driver stage |
| `power.brownout = true` | power stage re-plans around a bigger supply |
| `install.mounting_height_mm = 1520` | detection `minSize` and lens FOV recalculated |
| `lighting.backlit = true` | flips the camera recommendation to NoIR + IR ring |

A fact marked `confidence: 'reported'` is never silently trusted when it
conflicts with a catalog value — that raises a validation issue instead. The
human's word is evidence, not gospel.

---

## 4. Rules the agent follows

1. **Never ask what it can look up.** Datasheets, pinouts, package versions —
   the agent's job. Asking is an admission it already lost.
2. **Never drip-feed.** Batch every independent ask into one checkpoint.
   One interruption, not nine.
3. **Always give a default and say what happens if you skip.** A task with no
   default is a bug.
4. **Always state `why` and `thenWhat`.** "I need this because I can't see the
   board" + "then I'll pick the driver stage." No unexplained chores.
5. **Exact commands, copy-pasteable.** `sudo libcamera-hello --list-cameras`,
   not "check whether the camera works".
6. **Say what a good result looks like.** "Expect one line reading
   `0 : imx708 [4608x2592]`. If it says `No cameras available!`, stop and tell me."
7. **High-risk tasks demand a typed confirmation** and carry a hazard line.
   Mains voltage, load-bearing door hardware, and anything destructive are
   never casual.
8. **Deadlines and skips are first-class.** If a task is skipped, the default
   is applied and *recorded as an assumption* — never silently.
9. **`instructions.md` becomes a rendering of the completed task list**, not a
   separate hand-written document. One source of truth.

---

## 5. Worked example — the actual commissioning sequence for this build

| # | Verb | Task | Fact |
| --- | --- | --- | --- |
| 1 | `ask` | Which Pi / camera / lock? (defaults pre-filled) | `hw.*` |
| 2 | `ask` | Is this the only exit from the room? | `safety.sole_egress` |
| 3 | `do` | Flash Raspberry Pi OS Lite 64-bit, boot, `ssh` in | `host.reachable` |
| 4 | `observe` | Run `libcamera-hello --list-cameras`, paste output | `camera.detected` |
| 5 | `do` | `sudo apt install -y python3-picamera2 python3-opencv` | `host.deps` |
| 6 | `verify` | Run the capture probe; does it print a frame shape? | `camera.streams` |
| 7 | `do` | Wire MOSFET + solenoid **without** the Pi connected; bench-test at 12 V | `bench.lock_moves` |
| 8 | `observe` | Multimeter: gate-to-ground voltage while GPIO is driven high | `gpio.drive_voltage` |
| 9 | `verify` | Drive the GPIO; does the bolt retract? | `gpio.lock_actuates` |
| 10 | `do` | Mount camera at the door; measure height and distance | `install.mounting_*` |
| 11 | `observe` | Stand where a user would stand; paste the detection debug frame stats | `vision.fps`, `vision.det_size` |
| 12 | `do` | Enroll: `facelock enroll --name X` (10 samples, move your head) | `enroll.count` |
| 13 | `verify` | Present a **photo** of an enrolled face to the camera | `spoof.photo_rejected` |
| 14 | `verify` | Real enrolled person → unlocks within 2 s | `e2e.unlocks` |
| 15 | `verify` | Unknown person → stays locked, logged as `denied` | `e2e.denies` |
| 16 | `observe` | Kill power to the Pi. What does the door do? | `safety.power_loss_state` |

Step 16 is the one that matters most and the one no generated README has ever
asked. It is also the one where a wrong answer means someone gets trapped.

---

## 6. API surface (increment 2)

```
GET    /api/projects/:id/tasks          → { tasks, facts, pending, blocking }
POST   /api/projects/:id/tasks          → create (agent-side, internal)
POST   /api/projects/:id/tasks/:taskId  → claim | submit | skip (human-side)
```

`submit` body: `{ answer, evidence?, note? }`.

---

## 7. Related

- `HUMAN-INPUT.md` — the questions, with defaults.
- `README.md` — where this sits in the roadmap.
