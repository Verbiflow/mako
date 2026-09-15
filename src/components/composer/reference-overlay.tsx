import { memo, useEffect } from "react"
import { tokenize } from "@/lib/mentions"
import { attachmentRanges } from "@/lib/attachment-references"
import type { Attachment } from "@/lib/attachments"
import {
  MISSING_SKILL_CHIP_CLASS,
  draftSkillDelivery,
  isSkillName,
  skillChipTitle,
} from "@/lib/skill-references"
import { cn } from "@/lib/utils"
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
 * That is why a `$skill` here says how it will reach the provider with
 * nothing that takes width: a skill the provider lacks and will be handed
 * wears a dotted underline, one nothing has installed wears a dashed edge and
 * quieter ink. The transcript chip, free of the textarea, adds the mark.
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
          return (
            <InlineAttachment
              key={index}
              item={segment.item}
              reference={segment.raw}
            />
          )
        if (segment.kind === "text")
          return (
            <span aria-hidden key={index}>
              {segment.text}
            </span>
          )
        if (segment.kind === "file" || segment.kind === "thread") {
          return (
            <span
              key={index}
              // Sized to the glyphs it replaces so wrapping stays identical:
              // the chip is a background, not a differently-shaped box.
              className="rounded-[3px] bg-raised text-foreground ring-1 ring-hairline ring-inset"
              title={
                segment.kind === "file"
                  ? segment.path
                  : `${segment.harness} conversation`
              }
            >
              {segment.raw}
            </span>
          )
        }
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
              className={cn(
                "rounded-[3px] text-foreground",
                delivery?.kind === "missing"
                  ? MISSING_SKILL_CHIP_CLASS
                  : "bg-fill-selected ring-1 ring-border ring-inset",
                delivery?.kind === "handover" &&
                  "underline decoration-dotted decoration-muted-foreground underline-offset-[3px]"
              )}
            >
              {segment.raw}
            </span>
          )
        }
        return (
          <span
            key={index}
            className="rounded-[3px] bg-fill-selected text-foreground ring-1 ring-border ring-inset"
          >
            {segment.raw}
          </span>
        )
      })}
      {/* A trailing newline keeps the last line's height when the draft ends
          with a break, matching how the textarea measures itself. */}
      {text.endsWith("\n") ? <span>{"​"}</span> : null}
    </div>
  )
})
