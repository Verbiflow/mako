import { useCallback, useEffect, useRef, useState } from "react"
import { noteDictation } from "./diagnostics"

/** The browser's speech recognition, as Chrome and Safari name it: only what the composer uses. */
export interface Recognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: RecognitionResults) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
}
interface RecognitionResults {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}
export type RecognitionClass = new () => Recognition

declare global {
  interface Window {
    SpeechRecognition?: RecognitionClass
    webkitSpeechRecognition?: RecognitionClass
    webkitAudioContext?: typeof AudioContext
  }
}

function recognitionClass(): RecognitionClass | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition
}

/** Whether this browser recognizes speech itself: Chrome on Android, Safari on an iPhone (14.5 on). */
export function dictationOffered(): boolean {
  return recognitionClass() !== undefined
}

/** How many bars the meter draws: the newest sample at the right, each 80 ms older to its left. */
export const METER_BARS = 5
/** One sample every 80 ms, so five bars span 400 ms of speech. */
export const METER_MS = 80
const NOISE_FLOOR_DB = -60
const NOISE_FLOOR = 10 ** (NOISE_FLOOR_DB / 20)
/** The words still being heard that are drawn dimmed: the recognizer changes its last few most. */
export const UNSURE_WORDS = 3
/** Where this browser remembers that its microphone can't feed a meter while it recognizes speech. */
const NO_METER_KEY = "mako.dictation.meter"
/** Restarts after silence that come this close together, with nothing heard, are a recognizer that won't listen. */
const RESTART_WINDOW_MS = 4_000
const RESTARTS_ALLOWED = 4
/**
 * After a stop, how long the recognizer has to settle its last words. Listening is over at the press whatever the
 * recognizer does; past this, what it was still hearing is taken as said and it's let go, ended or not.
 */
export const STOP_GRACE_MS = 1_000
/** When the meter's loudest reading so far is reported: long enough to have heard a word. */
const LEVELS_REPORT_MS = 2_000

/**
 * A loudness reading of 0 to 1 from decibels: nothing at the −60 dB floor or under it, 1 at 0 dB, and the amplitude
 * between scaled by its square root, so quiet speech still moves the bars.
 */
export function meterLevel(decibels: number | undefined): number {
  if (decibels === undefined || !Number.isFinite(decibels) || decibels <= NOISE_FLOOR_DB) return 0
  if (decibels >= 0) return 1
  const amplitude = 10 ** (decibels / 20)
  return Math.sqrt((amplitude - NOISE_FLOOR) / (1 - NOISE_FLOOR))
}

