import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { CheckIcon } from "lucide-react"
import {
  DEFAULT_APPSHOT_SHORTCUT,
  MODIFIER_GLYPHS,
  MODIFIER_NAMES,
  chordClash,
  clashSentence,
  evidenceSentence,
  laterClashSentence,
  sameShortcut,
  shortcutLabel,
  type AppshotCheckReason,
  type AppshotModifier,
  type AppshotShortcut,
  type AppshotShortcutCheck,
  type AppshotShortcutState,
} from "@mako/host/contracts/appshot-shortcut"
import { Action, Keys, ListCard, Segmented, SettingRow, Toggle } from "@/components/ui/kit"
import { chordFromEvent, formatChord, keysFor, useCommands } from "@/extend/commands"
import { formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  beginAppshotRecording,
  endAppshotCheck,
  endAppshotRecording,
  pressedSince,
  readAppshotPermissions,
  recheckAppshotShortcut,
  requestAppshotPermissions,
  retryAppshotShortcut,
  startAppshotCheck,
  tryAppshotChord,
  useAppshotShortcut,
} from "@/state/appshot-shortcut"
import { setPref, usePrefs } from "@/state/prefs"

type Choice = AppshotModifier | "keys"

/** The pairs, then a chord: what the keys control offers. */
function choices(): Array<{ value: Choice; label: string }> {
  const pairs: AppshotModifier[] = ["shift", "command", "option", "control"]
  return [...pairs.map((modifier) => ({ value: modifier, label: `${MODIFIER_GLYPHS[modifier]} ${MODIFIER_GLYPHS[modifier]}` })), { value: "keys", label: "Keys…" }]
}

/**
 * Settings › Appshots: the Appshot shortcut, which captures the window the
 * person is in from any app. Off until the person
 * turns it on, because it listens in every app; the keys are both keys of a
 * modifier pair (both Shift, which apps can't register) or a chord checked
 * against macOS's shortcuts on this Mac, every app's everyday commands and
 * Mako's own, and by whether it reaches Mako when pressed; and the grants it
 * needs are named for what each does, with the same Allow the computer use
 * settings have. What it says about clashes is one quiet line, never a
 * dialog (docs/audits/2026-10-12/appshot-shortcut-clashes.md), and that
 * covers keys taken since they were set: opening this asks the client to
 * check them again, and the line says what a later check or a press found.
 */
