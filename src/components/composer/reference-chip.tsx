import { capabilityToken, threadToken } from "@/lib/mentions"
import { isMakoServerName } from "@/lib/composer-capabilities"
import { fileName } from "@/lib/format"
import { skillChipTitle, type SkillAppendixEntry } from "@/lib/skill-references"
import { findThreadReference } from "@/lib/thread-references"
import type { SkillDelivery } from "@/lib/types"
import { UNIVERSAL_SKILL_PROVIDER } from "../../../electron/contracts/skill-reach"
import { useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { InlineFilePreview } from "@/components/transcript/file-preview"
import { useThreads } from "@/state/threads"
import { MakoMark } from "@/components/ui/mako-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"
import { GlobeIcon } from "lucide-react"

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
}: {
  path: string
  name?: string
  interactive?: boolean
}) {
  const body = name ?? fileName(path)
  const [open, setOpen] = useState(false)
  if (!interactive) {
    return (
      <span className={chip} title={path} data-copy-file={path} data-copy-reference={`@${path}`}>
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
          data-copy-reference={`@${path}`}
          className={cn(chip, "pressable leading-[1.25]")}
        >
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
    ? { kind: "handover", path: "", from: sent.from }
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
      data-copy-reference={capabilityToken("$", "skill", name)}
      data-skill-delivery={delivery?.kind}
      className={chip}
    >
      <span className="ref-sigil">$</span>
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
      data-copy-reference={capabilityToken("$", "mcp", name)}
      className={chip}
    >
      {builtIn ? <MakoMark className="size-3 shrink-0 text-foreground" /> : null}
      {name}
    </span>
  )
}
