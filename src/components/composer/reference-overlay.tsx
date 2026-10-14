import { memo, useEffect } from "react"
import type { Attachment } from "@/lib/attachments"
import { draftPieces } from "@/lib/draft-view"
import { draftSkillDelivery, isSkillName, skillChipTitle } from "@/lib/skill-references"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useSession } from "@/state/session"
import { skills, useSkills } from "@/state/skills"
import { useThreads } from "@/state/threads"
import { ContextGlyph } from "./context-glyph"

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
 * conversation is its label (`draftView`), its agent's mark over the `@`.
 * A `$skill` says how it will reach the provider with nothing that takes
 * width: a dotted underline for one the provider lacks and will be handed,
 * a dashed edge for one nothing has installed.
 */
export const ReferenceOverlay = memo(function ReferenceOverlay({
  text,
  attachments,
  labels,
}: {
  /** The draft, with its conversation tokens and records' anchors. */
  text: string
  attachments: Attachment[]
  /** The label the textarea shows for each chip (`draftView`). */
  labels: ReadonlyMap<string, string>
}) {
  const segments = draftPieces(text)
  const records = new Map(attachments.map((item) => [item.id, item]))

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
        if (segment.kind === "context") {
          const record = records.get(segment.id)
          const label = labels.get(segment.raw)
          // An anchor whose record is gone reads as nothing worth a chip.
          if (!record || label === undefined)
            return (
              <span aria-hidden key={index} className="text-faint">
                {segment.raw}
              </span>
            )
          return (
            <span
              key={index}
              data-context-chip={record.detail?.kind ?? "file"}
              data-pending={record.pending || undefined}
              data-error={record.error ? "" : undefined}
              className="ref-token"
            >
              <ChipMark>
                <ContextGlyph detail={record.detail?.kind} origin={record.origin} mimeType={record.mimeType} className="size-3.5" />
              </ChipMark>
              {label.slice(1)}
            </span>
          )
        }
        if (segment.kind === "text")
          return (
            <span aria-hidden key={index}>
              {segment.text}
            </span>
          )
        if (segment.kind === "file") {
          // A folder (`@src/lib/`) reads by its own name, slash and all.
          const slash = segment.path.slice(0, -1).lastIndexOf("/") + 1
          return (
            <span key={index} className="ref-token" title={segment.path}>
              <span className="ref-sigil">@</span>
              <span className="text-muted-foreground">{segment.path.slice(0, slash)}</span>
              {segment.path.slice(slash)}
            </span>
          )
        }
        if (segment.kind === "thread")
          return <ThreadToken key={index} harness={segment.harness} raw={segment.raw} label={labels.get(segment.raw)} />
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
          // A `/word` no skill answers to is a word: `/tmp` in a sentence
          // stays prose, and only the `$` spelling keeps its missing mark.
          if (segment.raw.startsWith("/") && delivery?.kind !== "native" && delivery?.kind !== "handover")
            return (
              <span aria-hidden key={index}>
                {segment.raw}
              </span>
            )
          return (
            <span
              key={index}
              data-skill-delivery={delivery?.kind}
              title={skillChipTitle(segment.name, delivery)}
              className="ref-token"
            >
              <span className="ref-sigil">{segment.raw.slice(0, 1)}</span>
              <span
                className={
                  delivery?.kind === "handover"
                    ? "underline decoration-dotted decoration-muted-foreground underline-offset-[3px]"
                    : undefined
                }
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
 * A conversation reads as its label, the characters the textarea holds in
 * place of the token, with the agent's mark over the `@`. A token that names
 * no conversation the catalog knows (yet) stays as typed.
 */
function ThreadToken({ harness, raw, label }: { harness: string; raw: string; label: string | undefined }) {
  if (label === undefined)
    return (
      <span className="ref-token" title={`${harness} conversation`}>
        <span className="ref-sigil">@</span>
        {raw.slice(1)}
      </span>
    )
  return (
    <span className="ref-token">
      <ChipMark>
        <HarnessIcon harness={harness} className="size-3.5" />
      </ChipMark>
      {label.slice(1)}
    </span>
  )
}

/**
 * A chip's mark, over the `@` its label starts with, so it takes no width
 * the textarea's characters don't. It is placed against the `@` alone: a
 * label that wraps makes its chip two lines tall, and centred on that the
 * mark fell between them.
 */
function ChipMark({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative">
      <span className="text-transparent">@</span>
      <span className="absolute top-1/2 left-0 flex -translate-y-1/2">{children}</span>
    </span>
  )
}