export function AppshotsSection() {
  const on = usePrefs((prefs) => prefs.appshotShortcutOn)
  const shortcut = usePrefs((prefs) => prefs.appshotShortcut)
  const thenMako = usePrefs((prefs) => prefs.appshotThenMako)
  const status = useAppshotShortcut((state) => state.status)
  const permissions = useAppshotShortcut((state) => state.permissions)
  const asking = useAppshotShortcut((state) => state.asking)
  const failure = useAppshotShortcut((state) => state.failure)
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    void readAppshotPermissions()
    // Something may have taken the keys since they were last checked.
    void recheckAppshotShortcut()
    // Grants change in System Settings, outside Mako: read them again on the way back.
    const back = () => void readAppshotPermissions()
    window.addEventListener("focus", back)
    return () => {
      window.removeEventListener("focus", back)
      // A press is an Appshot again once Settings isn't waiting for one.
      endAppshotCheck()
    }
  }, [])

  const unavailable = status?.state === "unavailable" ? status.reason : null
  const choice: Choice = shortcut.kind === "modifiers" ? shortcut.modifier : "keys"
  const record = (on: boolean) => {
    setRecording(on)
    void (on ? beginAppshotRecording() : endAppshotRecording())
  }
  const choose = (next: Choice) => {
    if (next === "keys") {
      if (shortcut.kind !== "keys") record(true)
      return
    }
    if (recording) record(false)
    setPref("appshotShortcut", { kind: "modifiers", modifier: next })
    if (on) startAppshotCheck()
  }
  const keys = shortcutLabel(shortcut, formatChord)
  const missing = permissions?.supported
    ? [permissions.screenRecording !== "granted" && "Screen Recording", !permissions.accessibility && "Accessibility"].filter(Boolean)
    : []

  return (
    <section className="flex flex-col gap-6">
      <p className="max-w-[40rem] text-ui leading-relaxed text-muted-foreground">
        An Appshot is a window you’re working in, captured without leaving it: its picture, and the buttons, fields and
        text in it with where each one sits in the picture. It goes into the conversation you last had open in Mako,
        ready for your words.
      </p>
      <ListCard>
        <SettingRow
          title="Appshot shortcut"
          description={
            unavailable ??
            "Capture the window you’re in, from any app. It listens in every app while it’s on; Mako’s own windows are never captured, so from here it takes the window behind Mako."
          }
        >
          <Toggle
            label="Appshot shortcut"
            on={on && !unavailable}
            disabled={Boolean(unavailable)}
            onChange={() => {
              setPref("appshotShortcutOn", !on)
              if (on) endAppshotCheck()
              else startAppshotCheck()
            }}
          />
        </SettingRow>
        <div className="py-3">
          <div className="flex min-h-8 items-center justify-between gap-6">
            <div className="min-w-0">
              <div className="text-ui font-medium">Keys</div>
              <p className="mt-0.5 text-label leading-relaxed text-muted-foreground">
                Both keys of a pair, pressed together, aren’t a shortcut apps can register, so few use them. Or choose a key
                combination.
              </p>
            </div>
            <Segmented
              label="Appshot keys"
              value={recording ? "keys" : choice}
              disabled={Boolean(unavailable)}
              options={choices()}
              onChange={choose}
            />
          </div>
          {recording || shortcut.kind === "keys" ? (
            <ChordRecorder
              chord={shortcut.kind === "keys" ? shortcut.chord : ""}
              recording={recording}
              onRecord={() => record(true)}
              onCancel={() => record(false)}
              onSave={(chord, pressed) => {
                setPref("appshotShortcut", { kind: "keys", chord })
                record(false)
                // Pressed while recording is the check already made.
                if (on && !pressed) startAppshotCheck()
              }}
            />
          ) : null}
          {recording ? null : <ShortcutStatus on={on} label={keys} shortcut={shortcut} />}
        </div>
        <SettingRow
          title="After an Appshot"
          description="Stay in the app you captured and find the Appshot in your draft when you come back, or bring Mako forward to write about it now."
        >
          <Segmented
            label="After an Appshot"
            value={thenMako ? "mako" : "stay"}
            options={[
              { value: "stay", label: "Stay in the app" },
              { value: "mako", label: "Switch to Mako" },
            ]}
            onChange={(next) => setPref("appshotThenMako", next === "mako")}
          />
        </SettingRow>
      </ListCard>

      <div className="flex flex-col gap-2">
        <h3 className="px-1 text-label font-medium text-muted-foreground">What macOS needs to allow</h3>
        {permissions && !permissions.supported ? (
          <p className="px-1 text-label text-muted-foreground">Appshots need the Mako desktop app on a Mac.</p>
        ) : (
          <ListCard>
            <Grant
              title="Screen Recording"
              description="Takes the picture of the window you capture, and only that window."
              granted={permissions ? permissions.screenRecording === "granted" : undefined}
              asking={asking}
            />
            <Grant
              title="Accessibility"
              description="Reads the window’s buttons, fields and text, and where they are. Mako never presses or types anything to capture."
              granted={permissions?.accessibility}
              asking={asking}
            />
          </ListCard>
        )}
        {missing.length > 0 ? (
          <p className="px-1 text-label leading-relaxed text-muted-foreground">
            macOS asks once for each. If it doesn’t, turn Mako on in System Settings › Privacy &amp; Security › {missing.join(" and ")}, then come back.
          </p>
        ) : null}
        {failure ? <p className="px-1 text-label text-caution">Last Appshot: {failure}</p> : null}
      </div>
    </section>
  )
}

function Grant({ title, description, granted, asking }: { title: string; description: string; granted: boolean | undefined; asking: boolean }) {
  return (
    <SettingRow title={title} description={description}>
      {granted === undefined ? (
        <span className="shrink-0 text-label text-faint">Checking…</span>
      ) : granted ? (
        <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
          <CheckIcon aria-hidden className="size-3.5" />
          Allowed
        </span>
      ) : (
        <Action tone="outline" disabled={asking} onClick={() => void requestAppshotPermissions()}>
          {asking ? "Asking macOS…" : "Allow"}
        </Action>
      )}
    </SettingRow>
  )
}

/** The left and right key of each pair, as `KeyboardEvent.code` names them. */
const PAIR_CODES = {
  shift: ["ShiftLeft", "ShiftRight"],
  command: ["MetaLeft", "MetaRight"],
  option: ["AltLeft", "AltRight"],
  control: ["ControlLeft", "ControlRight"],
} as const satisfies Record<AppshotModifier, readonly [string, string]>

