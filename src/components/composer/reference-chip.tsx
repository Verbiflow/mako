import { capabilityToken, threadToken } from "@/lib/mentions"
import { isMakoServerName } from "@/lib/composer-capabilities"
import { fileName } from "@/lib/format"
import { skillChipTitle, skillSourceLabel, type SkillAppendixEntry } from "@/lib/skill-references"
import { findThreadReference } from "@/lib/thread-references"
import type { SkillDelivery } from "@/lib/types"
import { UNIVERSAL_SKILL_PROVIDER } from "@mako/host/contracts/skill-reach"
import { useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { InlineFilePreview } from "@/components/transcript/file-preview"
import { useThreads } from "@/state/threads"
import { MakoMark } from "@/components/ui/mako-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"
import { GlobeIcon } from "lucide-react"
import { parseThreadToken } from "@/lib/mentions"
import type { Attachment } from "@/lib/attachments"
import type { ContextDetail } from "@/lib/context-detail"
import type { SentItem } from "@/lib/context/sent"
import type { FileItem } from "@/lib/context/kinds"
import { desktop } from "@/state/desktop"
import { viewer } from "@/state/viewer"
import { ContextGlyph } from "./context-glyph"
import { WindowCapturePreview } from "./window-capture"

/**
 * The transcript's form of a reference: the composer's `.ref-token` with real
 * padding, so a file, a conversation or a skill reads the same before and
 * after it is sent. Words, not glyphs: a conversation keeps its agent's mark,
 * a built-in server keeps Mako's, and nothing else wears an icon.
 */
const chip = "ref-token ref-chip [&_svg]:mr-1 [&_svg]:inline-block [&_svg]:align-[-2px]"

export function FileChip({
  path,
  name,
  interactive,
  recordId,
  mimeType,
}: {
  path: string
  name?: string
  interactive?: boolean
  /** The draft record this chip becomes when copied, for a file the prompt attached. */
  recordId?: string
  mimeType?: string
}) {
  // A folder (`src/lib/`) is named by its own last part.
  const body = name ?? (path.endsWith("/") ? `${fileName(path.slice(0, -1))}/` : fileName(path))
  const [open, setOpen] = useState(false)
  if (!interactive) {
    return (
      <span className={chip} title={path} data-copy-file={path} data-copy-record={recordId} data-copy-reference={`@${path}`}>
        {body}
      </span>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`Preview ${body}`}
          data-copy-file={path}
          data-copy-record={recordId}
          data-copy-reference={`@${path}`}
          className={cn(chip, "pressable leading-[1.25]")}
        >
          {recordId ? <ContextGlyph mimeType={mimeType} /> : null}
          {body}
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={`${body} preview`}
        align="start"
        className="max-h-[75vh] w-[min(36rem,calc(100vw-2rem))] gap-0 overflow-auto p-0 [&>[data-inline-file-preview]]:my-0 [&>[data-inline-file-preview]]:border-0"
      >
        {open ? <InlineFilePreview path={path} name={body} initiallyOpen /> : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A referenced conversation. With a token (`harness` and `id`) the chip
 * resolves the catalog row exactly as the send does, so it never names a
 * conversation the prompt would then report as unavailable, and copying it
 * yields the token. A prompt sent before the appendix carried tokens has
 * only what its heading said, so the chip shows that `title` and copies as
 * text.
 */
export function ThreadChip({
  harness,
  id,
  title,
}: {
  harness?: string
  /** The token's id: the provider's identity, or a native id from an older draft. */
  id?: string
  /** The heading's title, for a reference that carried no token. */
  title?: string
}) {
  const thread = useThreads((state) =>
    harness && id ? findThreadReference(state.threads, harness, id) : undefined
  )
  const label = thread?.title ?? title ?? "Referenced conversation"
  return (
    <span
      title={thread?.title ?? title ?? `${harness ?? "referenced"} conversation`}
      data-copy-reference={harness && id ? threadToken(harness, id) : undefined}
      className={chip}
    >
      {harness ? <HarnessIcon harness={harness} className="size-3.5 shrink-0" /> : null}
      {label}
    </span>
  )
}

/**
 * How a `$skill` reached the provider, in the transcript. `undefined` is a
 * prompt sent before Mako resolved skills, or prose that is not a prompt;
 * the chip says nothing it cannot know.
 */
export type SkillChipSent = SkillAppendixEntry | null | undefined

function sentDelivery(sent: SkillChipSent): SkillDelivery | undefined {
  if (sent === undefined) return undefined
  if (sent === null) return { kind: "missing" }
  return sent.from
    ? { kind: "handover", path: "", from: sent.from, source: skillSourceLabel(sent.from) }
    : { kind: "native", path: "" }
}

/** The glyph that says where a handover came from: the provider's mark, or the universal root's. */
export function SkillSourceMark({
  from,
  className,
}: {
  from: string
  className?: string
}) {
  return from === UNIVERSAL_SKILL_PROVIDER ? (
    <GlobeIcon className={className} aria-hidden />
  ) : (
    <HarnessIcon harness={from} className={className} tinted={false} />
  )
}

export function SkillChip({
  name,
  sent,
}: {
  name: string
  sent?: SkillChipSent
}) {
  const delivery = sentDelivery(sent)
  return (
    <span
      title={skillChipTitle(name, delivery)}
      data-copy-reference={capabilityToken("/", "skill", name)}
      data-skill-delivery={delivery?.kind}
      className={chip}
    >
      <span className="ref-sigil">/</span>
      {name}
      {delivery?.kind === "handover" ? (
        <SkillSourceMark
          from={delivery.from}
          className="ml-1 size-2.5 text-faint !mr-0"
        />
      ) : null}
    </span>
  )
}

/** An MCP server the prompt points the agent at; Mako's own wear the fin. */
export function McpChip({ name }: { name: string }) {
  const builtIn = isMakoServerName(name)
  return (
    <span
      title={builtIn ? `Built-in Mako MCP server: ${name}` : `MCP server: ${name}`}
      data-copy-reference={capabilityToken("/", "mcp", name)}
      className={chip}
    >
      {builtIn ? <MakoMark className="size-3" /> : null}
      {name}
    </span>
  )
}

/**
 * One of a sent prompt's items, as the chip it was in the composer: a
 * conversation by its agent's mark, a file that opens its preview, and a
 * comment, element, quote or pull request that opens what it holds. Copying
 * it yields the record Reuse would make (`data-copy-record`), so a pasted
 * chip is the chip.
 */
export function ContextItemChip({ item, record }: { item: SentItem; record?: Attachment }) {
  if (item.kind === "conversation") {
    const token = item.conversation.ref ? parseThreadToken(item.conversation.ref) : null
    return token ? (
      <ThreadChip harness={token.harness} id={token.id} />
    ) : (
      <ThreadChip harness={item.conversation.harness} title={item.conversation.title} />
    )
  }
  if (item.kind === "file") {
    const label = item.file.label ?? item.file.name
    if (item.file.path && item.file.window)
      return <WindowChip file={{ ...item.file, path: item.file.path, window: item.file.window }} label={label} recordId={record?.id} />
    if (item.file.path)
      return <FileChip path={item.file.path} name={label} interactive recordId={record?.id} mimeType={item.file.mimeType} />
    return (
      <span className={chip} data-copy-record={record?.id}>
        <ContextGlyph mimeType={item.file.mimeType} origin={item.file.origin} />
        {label}
      </span>
    )
  }
  if (item.kind === "detail")
    return <DetailChip detail={item.detail} label={item.label} screenshot={item.screenshot} recordId={record?.id} />
  return null
}

/** A window capture in a sent prompt: whose window, opening to the picture with its elements drawn over it. */
function WindowChip({
  file,
  label,
  recordId,
}: {
  file: FileItem & { path: string; window: NonNullable<FileItem["window"]> }
  label: string
  recordId?: string
}) {
  const [open, setOpen] = useState(false)
  const picture: Attachment = {
    id: file.path,
    index: 0,
    name: file.name,
    mimeType: file.mimeType,
    kind: "image",
    stagedPath: file.path,
    ...(file.contextPath && { contextPath: file.contextPath }),
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`Capture of ${file.window.app}${file.window.title ? ` — ${file.window.title}` : ""}`}
          data-copy-file={file.path}
          data-copy-record={recordId}
          data-context-chip="window"
          className={cn(chip, "pressable leading-[1.25]")}
        >
          <ContextGlyph origin="window" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={`Capture of ${file.window.app}`}
        align="start"
        className="w-[min(44rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0"
      >
        {open ? <WindowCapturePreview item={picture} app={file.window.app} title={file.window.title} outline={file.outline} /> : null}
      </PopoverContent>
    </Popover>
  )
}

function DetailChip({
  detail,
  label,
  screenshot,
  recordId,
}: {
  detail: ContextDetail
  label: string
  screenshot?: string
  recordId?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-copy-record={recordId}
          data-context-chip={detail.kind}
          className={cn(chip, "pressable leading-[1.25]")}
        >
          <ContextGlyph detail={detail.kind} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={label}
        align="start"
        className="max-h-[70vh] w-[min(32rem,calc(100vw-2rem))] gap-2 overflow-auto p-3 text-ui"
      >
        {open ? <DetailBody detail={detail} screenshot={screenshot} /> : null}
      </PopoverContent>
    </Popover>
  )
}

function DetailCode({ text }: { text: string }) {
  return text ? (
    <pre className="max-h-64 overflow-auto rounded-md bg-surface p-2 font-mono text-code leading-relaxed whitespace-pre-wrap text-foreground">{text}</pre>
  ) : null
}

function DetailBody({ detail, screenshot }: { detail: ContextDetail; screenshot?: string }) {
  if (detail.kind === "comment") {
    const lines = detail.startLine === detail.endLine ? `line ${detail.startLine}` : `lines ${detail.startLine}–${detail.endLine}`
    return (
      <>
        <button type="button" className="pressable self-start text-left text-ui font-medium text-foreground hover:underline" onClick={() => void viewer.open(detail.path, detail.startLine)}>
          {detail.path}, {lines}
        </button>
        {detail.source === "diff" ? (
          <span className="text-label text-muted-foreground">
            {detail.side === "old" ? "Removed side" : "Added side"} of the diff{detail.base ? ` against ${detail.base}` : ""}
          </span>
        ) : null}
        {detail.comment ? <p className="text-ui text-foreground">{detail.comment}</p> : null}
        <DetailCode text={detail.code} />
      </>
    )
  }
  if (detail.kind === "element") {
    return (
      <>
        <span className="text-ui font-medium text-foreground">{detail.component ?? detail.tag}</span>
        <span className="truncate text-label text-muted-foreground">{detail.title || detail.url}</span>
        {screenshot ? <InlineFilePreview path={screenshot} name={detail.component ?? detail.tag} initiallyOpen /> : null}
        {detail.comment ? <p className="text-ui text-foreground">{detail.comment}</p> : null}
        {detail.source ? (
          <button type="button" className="pressable self-start font-mono text-code text-muted-foreground hover:underline" onClick={() => detail.source && void viewer.open(detail.source.file, detail.source.line)}>
            {[detail.source.file, detail.source.line, detail.source.column].filter((part) => part !== undefined).join(":")}
          </button>
        ) : null}
        {detail.selector ? <span className="font-mono text-code text-muted-foreground">{detail.selector}</span> : null}
        <DetailCode text={detail.html} />
      </>
    )
  }
  if (detail.kind === "quote") return <p className="text-ui whitespace-pre-wrap text-foreground">{detail.text}</p>
  const state = detail.state === "open" && detail.draft ? "Draft" : detail.state === "open" ? "Open" : detail.state === "merged" ? "Merged" : "Closed"
  return (
    <>
      <span className="text-ui font-medium text-foreground">
        #{detail.number} {detail.title}
      </span>
      <span className="text-label text-muted-foreground">
        {state} · {detail.head} into {detail.base}
      </span>
      <button type="button" className="pressable self-start text-label text-muted-foreground hover:underline" onClick={() => void desktop.openUrl(detail.url)}>
        Open on GitHub
      </button>
    </>
  )
}
