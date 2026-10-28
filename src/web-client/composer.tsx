import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { FileIcon, MicIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react"
import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import { cn } from "@/lib/utils"
import { ATTACHMENT_BUDGET, encodedBytes, kilobytes, readPicked, releasePicked, type Picked } from "./attachments"
import { useDictation, type Heard } from "./dictation"
import { SendGlyph } from "./glyphs"

/** Held this long, the mic is push-to-talk: it listens while held and stops on release. A tap toggles it. */
const HOLD_MS = 300
const MAX_HEIGHT = 180

/**
 * The phone's composer, one for every place a message is written: a Thread's, a quiet Mac's, and a new Thread's. `+`
 * opens the phone's own picker (photos, camera, files); the field grows with its words; the mic dictates while the field
 * is empty, Send sends once it isn't, and Stop stops a turn at work while it's empty. `onSend` says whether the message
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
  accessory,
  autoFocus = false,
  sendLabel = "Send",
}: {
  placeholder: string
  onSend: (text: string, attachments: PromptAttachment[]) => Promise<boolean>
  running?: boolean
  onStop?: () => void
  stopping?: boolean
  disabled?: boolean
  /** Whether a message can go yet: the field takes words before (a new Thread's place still being read), Send waits. */
  sendable?: boolean
  attach?: boolean
  accessory?: ReactNode
  autoFocus?: boolean
  sendLabel?: string
}) {
  const [text, setText] = useState("")
  const [picked, setPicked] = useState<Picked[]>([])
  const [reading, setReading] = useState(0)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const input = useRef<HTMLTextAreaElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const before = useRef("")
  const pressedAt = useRef(0)
  const stopOnRelease = useRef(false)

  useLayoutEffect(() => {
    const node = input.current
    if (!node) return
    node.style.height = "auto"
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`
  }, [text])
  useEffect(() => () => releasePicked(picked), [picked])

  const heard = useCallback((words: Heard) => {
    const spoken = [words.final, words.interim].filter(Boolean).join(" ")
    setText(before.current ? `${before.current} ${spoken}`.trimEnd() : spoken)
  }, [])
  const dictation = useDictation(heard)

  const over = encodedBytes(picked) > ATTACHMENT_BUDGET
  const empty = !text.trim() && picked.length === 0
  const send = async () => {
    if (empty || over || sending || disabled || !sendable) return
    if (dictation.listening) dictation.stop()
    const message = text.trim()
    const attachments = picked.map((each) => each.attachment)
    const kept = { text, picked }
    // The field empties at once: the message is on its way, and the transcript shows it as it arrives.
    setText("")
    setPicked([])
    setSending(true)
    try {
      const went = await onSend(message, attachments)
      if (went) releasePicked(kept.picked)
      else {
        setText((current) => current || kept.text)
        setPicked((current) => (current.length ? current : kept.picked))
      }
    } finally {
      setSending(false)
    }
  }

  const add = async (list: FileList | null) => {
    if (!list?.length) return
    setProblem(undefined)
    setReading((count) => count + list.length)
    for (const file of list) {
      try {
        const next = await readPicked(file)
        setPicked((current) => [...current, next])
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error))
      } finally {
        setReading((count) => count - 1)
      }
    }
  }

  /**
   * The mic: pressed while quiet, it starts listening at once. Let go within `HOLD_MS`, it listens on until tapped
   * again (a tap); held longer, it stops on release (push-to-talk). Pressed while listening, it stops on release.
   */
  const micDown = () => {
    pressedAt.current = performance.now()
    stopOnRelease.current = dictation.listening
    if (dictation.listening) return
    before.current = text.trim()
    dictation.start()
  }
  const micUp = () => {
    if (stopOnRelease.current || performance.now() - pressedAt.current >= HOLD_MS) dictation.stop()
    stopOnRelease.current = false
  }
  const micKey = () => {
    if (dictation.listening) return dictation.stop()
    before.current = text.trim()
    dictation.start()
  }

  const showStop = running && empty && onStop !== undefined
  const showMic = empty && !running && dictation.offered
  const budget = encodedBytes(picked)
  return (
    <div className="web-composer-wrap">
      {accessory}
      {picked.length || reading ? (
        <ul role="list" aria-label="Attachments" className="web-scroll flex gap-2 overflow-x-auto px-3 pt-2 pb-1">
          {picked.map((each) => (
            <li key={each.id} className="web-attachment">
              {each.preview ? <img src={each.preview} alt="" className="size-full object-cover" /> : (
                <span className="flex size-full flex-col items-center justify-center gap-1 px-1.5 text-center">
                  <FileIcon className="size-4 text-muted-foreground" />
                  <span className="w-full truncate text-label text-muted-foreground">{each.attachment.name}</span>
                </span>
              )}
              <button type="button" aria-label={`Remove ${each.attachment.name}`} className="web-attachment-remove" onClick={() => setPicked((current) => current.filter((other) => other.id !== each.id))}>
                <XIcon className="size-3" strokeWidth={2.5} />
              </button>
            </li>
          ))}
          {Array.from({ length: reading }, (_, index) => (
            <li key={`reading-${index}`} className="web-attachment skeleton" aria-label="Reading a file" />
          ))}
        </ul>
      ) : null}
      {over || problem || dictation.failure ? (
        <p role="alert" className="px-4 pt-1 text-label text-negative">
          {over ? `Too large to send from a phone yet: ${kilobytes(budget)} of ${kilobytes(ATTACHMENT_BUDGET)}.` : (problem ?? dictation.failure)}
        </p>
      ) : null}
      <form
        className="web-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {attach ? (
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
        ) : null}
        <div className={cn("web-composer-field", dictation.listening && "web-listening")}>
          <textarea
            ref={input}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={1}
            enterKeyHint="send"
            autoFocus={autoFocus}
            disabled={disabled}
            placeholder={dictation.listening ? "Listening…" : placeholder}
            aria-label="Message"
            className="web-composer-input"
            onKeyDown={(event) => {
              // A hardware keyboard sends with ⌘↩, as on a Mac; ↩ alone is a new line, as phones expect.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void send()
              }
            }}
          />
          {showStop ? (
            <button type="button" onClick={onStop} disabled={stopping} className="web-send web-stop" aria-label="Stop the turn">
              <SquareIcon className="size-3 fill-current" />
            </button>
          ) : showMic || dictation.listening ? (
            <button
              type="button"
              aria-label={dictation.listening ? "Stop dictating" : "Dictate"}
              aria-pressed={dictation.listening}
              className={cn("web-send web-mic", dictation.listening && "web-mic-on")}
              disabled={disabled}
              onPointerDown={micDown}
              onPointerUp={micUp}
              onPointerCancel={micUp}
              onClick={(event) => {
                // A keyboard's Enter or Space: no pointer pressed it, so it toggles.
                if (event.detail === 0) micKey()
              }}
            >
              <MicIcon className="size-[18px]" />
            </button>
          ) : (
            <button type="submit" disabled={empty || over || sending || disabled || !sendable} className="web-send" aria-label={running ? "Queue message" : sendLabel}>
              <SendGlyph />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
