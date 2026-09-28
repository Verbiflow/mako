import { capabilityToken, threadToken } from "@/lib/mentions"
import { isMakoServerName } from "@/lib/composer-capabilities"
import { fileName } from "@/lib/format"
import { skillChipTitle, type SkillAppendixEntry } from "@/lib/skill-references"
import { findThreadReference } from "@/lib/thread-references"
import type { SkillDelivery } from "@/lib/types"
import { UNIVERSAL_SKILL_PROVIDER } from "../../../electron/contracts/skill-reach"
import { desktop } from "@/state/desktop"
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
const chip = "ref-token inline-flex max-w-[20rem] items-baseline gap-1 px-1 align-baseline [&_svg]:translate-y-[2px]"

export function FileChip({
  path,
  name,
  interactive,
}: {
  path: string
  name?: string
  interactive?: boolean
}) {
  const body = <span className="truncate">{name ?? fileName(path)}</span>
  if (!interactive) {
    return (
      <span className={chip} title={path} data-copy-file={path} data-copy-reference={`@${path}`}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      title={`Show ${path} in Finder`}
      data-copy-file={path}
      data-copy-reference={`@${path}`}
      onClick={() => void desktop.revealPath(path)}
      className={cn(chip, "pressable")}
    >
      {body}
    </button>
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
      <span className="truncate">{label}</span>
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
      className={cn(chip, "gap-0")}
    >
      <span className="ref-sigil">$</span>
      {name}
      {delivery?.kind === "handover" ? (
        <SkillSourceMark
          from={delivery.from}
          className="ml-1 size-2.5 shrink-0 self-center text-faint"
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