/** How long after both keys reached this window the helper's word may take before it counts as missed. */
const MISSED_MS = 1200

/**
 * Whether both keys of a pair reached this window while a check waited
 * (since `waitingSince`) and the helper listening for them said nothing:
 * the one clash of a pair Mako can see (a tool that remaps the keys, or a
 * press too quick for the helper).
 */
function usePairMissed(modifier: AppshotModifier | null, waitingSince: number | null): boolean {
  const [missed, setMissed] = useState<number | null>(null)
  useEffect(() => {
    if (!modifier || waitingSince === null) return
    const codes: readonly string[] = PAIR_CODES[modifier]
    const down = new Set<string>()
    let timer: number | undefined
    const pressed = (event: KeyboardEvent) => {
      if (!codes.includes(event.code)) return
      down.add(event.code)
      if (down.size === codes.length && timer === undefined) timer = window.setTimeout(() => setMissed(waitingSince), MISSED_MS)
    }
    const released = (event: KeyboardEvent) => down.delete(event.code)
    window.addEventListener("keydown", pressed, true)
    window.addEventListener("keyup", released, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("keydown", pressed, true)
      window.removeEventListener("keyup", released, true)
    }
  }, [modifier, waitingSince])
  return waitingSince !== null && missed === waitingSince
}

function ShortcutStatus({ on, label, shortcut }: { on: boolean; label: string; shortcut: AppshotShortcut }) {
  const status = useAppshotShortcut((state) => state.status)
  const check = useAppshotShortcut((state) => state.check)
  const evidence = useAppshotShortcut((state) => state.watch?.evidence ?? null)
  const waiting = on && status?.state === "on" && check?.phase === "waiting"
  const pair = shortcut.kind === "modifiers" ? MODIFIER_NAMES[shortcut.modifier] : null
  const missed = usePairMissed(shortcut.kind === "modifiers" ? shortcut.modifier : null, waiting ? check.at : null)
  if (!on || !status || status.state === "unavailable") return null
  if (status.state === "refused") {
    return (
      <div role="status" className="mt-2 flex items-center gap-2">
        <p className="min-w-0 flex-1 text-label text-caution">
          {status.clash ? (status.later ? laterClashSentence(status.clash, label) : clashSentence(status.clash, label)) : status.reason}
        </p>
        {shortcut.kind === "keys" ? (
          <Action
            tone="ghost"
            size="xs"
            onClick={() => {
              setPref("appshotShortcut", DEFAULT_APPSHOT_SHORTCUT)
              startAppshotCheck()
            }}
          >
            Use both Shift keys
          </Action>
        ) : null}
        <Action
          tone="ghost"
          size="xs"
          onClick={() => {
            startAppshotCheck()
            void retryAppshotShortcut()
          }}
        >
          Try again
        </Action>
      </div>
    )
  }
  const line =
    missed && pair
      ? `Both ${pair} keys reached this window, but the shortcut didn’t fire. Hold them a moment longer.`
      : waiting
        ? `${pair ? `Press both ${pair} keys` : `Press ${label}`} once to check it reaches Mako.`
        : check?.phase === "reached"
          ? "Pressed — it reaches Mako."
          : evidence && sameShortcut(evidence.shortcut, shortcut)
            ? evidenceSentence(evidence, pair ? `both ${pair} keys` : label)
            : `On: ${pair ? `press both ${pair} keys together` : `press ${label}`} in any app.`
  return (
    <div role="status" className="mt-2 flex items-center gap-2">
      <p className={cn("min-w-0 flex-1 text-label", missed ? "text-caution" : "text-muted-foreground")}>{line}</p>
    </div>
  )
}

/** The modifier keys `KeyboardEvent.key` names, in the desk's chord spelling and order. */
const MODIFIER_PARTS = [
  ["Meta", "mod"],
  ["Control", "ctrl"],
  ["Shift", "shift"],
  ["Alt", "alt"],
] as const

/** How long a press may take to come back from the client before modifiers alone count as keys that never arrived. */
const ARRIVAL_MS = 300

/** What the client said of the keys being recorded; `state` is null while it is asked, or where no client holds keys. */
interface Verdict {
  chord: string
  asked: boolean
  state: AppshotShortcutState | null
  at: number
}

