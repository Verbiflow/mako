import { memo } from "react"
import { BRIEF_CLOSE, type AgentWords } from "@mako/host/contracts/children"
import { ROLE_WORD } from "@mako/host/contracts/agents"
import { LeadMark } from "@/components/ui/lead-mark"
import { Prose } from "@/components/transcript/markdown"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { formatTime } from "@/lib/format"
import { useLeadTitle } from "@/state/lead-children"

/**
 * Words another Thread wrote into this one, where a prompt would stand: a
 * child's brief from its lead, or its lead's later word, the person's own
 * message its lead passed on, and the reports a lead hears from its Threads.
 * Read from their header, so live and saved draw the same card.
 */
export const AgentWordsCard = memo(function AgentWordsCard({ words, raw, timestamp }: { words: AgentWords; raw: string; timestamp?: number }) {
  const source = useTranscriptSource()
  const leadTitle = useLeadTitle(source.liveId, source.threadPath)
  const { from, body, passedOn } = words
  const name = from === `your ${ROLE_WORD}` ? (leadTitle ?? `its ${ROLE_WORD}`) : from === "your agents" ? "its Threads" : from
  const kind = passedOn ? "Passed on" : from === "your agents" ? "Reports" : raw.includes(BRIEF_CLOSE) ? "Brief" : "Message"
  return (
    <div data-agent-words={kind} className="rounded-lg bg-shell/55 px-4 py-3 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
      <div className="flex items-center gap-2 text-label text-faint">
        <LeadMark className="size-3.5" />
        <span className="font-medium text-muted-foreground">{passedOn ? `Your message, passed on by ${name}` : `From ${name}`}</span>
        {passedOn ? null : <span>· {kind}</span>}
        {timestamp ? (
          <time dateTime={new Date(timestamp).toISOString()} className="tabular ml-auto">
            {formatTime(timestamp)}
          </time>
        ) : null}
      </div>
      <Prose text={body} className="mt-1.5 prompt-prose whitespace-normal" />
      {passedOn?.added ? (
        <div data-passed-on-added className="mt-2.5 border-t border-hairline pt-2">
          <p className="text-label text-faint">{name} added</p>
          <Prose text={passedOn.added} className="mt-1 prompt-prose whitespace-normal text-muted-foreground" />
        </div>
      ) : null}
    </div>
  )
})
