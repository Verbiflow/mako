import { memo, useEffect } from "react"
import { tokenize } from "@/lib/mentions"
import { attachmentRanges } from "@/lib/attachment-references"
import type { Attachment } from "@/lib/attachments"
import { draftSkillDelivery, isSkillName, skillChipTitle } from "@/lib/skill-references"
import { findThreadReference } from "@/lib/thread-references"
import { cn } from "@/lib/utils"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useSession } from "@/state/session"
import { skills, useSkills } from "@/state/skills"
import { useThreads } from "@/state/threads"
import { InlineAttachment } from "./attachments"

/**
 * The painted layer behind the composer's textarea.
 *
 * It must match the textarea's box and metrics exactly — same padding, same
 * font, same leading, same wrapping — because the caret the user sees belongs
 * to the textarea and this layer only supplies the glyphs. Any divergence
 * shows up immediately as text drifting away from the cursor.
 *
 * So a reference here is the typed characters on a `.ref-token` fill, never a
 * differently-shaped box: the sigil fades, an attachment's brackets vanish
 * into the fill's air, a file's folders go quiet behind its name, and a
 * conversation's token is covered by its title within the token's own width.
 * A `$skill` says how it will reach the provider with nothing that takes
 * width: a dotted underline for one the provider lacks and will be handed,
 * a dashed edge for one nothing has installed.
 */
export const ReferenceOverlay = memo(function ReferenceOverlay({
  text,
  attachments,
}: {
  text: string
  attachments: Attachment[]
}) {
  const ranges = attachmentRanges(text, attachments)
  const pieces = []
  let cursor = 0
  for (const range of ranges) {
    pieces.push(...tokenize(text.slice(cursor, range.start), cursor === 0))
    pieces.push({
      kind: "attachment" as const,
      item: range.item,
      raw: text.slice(range.start, range.end),
    })
    cursor = range.end
  }
  const segments = [...pieces, ...tokenize(text.slice(cursor), cursor === 0)]

  const harness = useThreads((state) => state.composerHarness)
  const snapshot = useSkills((state) => state.snapshot)
  const workspaceCwd = useSession((state) => state.meta?.cwd ?? "")
  // A draft that names a skill without ever opening the menu still gets an
  // honest chip: the registry loads once per workspace and is cached.
  const referencesSkill = segments.some(
    (segment) => segment.kind === "skill" && isSkillName(segment.name)
  )
  useEffect(() => {
    if (referencesSkill) skills.ensure(workspaceCwd)
  }, [referencesSkill, workspaceCwd])

  return (
    <div
      // `inset-x-0 top-0` and **no** `bottom`: inside a scrolling box,
      // `inset-0` resolves `bottom` against the *visible* height, so the
      // painted layer was exactly one screenful tall no matter how long the
      // draft was. Everything below that had no glyphs — and since the
      // textarea's own text is transparent, it simply disappeared as you
      // typed past the fold. Letting the height come from the content makes it
      // match the textarea's scroll height, which is the whole contract.
      className="pointer-events-none absolute inset-x-0 top-0 px-4 pt-4 pb-2 font-sans text-prose leading-[1.6] break-words whitespace-pre-wrap text-foreground"
    >
      {segments.map((segment, index) => {
        if (segment.kind === "attachment")
          return <InlineAttachment key={index} item={segment.item} reference={segment.raw} />
        if (segment.kind === "text")
          return (
            <span aria-hidden key={index}>
              {segment.text}
            </span>
          )
        if (segment.kind === "file") {
          const slash = segment.path.lastIndexOf("/") + 1
          return (
            <span key={index} className="ref-token" title={segment.path}>
              <span className="ref-sigil">@</span>
              <span className="text-muted-foreground">{segment.path.slice(0, slash)}</span>
              {segment.path.slice(slash)}
            </span>
          )
        }
        if (segment.kind === "thread")
          return <ThreadToken key={index} harness={segment.harness} id={segment.id} raw={segment.raw} />
        // `$5` in a sentence about money is prose the tokenizer let
        // through, not a skill nothing has installed.
        if (segment.kind === "skill" && !isSkillName(segment.name))
          return (
            <span aria-hidden key={index}>
              {segment.raw}
            </span>
          )
        if (segment.kind === "skill") {
          const delivery = snapshot
            ? draftSkillDelivery(snapshot, segment.name, harness)
            : undefined
          return (
            <span
              key={index}
              data-skill-delivery={delivery?.kind}
              title={skillChipTitle(segment.name, delivery)}
              className="ref-token"
            >
              <span className="ref-sigil">{segment.raw.slice(0, 1)}</span>
              <span
                className={cn(
                  delivery?.kind === "handover" &&
                    "underline decoration-dotted decoration-muted-foreground underline-offset-[3px]"
                )}
              >
                {segment.raw.slice(1)}
              </span>
            </span>
          )
        }
        const prefix = segment.raw.length - segment.name.length
        return (
          <span key={index} className="ref-token" title={`MCP server: ${segment.name}`}>
            <span className="ref-sigil">{segment.raw.slice(0, prefix)}</span>
            {segment.name}
          </span>
        )
      })}
      {/* A trailing newline keeps the last line's height when the draft ends
          with a break, matching how the textarea measures itself. */}
      {text.endsWith("\n") ? <span>{"​"}</span> : null}
    </div>
  )
})

/**
 * `@thread:codex:019a…` reads as the conversation it names. The token's own
 * characters still set the width, so the caret and wrapping stay the
 * textarea's; the title and the agent's mark are laid over them and cut off
 * at the token's end. A token that names nothing stays as typed.
 */
function ThreadToken({ harness, id, raw }: { harness: string; id: string; raw: string }) {
  const thread = useThreads((state) => findThreadReference(state.threads, harness, id))
  if (!thread)
    return (
      <span className="ref-token" title={`${harness} conversation`}>
        <span className="ref-sigil">@</span>
        {raw.slice(1)}
      </span>
    )
  return (
    <span className="ref-token relative" title={thread.title}>
      <span className="text-transparent">{raw}</span>
      <span className="absolute inset-0 flex items-center gap-1 overflow-hidden whitespace-nowrap">
        <HarnessIcon harness={harness} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{thread.title}</span>
      </span>
    </span>
  )
}
