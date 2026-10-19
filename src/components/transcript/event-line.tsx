import { useId, useState, type ComponentType, type ReactNode } from "react"
import {
  ActivityIcon,
  ArrowLeftRightIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleStopIcon,
  FoldVerticalIcon,
  GaugeIcon,
  HistoryIcon,
  HourglassIcon,
  InfoIcon,
  KeyRoundIcon,
  PuzzleIcon,
  ShieldIcon,
  TargetIcon,
  TriangleAlertIcon,
  WebhookIcon,
} from "lucide-react"
import type { EventTone } from "@mako/sessions/events"
import type { ToolKind } from "@mako/sessions/tool-identity"
import { Collapse } from "@/components/ui/collapse"
import { ToolGlyph } from "@/components/transcript/tool-views"
import type { EventGlyph, EventWords } from "@/lib/transcript-events"
import { formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"

type Icon = ComponentType<{ className?: string }>

/** Glyphs the tool rows already use keep the tool rows' icons, so a command reads the same finished as running. */
const TOOL_GLYPHS = {
  command: "shell",
  agent: "agent",
  review: "review",
  mcp: "mcp",
} as const satisfies Partial<Record<EventGlyph, ToolKind>>

const ICONS = {
  monitor: ActivityIcon,
  task: HourglassIcon,
  goal: TargetIcon,
  compaction: FoldVerticalIcon,
  model: ArrowLeftRightIcon,
  stop: CircleStopIcon,
  history: HistoryIcon,
  rules: ShieldIcon,
  plugin: PuzzleIcon,
  hook: WebhookIcon,
  key: KeyRoundIcon,
  limit: GaugeIcon,
  notice: InfoIcon,
  warning: TriangleAlertIcon,
  error: CircleAlertIcon,
} satisfies Record<Exclude<EventGlyph, keyof typeof TOOL_GLYPHS>, Icon>

/**
 * Attention is the glyph in its hue and the sentence at full strength. Only
 * an error's words take the hue as well: a warning painted whole reads as an
 * alarm, and the caution glyph already says what it is.
 */
const TONE_GLYPH = { error: "text-negative", warning: "text-caution" } satisfies Record<EventTone, string>
const TONE_TEXT = { error: "text-negative", warning: "text-foreground" } satisfies Record<EventTone, string>

function isToolGlyph(glyph: EventGlyph): glyph is keyof typeof TOOL_GLYPHS {
  return Object.hasOwn(TOOL_GLYPHS, glyph)
}

export function EventGlyphIcon({ glyph, icon, className }: { glyph?: EventGlyph; icon?: Icon; className?: string }) {
  if (glyph && isToolGlyph(glyph)) return <ToolGlyph kind={TOOL_GLYPHS[glyph]} className={className} />
  const Glyph = icon ?? (glyph ? ICONS[glyph] : InfoIcon)
  return <Glyph className={className} />
}

/**
 * The one line every event in the transcript is drawn with: a glyph in the
 * column the tool rows keep for theirs, the sentence, what it happened to,
 * and the moment when the event opens a turn. Quiet by default; `tone`
 * colours the glyph and the sentence, nothing else, for the few that want
 * attention. `align="end"` stands where a prompt would, for what started a
 * turn that nobody typed. `children` is what opens under it: the provider's
 * own words, a summary, an error body. Nothing below it is mounted until it
 * is opened. `action` is a quiet control on the line, shown on hover, or at
 * the foot of what opens when there is a body.
 */
export function EventLine({
  words,
  icon,
  align = "start",
  time,
  action,
  children,
  className,
  ...data
}: {
  words: Pick<EventWords, "title" | "detail" | "aside" | "tone"> & { glyph?: EventGlyph }
  /** A glyph outside the event vocabulary, for Mako's own lines. */
  icon?: Icon
  align?: "start" | "end"
  time?: number
  action?: ReactNode
  children?: ReactNode
  className?: string
} & Record<`data-${string}`, string | boolean | undefined>) {
  const [open, setOpen] = useState(false)
  const body = useId()
  const end = align === "end"
  const tone = words.tone ? TONE_TEXT[words.tone] : undefined
  const glyphTone = words.tone ? TONE_GLYPH[words.tone] : undefined
  const layer = "absolute inset-0 m-auto size-3.5 [transition:opacity_150ms_var(--ease-out),transform_150ms_var(--ease-out)]"
  const line = (
    <>
      <span className="relative size-3.5 shrink-0">
        <EventGlyphIcon
          glyph={words.glyph}
          icon={icon}
          className={cn(layer, glyphTone ?? "text-faint", children && (open ? "opacity-0" : "group-hover/event:opacity-0 group-focus-visible/event:opacity-0"))}
        />
        {children ? (
          <ChevronRightIcon
            aria-hidden
            className={cn(layer, "text-faint", open ? "rotate-90 opacity-100" : "opacity-0 group-hover/event:opacity-100 group-focus-visible/event:opacity-100")}
          />
        ) : null}
      </span>
      {/* The sentence keeps its width up to most of the line; what it happened to gives way first. */}
      <span data-event-title className={cn("min-w-0 max-w-[80%] shrink-0 truncate", tone ?? "text-muted-foreground")}>{words.title}</span>
      {words.detail ? <span className="min-w-0 truncate text-faint">{words.detail}</span> : null}
      {words.aside ? <span className="shrink-0 text-faint tabular">{words.aside}</span> : null}
      {time ? (
        <time dateTime={new Date(time).toISOString()} className={cn("shrink-0 text-label text-faint tabular", !end && "ml-auto pl-2")}>
          {formatTime(time)}
        </time>
      ) : null}
    </>
  )
  const row = cn("flex h-7 min-w-0 max-w-full items-center gap-2 text-ui", end && "justify-end")
  if (!children)
    return (
      <div role="note" data-event-line className={cn(row, "group/event", end && "self-end", className)} {...data}>
        {line}
        {action ? (
          <span className={cn("shrink-0 text-label text-faint opacity-0 transition-opacity duration-150 group-hover/event:opacity-100 focus-within:opacity-100", !time && !end && "ml-auto")}>
            {action}
          </span>
        ) : null}
      </div>
    )
  return (
    <div className={cn("flex min-w-0 flex-col", end && "items-end", className)} {...data}>
      <button
        type="button"
        data-event-line
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={body}
        className={cn(
          row,
          "pressable group/event -mx-1.5 rounded-md px-1.5 text-left transition-colors duration-100 hover:bg-fill-hover focus-visible:bg-fill-hover",
          end ? "max-w-[calc(100%+12px)]" : "w-[calc(100%+12px)]"
        )}
      >
        {line}
      </button>
      <Collapse open={open} className={cn(end ? "w-fit max-w-[min(82%,64ch)]" : "w-full")}>
        {/* Under a line in the answer's column, the body hangs from the
            glyph on a hairline as a tool's does; under a line where a prompt
            stands, it is a caption set to the same right edge. */}
        <div
          id={body}
          className={cn(
            "max-h-80 overflow-y-auto text-ui text-muted-foreground",
            end ? "pt-0.5 pb-1.5 pr-1.5" : "ml-1.75 border-l border-hairline py-1.5 pl-3.75"
          )}
        >
          {children}
        </div>
        {action ? (
          <div className={cn("flex text-label text-faint", end ? "justify-end pr-1.5 pb-1.5" : "ml-1.75 border-l border-hairline pb-1.5 pl-2.75")}>{action}</div>
        ) : null}
      </Collapse>
    </div>
  )
}