/** The loudness of one frame of samples centred on 128 (an analyser's bytes), in decibels. */
export function frameDecibels(samples: ArrayLike<number>): number {
  let sum = 0
  for (let index = 0; index < samples.length; index++) {
    const value = (samples[index]! - 128) / 128
    sum += value * value
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity
}

/** The words still being heard, split where the dimmed tail begins. */
export interface UnsureSplit {
  sure: string
  unsure: string
}

export function splitUnsure(words: string): UnsureSplit {
  const parts = words.trim().split(/\s+/).filter(Boolean)
  const cut = Math.max(0, parts.length - UNSURE_WORDS)
  return { sure: parts.slice(0, cut).join(" "), unsure: parts.slice(cut).join(" ") }
}

/** How long it has listened, as a recording says it: "0:07", "1:42", "12:05". */
export function elapsedWords(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** Joins settled words onto what the field holds, with one space between, never replacing it. */
export function appendHeard(draft: string, words: string): string {
  const said = words.trim()
  if (!said) return draft
  if (!draft.trim()) return said
  return /\s$/.test(draft) ? `${draft}${said}` : `${draft} ${said}`
}

const QUIET: readonly number[] = Array.from({ length: METER_BARS }, () => 0)

/**
 * The meter's samples, oldest first, each 0 to 1: read by the bars as they're drawn, never through React. A sample comes
 * every 80 ms, and a render of the composer for each would redraw its field, its chips and its button with it.
 */
export class MeterLevels {
  #levels: readonly number[] = QUIET
  readonly #listeners = new Set<(levels: readonly number[]) => void>()

  get(): readonly number[] {
    return this.#levels
  }

  set(levels: readonly number[]): void {
    this.#levels = levels
    for (const listener of this.#listeners) listener(levels)
  }

  /** Calls `listener` with each sample from now on; returns the way to stop. */
  subscribe(listener: (levels: readonly number[]) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}

export interface Dictation {
  offered: boolean
  listening: boolean
  failure?: string
  /** When it began listening, for its timer. */
  since?: number
  /** The meter, sampled every 80 ms: drawn by subscribing, so a sample renders nothing. */
  levels: MeterLevels
  /** Heard but not settled: drawn after the draft, never written into it. */
  hearing: string
  start: () => void
  /** Stops listening at once; what's still being heard settles into the draft within `STOP_GRACE_MS`. */
  stop: () => void
  /** Stops listening now, dropping what's still being heard (a send took it already). */
  cancel: () => void
}

/** How a stretch of dictation went, for the device's diagnostics: never a word of what was heard. */
export type DictationStep =
  | { step: "started" }
  /** The meter's loudest reading in its first seconds, 0 to 1, and what drew the bars: the microphone or the words. */
  | { step: "levels"; peak: number; meter: "analyser" | "words" }
  | { step: "stop-pressed"; ms: number }
  /** The recognizer ended `ms` after the stop was pressed, or after it began for one it ended itself. */
  | { step: "stopped"; ms: number; restarts: number }
  | { step: "failed"; error: string; ms: number; restarts: number }
  /** The recognizer hadn't ended `STOP_GRACE_MS` after the stop: it was let go. */
  | { step: "stop-overdue"; ms: number }

/** `stop`: listening ends now and the recognizer settles its last words. `settle`: they're taken as heard, now. `drop`: they're dropped. */
export type DictationEnd = "stop" | "settle" | "drop"

/**
 * Dictation into the composer by the platform's own recognizer, the one its keyboard's dictation uses: no sound goes
 * anywhere else. Settled words go to `onSettled` as they arrive, for the composer to append to its draft; the words still
 * being heard are `hearing`, shown and never written. It listens until it's stopped: a recognizer that ends on silence
 * is started again, and one that stops on a failure keeps what it heard, its last guess included, and says why.
 *
 * The meter is a Web Audio analyser on the microphone, sampled every 80 ms. Where the browser won't share the
 * microphone between it and the recognizer (the recognizer fails as the analyser opens it, or the analyser hears only
 * silence while words arrive), the meter is let go, remembered for this browser, and the bars move with the words
 * heard instead.
 */
export function useDictation(onSettled: (words: string) => void): Dictation {
  const [listening, setListening] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [since, setSince] = useState<number | undefined>(undefined)
  const [levels] = useState(() => new MeterLevels())
  const [hearing, setHearing] = useState("")
  const settled = useRef(onSettled)
  useEffect(() => {
    settled.current = onSettled
  }, [onSettled])
  const session = useRef<DictationSession | null>(null)
  useEffect(() => {
    // A page put away is a recognizer the platform may end without a word: what it heard is kept, and it's over.
    const away = () => session.current?.end("settle")
    const hidden = () => document.visibilityState === "hidden" && away()
    addEventListener("pagehide", away)
    document.addEventListener("visibilitychange", hidden)
    return () => {
      removeEventListener("pagehide", away)
      document.removeEventListener("visibilitychange", hidden)
      session.current?.end("drop")
    }
  }, [])

  const start = useCallback(() => {
    const Class = recognitionClass()
    if (!Class || session.current?.listening) return
    // One still settling its last words after a stop takes them as heard, so the new one starts clean.
    session.current?.end("settle")
    setFailure(undefined)
    setHearing("")
    levels.set(QUIET)
    const started = Date.now()
    const current = new DictationSession(Class, {
      settled: (words) => settled.current(words),
      hearing: setHearing,
      levels: (sampled) => levels.set(sampled),
      ended: (why) => {
        setListening(false)
        setSince(undefined)
        levels.set(QUIET)
        if (why) setFailure(why)
      },
      done: () => {
        if (session.current === current) session.current = null
      },
      report: noteDictation,
    })
    session.current = current
    setListening(true)
    setSince(started)
    current.begin()
  }, [levels])
  const stop = useCallback(() => session.current?.end("stop"), [])
  const cancel = useCallback(() => session.current?.end("drop"), [])
  const offered = dictationOffered()
  const state: Dictation = { offered, listening, levels, hearing, start, stop, cancel }
  if (since !== undefined) state.since = since
  if (failure) state.failure = failure
  return state
}

export interface SessionEvents {
  settled: (words: string) => void
  hearing: (words: string) => void
  levels: (levels: readonly number[]) => void
  /** Listening is over, as the person sees it: the microphone is let go. Words still settling may follow. */
  ended: (why: string | undefined) => void
  /** Nothing more comes: the recognizer has ended or been let go. */
  done?: () => void
  report?: (step: DictationStep) => void
}

/**
 * One stretch of dictation, from the press to the stop: its recognizers, one after another, and its meter. Listening
 * ends when the person says so, at once, whatever the recognizer does: it may never end, as Safari's sometimes doesn't.
 */
export class DictationSession {
  readonly #Class: RecognitionClass
  readonly #events: SessionEvents
  #recognizer: Recognition | null = null
  /** `settling`: stopped, the recognizer given `STOP_GRACE_MS` to settle its last words. */
  #phase: "listening" | "settling" | "over" = "listening"
  #interim = ""
  #restarts: number[] = []
  #restarted = 0
  #levels: number[] = [...QUIET]
  #timer: ReturnType<typeof setInterval> | undefined
  #released = false
  #grace: ReturnType<typeof setTimeout> | undefined
  #meter: Meter | null = null
  /** The bars' reading when they move with the words: a pulse on each result that falls away. */
  #pulse = 0
  #heardWhileSilent = 0
  #began = 0
  #stopPressed = 0
  #peak = 0
  #levelsReported = false

  constructor(Class: RecognitionClass, events: SessionEvents) {
    this.#Class = Class
    this.#events = events
  }

  get listening(): boolean {
    return this.#phase === "listening"
  }

  begin(): void {
    this.#began = performance.now()
    this.#events.report?.({ step: "started" })
    this.#listen()
    if (this.#phase === "over") return
    // Asked in the same press: Safari opens audio only from a gesture.
    if (meterAllowed()) this.#meter = Meter.open(() => this.#dropMeter())
    this.#timer = setInterval(() => this.#sample(), METER_MS)
  }

  end(how: DictationEnd): void {
    if (this.#phase === "over") return
    const recognizer = this.#recognizer
    if (how !== "stop" || this.#phase === "settling" || !recognizer) return this.#finish(how === "drop" ? "drop" : "settle", undefined)
    this.#phase = "settling"
    this.#stopPressed = performance.now()
    this.#events.report?.({ step: "stop-pressed", ms: Math.round(this.#stopPressed - this.#began) })
    this.#release(undefined)
    this.#grace = setTimeout(() => {
      this.#events.report?.({ step: "stop-overdue", ms: Math.round(performance.now() - this.#stopPressed) })
      this.#finish("settle", undefined)
    }, STOP_GRACE_MS)
    try {
      recognizer.stop()
    } catch {
      this.#finish("settle", undefined)
    }
  }

  #listen(): void {
    const listener = new this.#Class()
    listener.lang = navigator.language
    listener.continuous = true
    listener.interimResults = true
    const committed = new Set<number>()
    listener.onresult = (event) => {
      let interim = ""
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]!
        if (result.isFinal) {
          if (committed.has(index)) continue
          committed.add(index)
          this.#events.settled(result[0].transcript)
        } else interim += result[0].transcript
      }
      this.#interim = interim.trim()
      this.#events.hearing(this.#interim)
      this.#pulse = 1
      if (this.#meter?.silent()) this.#heardWhileSilent += 1
      // Words arriving while the analyser hears nothing: the platform gave the microphone to one of them only.
      if (this.#heardWhileSilent >= 3) this.#dropMeter()
    }
    listener.onerror = (event) => {
      // Silence and our own abort are a quiet end: listening starts again below unless the person stopped it.
      if (event.error === "no-speech" || event.error === "aborted") return
      if (event.error === "audio-capture" && this.#meter) {
        // The analyser took the microphone from the recognizer: let it go and listen again without it.
        this.#dropMeter()
        return
      }
      // Over now, not at the recognizer's end, which may never come.
      this.#fail(event.error, event.error === "not-allowed" || event.error === "service-not-allowed" ? "Allow the microphone to dictate." : "Dictation stopped. What it heard is kept.")
    }
    listener.onend = () => {
      if (this.#recognizer !== listener) return
      this.#recognizer = null
      // What it was still hearing is its best guess: kept, never lost to a restart or a stop.
      this.#settleInterim()
      if (this.#phase !== "listening") return this.#finish("settle", undefined)
      const now = Date.now()
      this.#restarts = [...this.#restarts.filter((at) => now - at < RESTART_WINDOW_MS), now]
      if (this.#restarts.length > RESTARTS_ALLOWED) return this.#fail("restarts", "Dictation stopped. What it heard is kept.")
      // Ended on silence, as the platform decides: it listens on.
      this.#restarted += 1
      this.#listen()
    }
    this.#recognizer = listener
    try {
      listener.start()
    } catch {
      this.#recognizer = null
      this.#fail("start", "Dictation isn't available right now.")
    }
  }

  #fail(error: string, why: string): void {
    if (this.#phase === "over") return
    this.#events.report?.({ step: "failed", error, ms: Math.round(performance.now() - this.#began), restarts: this.#restarted })
    this.#finish("settle", why)
  }

  #settleInterim(): void {
    if (this.#interim) this.#events.settled(this.#interim)
    this.#interim = ""
    this.#events.hearing("")
  }

  #sample(): void {
    const reading = this.#meter ? this.#meter.level() : this.#pulse
    this.#pulse *= 0.55
    this.#levels = [...this.#levels.slice(1), reading]
    this.#events.levels(this.#levels)
    this.#peak = Math.max(this.#peak, reading)
    if (!this.#levelsReported && performance.now() - this.#began >= LEVELS_REPORT_MS) this.#reportLevels()
  }

  #reportLevels(): void {
    this.#levelsReported = true
    this.#events.report?.({ step: "levels", peak: Math.round(this.#peak * 100) / 100, meter: this.#meter ? "analyser" : "words" })
  }

  #dropMeter(): void {
    if (!this.#meter) return
    this.#meter.close()
    this.#meter = null
    rememberNoMeter()
    // The recognizer may have lost the microphone to it: listen again, keeping what was heard.
    if (this.#phase === "listening" && this.#recognizer) {
      const stale = this.#recognizer
      this.#recognizer = null
      this.#settleInterim()
      stale.onend = null
      stale.onresult = null
      stale.onerror = null
      try {
        stale.abort()
      } catch {
        // Already ended.
      }
      this.#listen()
    }
  }

  /** Listening over, as the person sees it: the meter and the microphone let go, said once. */
  #release(why: string | undefined): void {
    if (this.#released) return
    this.#released = true
    clearInterval(this.#timer)
    this.#timer = undefined
    this.#meter?.close()
    this.#meter = null
    if (!this.#levelsReported) this.#reportLevels()
    this.#events.ended(why)
  }

  #finish(words: "settle" | "drop", why: string | undefined): void {
    if (this.#phase === "over") return
    const stopped = this.#phase === "settling"
    this.#phase = "over"
    clearTimeout(this.#grace)
    const recognizer = this.#recognizer
    this.#recognizer = null
    if (recognizer) {
      recognizer.onend = null
      recognizer.onresult = null
      recognizer.onerror = null
      try {
        recognizer.abort()
      } catch {
        // Already ended.
      }
    }
    if (words === "settle") this.#settleInterim()
    else {
      this.#interim = ""
      this.#events.hearing("")
    }
    if (why === undefined) this.#events.report?.({ step: "stopped", ms: Math.round(performance.now() - (stopped ? this.#stopPressed : this.#began)), restarts: this.#restarted })
    this.#release(why)
    this.#events.done?.()
  }
}

function meterAllowed(): boolean {
  try {
    return localStorage.getItem(NO_METER_KEY) !== "off" && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(window.AudioContext ?? window.webkitAudioContext)
  } catch {
    return false
  }
}

function rememberNoMeter(): void {
  try {
    localStorage.setItem(NO_METER_KEY, "off")
  } catch {
    // A private window keeps nothing: the meter is tried again next time.
  }
}

/** The microphone's loudness, through a Web Audio analyser. */
class Meter {
  readonly #context: AudioContext
  #analyser: AnalyserNode | null = null
  #stream: MediaStream | null = null
  #closed = false
  #frame = new Uint8Array(1024)
  #deadSamples = 0

  private constructor(context: AudioContext) {
    this.#context = context
  }

  static open(failed: () => void): Meter | null {
    const Context = window.AudioContext ?? window.webkitAudioContext
    if (!Context) return null
    let context: AudioContext
    try {
      context = new Context()
    } catch {
      return null
    }
    const meter = new Meter(context)
    void context.resume().catch(() => undefined)
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(
      (stream) => {
        if (meter.#closed) return stream.getTracks().forEach((track) => track.stop())
        meter.#stream = stream
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        context.createMediaStreamSource(stream).connect(analyser)
        meter.#analyser = analyser
      },
      () => failed()
    )
    return meter
  }

  level(): number {
    if (!this.#analyser) return 0
    this.#analyser.getByteTimeDomainData(this.#frame)
    const decibels = frameDecibels(this.#frame)
    // Digital silence, every sample at rest: no sound reaches it at all, which a room never is.
    this.#deadSamples = decibels === -Infinity ? this.#deadSamples + 1 : 0
    return meterLevel(decibels)
  }

  /** It has read digital silence for a second: the microphone gives it nothing. */
  silent(): boolean {
    return this.#analyser !== null && this.#deadSamples * METER_MS >= 1_000
  }

  close(): void {
    this.#closed = true
    this.#stream?.getTracks().forEach((track) => track.stop())
    void this.#context.close().catch(() => undefined)
  }
}
