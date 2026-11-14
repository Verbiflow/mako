/**
 * How Mako's web client behaves on a phone and a tablet, case by case, as data: what a person would say happened, the
 * steps that make it happen, and the measures it's graded on (`grade.ts`), each within its budget. A `guard` holds
 * what ships and must pass everywhere it runs; a `bad` case is written before its fix and fails until it lands; a
 * `control` is a run where nothing should happen, so a measure that moves there is the harness's, not the app's.
 *
 * A case says what it needs of its target (`needs`): the WebKit stand-in has no software keyboard, no microphone and
 * no signed-in Thread, so those cases run on a simulator only and the stand-in's summary lists them as not run.
 */

export type MobileForm = "phone" | "tablet"

/** A point on the page, as fractions of its width and height, so a case reads the same on an iPhone and an iPad. */
export type PagePoint = readonly [x: number, y: number]

export type MobileStep =
  /** The phone's live Session over a long conversation (`src/dev/phone-scroll-check.tsx`), `turns` before the newest. */
  | { do: "open-fixture"; turns?: number }
  /** The newest turn's answer grows by `perBatch` words every `everyMs`, as the host's batches bring it, for `forMs`. */
  | { do: "stream"; everyMs: number; perBatch: number; forMs: number }
  | { do: "stop-stream" }
  | { do: "swipe"; from: PagePoint; to: PagePoint; ms: number }
  | { do: "wait"; ms: number }
  | { do: "keyboard"; shown: boolean }
  /** Starts or stops the frame sampler (`sampler.ts`); the measures are read from what it took between. */
  | { do: "sample"; on: boolean }
  /** Marks the moment the reader stopped touching, from which `driftPx` is measured. */
  | { do: "mark-still" }

export type MobileNeed = "keyboard" | "microphone" | "signed-in"

/** What a case ran on, as the target says it: a simulator's own name, its device type and its iOS. */
export interface MobileDevice {
  name: string
  /** `com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro`. */
  type?: string
  runtime?: string
}

/** A summary's name for a device, from what it is and never from what a form is expected to be. */
export function deviceLabel(device: MobileDevice): string {
  const type = device.type?.replace(/^com\.apple\.CoreSimulator\.SimDeviceType\./, "").replaceAll("-", " ")
  const about = [type, device.runtime].filter(Boolean).join(", ")
  return about ? `${device.name} (${about})` : device.name
}

export interface MobileCase {
  id: string
  kind: "guard" | "bad" | "control"
  forms: readonly MobileForm[]
  needs?: readonly MobileNeed[]
  /** In a person's words: what happened before the fix, or what they count on after it. */
  experience: string
  steps: readonly MobileStep[]
  /** The measures it's graded on; each holds within `BUDGETS` unless the case says its own. */
  measures: readonly MetricId[]
  budgets?: Partial<Record<MetricId, number>>
}

export type MetricId = "backwardPx" | "teleports" | "maxFromEndPx" | "slowFramePct" | "driftPx" | "shiftPx" | "keyboardFromEndPx" | "newestMs" | "dictationStopMs"

/** Each measure's budget: the most it may be. A frame over budget is one and a half frames at 60 Hz. */
export const BUDGETS = {
  backwardPx: 2,
  teleports: 0,
  maxFromEndPx: 160,
  slowFramePct: 10,
  driftPx: 1,
  shiftPx: 4,
  keyboardFromEndPx: 24,
  newestMs: 300,
  dictationStopMs: 100,
} as const satisfies Record<MetricId, number>

const ALL: readonly MobileForm[] = ["phone", "tablet"]

export const CASES: readonly MobileCase[] = [
  {
    id: "follows-the-end-while-streaming",
    kind: "guard",
    forms: ALL,
    experience: "I'm at the bottom while the answer streams, and it stays at the bottom without jumping.",
    steps: [{ do: "open-fixture", turns: 40 }, { do: "sample", on: true }, { do: "stream", everyMs: 50, perBatch: 3, forMs: 3_000 }, { do: "stop-stream" }, { do: "sample", on: false }],
    measures: ["backwardPx", "teleports", "maxFromEndPx", "slowFramePct"],
  },
  {
    id: "holds-my-place-after-scrolling-up",
    kind: "guard",
    forms: ALL,
    experience: "I scroll up to read while it streams, and what I'm reading stays put.",
    steps: [
      { do: "open-fixture", turns: 40 },
      { do: "stream", everyMs: 50, perBatch: 3, forMs: 600 },
      // A short swipe, so the answer still streams in view below the reader on both forms.
      { do: "swipe", from: [0.5, 0.45], to: [0.5, 0.6], ms: 220 },
      { do: "wait", ms: 700 },
      { do: "mark-still" },
      { do: "sample", on: true },
      { do: "stream", everyMs: 50, perBatch: 3, forMs: 2_000 },
      { do: "stop-stream" },
      { do: "sample", on: false },
    ],
    measures: ["driftPx", "teleports", "slowFramePct"],
  },
  {
    id: "a-still-page-stays-still",
    kind: "control",
    forms: ALL,
    experience: "Nothing is happening, and nothing moves.",
    steps: [{ do: "open-fixture", turns: 40 }, { do: "wait", ms: 500 }, { do: "sample", on: true }, { do: "wait", ms: 1_500 }, { do: "sample", on: false }],
    measures: ["shiftPx", "teleports"],
  },
  {
    id: "the-keyboard-keeps-the-end",
    kind: "guard",
    forms: ["phone"],
    needs: ["keyboard"],
    experience: "I tap the composer at the bottom of a Thread, and the newest message stays in view above the keyboard.",
    steps: [{ do: "open-fixture", turns: 40 }, { do: "keyboard", shown: true }, { do: "wait", ms: 600 }, { do: "sample", on: true }, { do: "wait", ms: 300 }, { do: "sample", on: false }],
    measures: ["keyboardFromEndPx"],
  },
  {
    id: "a-thread-opens-on-its-newest-turn",
    kind: "guard",
    forms: ALL,
    needs: ["signed-in"],
    experience: "I open a Thread I read earlier, and its newest message is there at once.",
    steps: [{ do: "wait", ms: 2_000 }],
    measures: ["newestMs"],
  },
  {
    id: "dictation-stops-when-i-press-stop",
    kind: "guard",
    forms: ["phone"],
    needs: ["microphone", "signed-in"],
    experience: "I press stop while dictating, and it stops listening right away.",
    steps: [{ do: "wait", ms: 2_000 }],
    measures: ["dictationStopMs"],
  },
]