/**
 * Records a chord as the keyboard settings do, and refuses one that would
 * take an everyday command from every app, one of macOS's own on this Mac,
 * or one of Mako's: a global shortcut is held before Mako sees the key, so
 * Mako's own command would stop working too.
 *
 * Mako hearing the keys is itself the check that nothing else has them: a
 * key another app's shortcut takes never reaches the focused window, while
 * the modifiers held with it do. So modifiers that come and go with no key
 * between them are said to have arrived alone, which is the one sign of
 * another app's shortcut that macOS gives.
 */
function ChordRecorder({
  chord,
  recording,
  onRecord,
  onCancel,
  onSave,
}: {
  chord: string
  recording: boolean
  onRecord: () => void
  onCancel: () => void
  onSave: (chord: string, pressed: boolean) => void
}) {
  const commands = useCommands()
  const keybindings = usePrefs((prefs) => prefs.keybindings)
  const check = useAppshotShortcut((state) => state.check)
  const [candidate, setCandidate] = useState(chord)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  /** Modifiers that arrived with no key, as a chord of modifiers only. */
  const [alone, setAlone] = useState<string | null>(null)
  const held = useRef({ down: new Set<string>(), peak: new Set<string>(), keyed: false, since: 0 })
  const shown = recording ? candidate : chord
  const mako = shown ? commands.find((command) => keysFor(command, keybindings)?.toLowerCase() === shown.toLowerCase()) : undefined
  const own = mako ? `Mako uses it for ${mako.title}.` : null
  const ruled = shown ? chordClash(shown, []) : null
  const local = ruled ? clashSentence(ruled) : own
  const keys = formatChord(candidate).join("")
  const mine = verdict?.chord === candidate ? verdict : null
  const pressed = Boolean(mine?.state?.state === "on" && check?.phase === "reached" && check.at >= mine.at)
  const refused = mine?.state?.state === "refused" ? mine.state : null
  // Where no client answers (a browser tab), a new Mac's shortcuts stand in for this one's.
  const assumed = mine && mine.asked && !mine.state ? chordClash(candidate) : null
  const verdictLine = refused
    ? refused.clash
      ? clashSentence(refused.clash, keys)
      : refused.reason
    : assumed
      ? clashSentence(assumed, keys)
      : null

  const listen = (next: string) => {
    setCandidate(next)
    setAlone(null)
    const rules = chordClash(next, [])
    const own = commands.some((command) => keysFor(command, keybindings)?.toLowerCase() === next.toLowerCase())
    if (rules || own) return setVerdict(null)
    const asked: Verdict = { chord: next, asked: false, state: null, at: Date.now() }
    setVerdict(asked)
    void tryAppshotChord(next).then((state) => setVerdict((current) => (current === asked ? { ...asked, asked: true, state } : current)))
  }

  const keyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const part = MODIFIER_PARTS.find(([key]) => key === event.key)?.[1]
    const state = held.current
    if (part) {
      if (state.down.size === 0) Object.assign(state, { peak: new Set<string>(), keyed: false, since: Date.now() })
      state.down.add(part)
      state.peak.add(part)
      return
    }
    state.keyed = true
    if (event.key === "Escape") return onCancel()
    if (event.key === "Backspace" || event.key === "Delete") {
      setCandidate("")
      setVerdict(null)
      return
    }
    const next = chordFromEvent(event.nativeEvent)
    if (next) listen(next)
  }

  const keyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const part = MODIFIER_PARTS.find(([key]) => key === event.key)?.[1]
    const state = held.current
    if (!part) return
    state.down.delete(part)
    if (state.down.size > 0 || state.keyed || state.peak.size === 0) return
    const since = state.since
    const modifiers = MODIFIER_PARTS.map(([, name]) => name).filter((name) => state.peak.has(name)).join("+")
    // Mako's own keys, held for the check, take the key too: a press that came back as one isn't keys gone missing.
    window.setTimeout(() => {
      if (pressedSince(since)) return
      // The keys shown are no longer the last ones pressed.
      setCandidate("")
      setVerdict(null)
      setAlone(modifiers)
    }, ARRIVAL_MS)
  }

  const line = alone
    ? { text: `Only ${formatChord(alone).join("")} arrived. If you pressed a key with them, another app or macOS has it.`, caution: true }
    : !candidate
      ? { text: "Press the keys you want", caution: false }
      : local
        ? { text: local, caution: true }
        : verdictLine
          ? { text: verdictLine, caution: true }
          : mine && !mine.asked
            ? { text: "Checking…", caution: false }
            : pressed
              ? { text: "Pressed — it reaches Mako. Press Save to use it.", caution: false }
              : mine?.state?.state === "on"
                ? { text: `No other app took ${keys}. Press Save to use it.`, caution: false }
                : { text: "Press Save to use these keys", caution: false }
  const ready = Boolean(candidate) && !local && !verdictLine && Boolean(mine?.asked)

  return (
    <div className="mt-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {recording ? (
          <button
            type="button"
            autoFocus
            aria-label="Recording the Appshot shortcut"
            onKeyDown={keyDown}
            onKeyUp={keyUp}
            onBlur={() => held.current.down.clear()}
            className="pressable flex h-7 min-w-32 items-center justify-center rounded-md bg-raised px-2 ring-1 ring-border"
          >
            {candidate ? <Keys keys={formatChord(candidate)} /> : <span className="text-label text-faint">Press keys</span>}
          </button>
        ) : (
          <button
            type="button"
            aria-label="Change the Appshot shortcut"
            onClick={() => {
              setCandidate(chord)
              setVerdict(null)
              setAlone(null)
              onRecord()
            }}
            className="pressable flex h-7 min-w-24 items-center justify-center rounded-md px-2 hover:bg-fill-hover"
          >
            <Keys keys={formatChord(chord)} />
          </button>
        )}
        {recording ? (
          <>
            <span role="status" className={cn("min-w-0 flex-1 text-label", line.caution ? "text-caution" : "text-faint")}>
              {line.text}
            </span>
            <Action tone="ghost" onClick={onCancel}>
              Cancel
            </Action>
            <Action disabled={!ready} onClick={() => onSave(candidate, pressed)}>
              Save
            </Action>
          </>
        ) : own ? (
          <span className="text-label text-caution">{own}</span>
        ) : null}
      </div>
    </div>
  )
}

