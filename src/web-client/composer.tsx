import { useExit } from "@/components/ui/exit-motion"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { FileIcon, MicIcon, PencilIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react"
import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import { cn } from "@/lib/utils"
import type { LiveSteering } from "@/lib/types"
import { ComposerActionButton } from "@/components/composer/composer-action-button"
import { COMPOSER_BOX, COMPOSER_COLUMN, COMPOSER_CONTROLS, ComposerStatus } from "@/components/composer/composer-frame"
import { useApexStop } from "@/components/composer/stop-apex"
import { Ticking } from "@/components/ui/ticking"
import { usePrefs } from "@/state/prefs"
import { ATTACHMENT_BUDGET, encodedBytes, HeldPreviews, kilobytes, readPicked, type Picked } from "./attachments"
import { appendHeard, elapsedWords, METER_BARS, splitUnsure, useDictation, type Dictation, type MeterLevels } from "./dictation"
import { noteSending, openingText, readDraft, settleSending, writeDraft } from "./drafts"
import { HeldSendContext } from "./held-send"
import { outboxHolds } from "./outbox"
import { sendPresentation } from "./send-action"
import { SendButton } from "./send-button"

/** Held this long, the mic is push-to-talk: it listens while held and stops on release. A tap toggles it. */
const HOLD_MS = 300
const MAX_HEIGHT = 180
/** A draft is written this long after its last key, and at once when the page goes or the composer closes. */
const DRAFT_WRITE_MS = 250

/** A message as it left the field, under the ID every try of it carries. */
export interface Outgoing {
  id: string
  text: string
  attachments: PromptAttachment[]
}

/** Sending into a running turn: whether its harness takes a message mid-turn, how it lands, and how it's sent. */
export interface Steering {
  canSteer: boolean
  lands: LiveSteering | null
  steer: (text: string, attachments: PromptAttachment[], id: string) => Promise<boolean>
}

/** A queued message whose words are in the field to change: ✓ saves them in its place in the queue. */
export interface EditingQueued {
  id: string
  text: string
  save: (text: string) => Promise<boolean>
  cancel: () => void
}

/**
 * The web's composer, one for every place a message is written: a Thread's, a quiet Mac's, and a new Thread's, on a
 * phone, a tablet and a laptop's browser. It is the desktop's box (`composer-frame.tsx`): the field, then one control
 * row of `+` (the phone's own picker: photos, camera, files), the harness and model (`tools`), the mic and the one send
 * button, which changes with the situation (`send-action.ts`): Send, Stop while the agent works and the field is empty,
 * Queue or Steer while it works and the field has words (held, both), ✓ while a queued message is being edited. Under
 * the box, the status line says where it runs and its access in words (`status`). `onSend` says whether the message
 * went; one that didn't stays in the field.
 */
export function Composer({
  placeholder,
  onSend,
  running = false,
  onStop,
  stopping = false,
  disabled = false,
  sendable = true,
  attach = true,
  header,
  tools,
  status,
  autoFocus = false,
  sendLabel = "Send",
  desk = false,
  draftKey,
  onWrite,
  onUnsent,
  steering,
  editing,
  waiting,
  answering = false,
  straight = false,
  hold,
  stopFor,
  foldStatus = false,
}: {
  placeholder: string
  /** Sends a message under `id`; says whether it went. One that didn't comes back into an empty field, or to `onUnsent`. */
  onSend: (text: string, attachments: PromptAttachment[], id: string) => Promise<boolean>
  running?: boolean
  onStop?: () => void
  stopping?: boolean
  disabled?: boolean
  /** Whether a message can go yet: the field takes words before (a new Thread's place still being read), Send waits. */
  sendable?: boolean
  attach?: boolean
  /** Inside the box, over the field: the Session the words go to, where a Thread has more than one. */
  header?: ReactNode
  /** The control row under the field, between `+` and the mic and send: the harness and model it runs with. */
  tools?: ReactNode
  /** The status line under the box: where it runs and the access level, in words, each still the control it was. */
  status?: ReactNode
  autoFocus?: boolean
  sendLabel?: string
  /**
   * On a laptop's browser: Enter sends (Shift+Enter a new line), the desktop's own send button, no dictation, and the
   * desktop's control sizes.
   */
  desk?: boolean
  /** Where its words are kept until they're sent (`drafts.ts`): they outlive the screen, the page and a reload. */
  draftKey?: string
  /** The conversation Stop stops: an Apex's Stop asks first while any of its Fins works (`useApexStop`). */
  stopFor?: string
  /** A key pressed with words in the field: a cloud Thread's machine starts waking. */
  onWrite?: () => void
  /** A message that didn't go while the field held other words by then: kept apart, with Retry, rather than lost. */
  onUnsent?: (message: Outgoing) => void
  /** While the agent works, a message can go into its turn rather than after it. */
  steering?: Steering
  editing?: EditingQueued
  /** Something a send must go after, on its way now ("Switching access…"): the button turns and waits. */
  waiting?: string
  /** The agent's question is open above: the field's words answer it. */
  answering?: boolean
  /** The words go to one of an Apex's Fins straight (`sendDirect`): Send, never Queue or Steer, while the Apex works. */
  straight?: boolean
  /** A send that asks first: pressed, the words stay in the field and this line stands above it (`HeldSendContext`). */
  hold?: ReactNode
  /**
   * The status line folds away while the field has the on-screen keyboard up, and comes back as it lets go: a Thread's,
   * whose access can wait for the keyboard to go. New's never folds, since it says where the Thread will run.
   */
  foldStatus?: boolean
}) {
  const [text, setText] = useState(() => (draftKey ? openingText(draftKey, outboxHolds) : ""))
  const [picked, setPicked] = useState<Picked[]>([])
  const [reading, setReading] = useState(0)
  // The words a press took: a second press before the field empties sends nothing.
  const taken = useRef<string | undefined>(undefined)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const [problem, setProblem] = useState<string | undefined>(undefined)
  // Whether the field has focus, for what folds away while the keyboard is up (`foldStatus`).
  const [focused, setFocused] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const [previews] = useState(() => new HeldPreviews())
  const steerByDefault = usePrefs((prefs) => prefs.steerOnEnter)

  useLayoutEffect(() => {
    const node = input.current
    if (!node) return
    node.style.height = "auto"
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`
  }, [text])
  // A chip's picture goes with its attachment (removed, or sent), and every one with the composer.
  useEffect(() => () => previews.releaseAll(), [previews])
  useDraft(editing ? undefined : draftKey, text)

  // A queued message to edit: its words take the field, and what was being written waits aside until it's done.
  const [edited, setEdited] = useState<{ id?: string; aside: string }>({ aside: "" })
  if (editing?.id !== edited.id) {
    if (editing) {
      setEdited({ id: editing.id, aside: edited.id === undefined ? text : edited.aside })
      setText(editing.text)
    } else {
      setEdited({ aside: "" })
      setText(edited.aside)
    }
  }
  const editingId = editing?.id
  useEffect(() => {
    if (editingId !== undefined) input.current?.focus({ preventScroll: true })
  }, [editingId])

  // Settled words are appended to whatever the field holds as they arrive; what's still being heard is only shown.
  const settled = useCallback((words: string) => setText((current) => appendHeard(current, words)), [])
  const dictation = useDictation(settled)

  const over = encodedBytes(picked) > ATTACHMENT_BUDGET
  const hasContent = Boolean(text.trim() || dictation.hearing) || picked.length > 0
  const presentation = sendPresentation({ running, hasContent, editingQueued: editing !== undefined, canSteer: steering?.canSteer === true, steerByDefault, sendLabel, answering, straight })
  // A file still being read isn't in `picked` yet: the message waits for it rather than going without it.
  const reads = reading === 0 ? undefined : reading === 1 ? "Reading a file" : `Reading ${reading} files`
  const ready = hasContent && !over && !disabled && sendable && reads === undefined

  const [held, setHeld] = useState<{ how?: "queue" | "steer" } | undefined>(undefined)
  const send = async (how?: "queue" | "steer", asked = false) => {
    // What's still being heard goes with it, as the person heard it said, listening or settling after a stop.
    const spoken = dictation.hearing
    const full = appendHeard(text, spoken)
    if ((!full.trim() && picked.length === 0) || over || disabled || !sendable || waiting !== undefined || reads !== undefined || taken.current === full) return
    dictation.cancel()
    if (editing) {
      if (!full.trim()) return
      taken.current = full
      const saved = await editing.save(full.trim())
      taken.current = undefined
      return saved
    }
    if (hold && !asked) {
      if (spoken) setText(full)
      setHeld({ how })
      return
    }
    setHeld(undefined)
    taken.current = full
    const message = full.trim()
    const attachments = picked.map((each) => each.attachment)
    const kept = { text: full, picked }
    const id = crypto.randomUUID()
    const steer = (how ?? presentation.kind) === "steer" && steering?.canSteer === true
    // The field empties at once, free for the next message: this one is on its way, kept under its ID until it's
    // confirmed, and the transcript shows it as it goes.
    if (draftKey) {
      noteSending(draftKey, id, kept.text)
      writeDraft(draftKey, "")
    }
    setText("")
    setPicked([])
    const went = await (steer ? steering.steer(message, attachments, id) : onSend(message, attachments, id)).finally(() => {
      if (draftKey) settleSending(draftKey, id)
    })
    if (went) {
      previews.release(kept.picked)
      return
    }
    // What didn't go comes back into the field if it's still empty, pictures and all; over other words it's kept
    // apart (`onUnsent`), or after them where nothing keeps it apart.
    taken.current = undefined
    if (!alive.current) {
      // The composer closed meanwhile (another Thread opened): its words go back into its draft, after any kept there.
      if (draftKey) writeDraft(draftKey, [readDraft(draftKey)?.text ?? "", kept.text].filter((each) => each.trim()).join("\n\n"))
      return
    }
    if (!input.current?.value.trim()) {
      setText(kept.text)
      setPicked((current) => [...kept.picked, ...current])
    } else if (onUnsent) {
      previews.release(kept.picked)
      onUnsent({ id, text: message, attachments })
    } else {
      setText((current) => `${current}\n\n${kept.text}`)
      setPicked((current) => [...kept.picked, ...current])
    }
  }

  const add = async (list: FileList | null) => {
    if (!list?.length) return
    setProblem(undefined)
    setReading((count) => count + list.length)
    for (const file of list) {
      try {
        const next = await readPicked(file)
        previews.hold(next)
        setPicked((current) => [...current, next])
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error))
      } finally {
        setReading((count) => count - 1)
      }
    }
  }

  const remove = (each: Picked) => {
    previews.release([each])
    setPicked((current) => current.filter((other) => other.id !== each.id))
  }

  /**
   * The mic: pressed, it starts listening at once. Let go within `HOLD_MS`, it listens on until stopped (a tap); held
   * longer, it stops on release (push-to-talk). Listening puts the recording in the mic's place, so the button pressed
   * is out of the page before the finger lifts: the release is heard on the window, where a browser that hit-tests it
   * again sends it, and on the button itself, where Safari sends a touch's every event, attached or not.
   */
  const release = useRef<AbortController | null>(null)
  useEffect(() => () => release.current?.abort(), [])
  const micDown = (event: React.PointerEvent) => {
    if (dictation.listening) return
    const pressed = performance.now()
    const pointer = event.pointerId
    const button = event.currentTarget
    release.current?.abort()
    const watch = new AbortController()
    release.current = watch
    const lifted = (up: Event) => {
      if (up instanceof PointerEvent && up.pointerId !== pointer) return
      watch.abort()
      if (performance.now() - pressed >= HOLD_MS) dictation.stop()
    }
    for (const target of [window, button]) for (const type of ["pointerup", "pointercancel"]) target.addEventListener(type, lifted, { signal: watch.signal })
    for (const type of ["touchend", "touchcancel"]) button.addEventListener(type, lifted, { signal: watch.signal })
    dictation.start()
  }

  const budget = encodedBytes(picked)
  const attachments =
    picked.length || reading ? (
      <ul role="list" aria-label="Attachments" className="web-scroll web-attachments flex gap-2 overflow-x-auto">
        {picked.map((each) => (
          <AttachmentTile key={each.id} id={each.id}>
            {each.preview ? <img src={each.preview} alt="" className="size-full object-cover" /> : (
              <span className="flex size-full flex-col items-center justify-center gap-1 px-1.5 text-center">
                <FileIcon className="size-4 text-muted-foreground" />
                <span className="w-full truncate text-label text-muted-foreground">{each.attachment.name}</span>
              </span>
            )}
            <button type="button" aria-label={`Remove ${each.attachment.name}`} className="web-attachment-remove" onClick={() => remove(each)}>
              <XIcon className="size-3" strokeWidth={2.5} />
            </button>
          </AttachmentTile>
        ))}
        {Array.from({ length: reading }, (_, index) => (
          <li key={`reading-${index}`} className="web-attachment skeleton" aria-label="Reading a file" />
        ))}
      </ul>
    ) : null
  const addButton = attach && !editing ? (
    <>
      <button type="button" aria-label="Add photos or files" className="web-icon-button web-composer-add" disabled={disabled} onClick={() => files.current?.click()}>
        <PlusIcon className="size-5" />
      </button>
      <input
        ref={files}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void add(event.target.files)
          event.target.value = ""
        }}
      />
    </>
  ) : null
  const apexStop = useApexStop({ conversationKey: stopFor, onStopApex: () => onStop?.(), phone: !desk })
  const mic =
    !desk && dictation.offered && !dictation.listening ? (
      <button
        type="button"
        aria-label="Dictate"
        className="web-icon-button web-composer-mic"
        disabled={disabled}
        onPointerDown={micDown}
        onClick={(event) => {
          // A keyboard's Enter or Space: no pointer pressed it, so it starts.
          if (event.detail === 0) dictation.start()
        }}
      >
        <MicIcon className="size-[18px]" />
      </button>
    ) : null
  const button = desk ? (
    <ComposerActionButton action={presentation.kind === "stop" ? "stop" : "send"} ready={ready} stopping={stopping} onSend={() => void send()} onStop={apexStop.press} />
  ) : (
    <SendButton
      presentation={onStop || presentation.kind !== "stop" ? presentation : { kind: "send", label: sendLabel }}
      ready={ready}
      stopping={stopping}
      waiting={waiting ?? reads}
      lands={steering?.lands ?? null}
      onSend={(how) => void send(how)}
      onStop={apexStop.press}
    />
  )
  const action = (
    <span className="relative flex shrink-0">
      {apexStop.popover}
      {button}
    </span>
  )
  const recording = dictation.listening ? <RecordingPill dictation={dictation} /> : null
  return (
    <div className="web-composer-wrap" data-asks-first={hold ? "" : undefined}>
      {hold && held ? (
        <HeldSendContext
          value={{
            go: () => void send(held.how, true),
            take: () => {
              setHeld(undefined)
              setText("")
              if (draftKey) writeDraft(draftKey, "")
              return text
            },
          }}
        >
          {hold}
        </HeldSendContext>
      ) : null}
      {over || problem || dictation.failure ? (
        <p role="alert" className="mx-auto w-full max-w-content px-5 pt-1 text-label text-negative">
          {over ? `Too large to send from a phone yet: ${kilobytes(budget)} of ${kilobytes(ATTACHMENT_BUDGET)}.` : (problem ?? dictation.failure)}
        </p>
      ) : null}
      {/*
       * The desktop's composer, from its own geometry (`composer-frame.tsx`): one square box on the pane's surface with
       * a hairline frame, the draft, then one control row; under the box the status line of where and how it runs. On
       * every form the same; under a finger its controls are a thumb's size (`web-client.css`).
       */}
      <form
        className={cn(COMPOSER_COLUMN, "web-composer")}
        data-desk={desk || undefined}
        data-fold-status={foldStatus || undefined}
        data-typing={focused || undefined}
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <div className={cn(COMPOSER_BOX, "web-composer-field", dictation.listening && "web-listening")} data-editing={editing ? "" : undefined}>
          {editing ? (
            <div className="web-composer-editing" role="status">
              <PencilIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Editing a queued message</span>
              <button type="button" className="web-quiet-button web-composer-editing-cancel text-label" onClick={editing.cancel}>
                Cancel
              </button>
            </div>
          ) : null}
          {header}
          {attachments}
          <textarea
            ref={input}
            value={text}
            onChange={(event) => {
              taken.current = undefined
              setText(event.target.value)
              if (event.target.value.trim()) onWrite?.()
            }}
            rows={1}
            enterKeyHint={desk ? undefined : "send"}
            autoFocus={autoFocus}
            disabled={disabled}
            placeholder={dictation.listening ? "Listening…" : placeholder}
            aria-label="Message"
            className="web-composer-input"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              // A hardware keyboard sends with ⌘↩, as on a Mac; ↩ alone is a new line, as phones expect. On the desk, ↩ sends
              // and ⇧↩ is the new line, as the desktop's composer does.
              const sends = desk ? !event.shiftKey && !event.nativeEvent.isComposing : event.metaKey || event.ctrlKey
              if (event.key === "Enter" && sends) {
                event.preventDefault()
                void send()
              }
              if (event.key === "Escape" && editing) {
                event.preventDefault()
                editing.cancel()
              }
            }}
          />
          <div className={cn(COMPOSER_CONTROLS, "web-composer-bar")} data-composer-controls>
            {recording ?? (
              <>
                {addButton}
                {/* Not the desktop's scrolling row: its one chip truncates instead, and its touch reaches past it. */}
                <div className="web-composer-tools">{tools}</div>
                {mic}
              </>
            )}
            {action}
          </div>
        </div>
        {/* Under a finger the status line is a thumb's 44 px, its facts as tall (`web-client.css`). */}
        <ComposerStatus className="web-composer-status pointer-coarse:mb-0 pointer-coarse:h-11">{status}</ComposerStatus>
      </form>
    </div>
  )
}

/**
 * Dictation in the composer's bar while it listens: the stop square, how long it has listened, the microphone's level
 * in five bars, and the words still being heard, the last few dimmed while the recognizer may still change them.
 */
function RecordingPill({ dictation }: { dictation: Dictation }) {
  const since = dictation.since ?? 0
  const { sure, unsure } = splitUnsure(dictation.hearing)
  return (
    <div className="web-recording" role="group" aria-label="Dictating">
      <button type="button" aria-label="Stop dictating" className="web-recording-stop" onClick={dictation.stop}>
        <SquareIcon aria-hidden className="size-3 fill-current" />
      </button>
      <Ticking words={(now) => elapsedWords(now - since)} className="web-recording-time" />
      <MeterBars levels={dictation.levels} />
      <span className="web-recording-words" aria-live="polite">
        {sure ? <span>{sure} </span> : null}
        {unsure ? <span className="text-faint">{unsure}</span> : dictation.hearing ? null : <span className="text-faint">Listening</span>}
      </span>
    </div>
  )
}

/** The meter's five bars, 5 to 14 px tall: each sample is written to them as it comes, rendering nothing. */
function MeterBars({ levels }: { levels: MeterLevels }) {
  const bars = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const draw = (sampled: readonly number[]) => {
      const nodes = bars.current?.children
      if (!nodes) return
      sampled.forEach((level, index) => {
        const node = nodes[index]
        if (node instanceof HTMLElement) node.style.height = `${5 + Math.round(level * 9)}px`
      })
    }
    draw(levels.get())
    return levels.subscribe(draw)
  }, [levels])
  return (
    <span ref={bars} aria-hidden className="web-recording-bars">
      {Array.from({ length: METER_BARS }, (_, index) => (
        <span key={index} />
      ))}
    </span>
  )
}

/**
 * Keeps a composer's words under `key` as they're written: a quarter second after the last key, and at once when the
 * page is hidden or goes (an app switcher, a reload) or the composer closes (another Thread opened).
 */
function useDraft(key: string | undefined, text: string): void {
  const latest = useRef(text)
  useEffect(() => {
    latest.current = text
    if (!key) return
    const timer = setTimeout(() => writeDraft(key, text), DRAFT_WRITE_MS)
    return () => clearTimeout(timer)
  }, [key, text])
  useEffect(() => {
    if (!key) return
    const flush = () => writeDraft(key, latest.current)
    const hidden = () => {
      if (document.visibilityState === "hidden") flush()
    }
    document.addEventListener("visibilitychange", hidden)
    window.addEventListener("pagehide", flush)
    return () => {
      document.removeEventListener("visibilitychange", hidden)
      window.removeEventListener("pagehide", flush)
      flush()
    }
  }, [key])
}

/** An attached file's tile: removed, it shrinks away and the rest close up (`exit-motion.ts`). */
function AttachmentTile({ id, children }: { id: string; children: ReactNode }) {
  const exit = useExit<HTMLLIElement>(`attachment:${id}`, { motion: "shrink" })
  return (
    <li ref={exit} className="web-attachment">
      {children}
    </li>
  )
}