const REASONS = {
  set: "set",
  asked: "asked again",
  preferences: "System Settings changed",
  wake: "woke",
  unlock: "unlocked",
  active: "Mako came forward",
  hourly: "hourly",
} as const satisfies Record<AppshotCheckReason, string>

function ago(at: number): string {
  const relative = formatRelative(at)
  return relative === "now" ? "just now" : `${relative} ago`
}

function checkLine(check: AppshotShortcutCheck): string {
  const result = check.result === "clash" && check.clash ? `taken (${check.clash.by})` : check.result === "busy" ? "skipped, keys in use" : check.result
  return `${result} · ${REASONS[check.reason]} · ${check.ms} ms · ${ago(check.at)}`
}

/**
 * Diagnostics' readout of the Appshot shortcut: what the client holds, its
 * last checks and why each ran, when the next is due, what it watches, and
 * the last press with what followed it. Copy gives the whole record.
 */
export function AppshotShortcutReadout() {
  const watch = useAppshotShortcut((state) => state.watch)
  if (!watch) return null
  const { state, checks, next, watching, press } = watch
  const held =
    state.state === "on"
      ? `Held: ${shortcutLabel(state.shortcut, formatChord)}`
      : state.state === "refused"
        ? `Refused${state.later ? " since it was set" : ""}: ${state.reason}`
        : state.state === "unavailable"
          ? state.reason
          : "Off"
  const watched = [watching.preferences !== "off" && `System Settings’ shortcuts (${watching.preferences})`, watching.activations && "apps coming to the front"].filter(Boolean)
  return (
    <div className="mt-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-hairline" data-appshot-shortcut-readout>
      <div className="flex items-center justify-between gap-3">
        <p className="text-ui">Appshot shortcut</p>
        <Action tone="ghost" size="xs" onClick={() => void navigator.clipboard.writeText(JSON.stringify(watch, null, 2))}>
          Copy
        </Action>
      </div>
      <div className="mt-0.5 flex flex-col gap-0.5 text-label text-faint">
        <p>{held}</p>
        <p>Watching: {watched.length > 0 ? watched.join(" and ") : "nothing"}{next ? ` · next check ${new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</p>
        {checks.map((check) => (
          <p key={`${check.at}-${check.reason}`} className="tabular">
            Check: {checkLine(check)}
          </p>
        ))}
        {press ? (
          <p>
            Last press {ago(press.at)}:{" "}
            {press.evidence ? `${press.evidence.app} came to the front ${press.evidence.afterMs} ms after it` : "no other app came to the front"}
          </p>
        ) : null}
      </div>
    </div>
  )
}
