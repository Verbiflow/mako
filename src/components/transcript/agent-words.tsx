import { memo } from "react"
import { isBrief, YOUR_APEX, YOUR_FINS, type AgentWords } from "@mako/host/contracts/children"
import { APEX_WORD, FIN_WORD } from "@mako/host/contracts/agents"
import { ApexMark } from "@/components/ui/apex-mark"
import { Prose } from "@/components/transcript/markdown"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { formatTime } from "@/lib/format"
import { useApexTitle } from "@/state/apex-fins"

/**
 * Words another Thread wrote into this one, where a prompt would stand: a
 * Fin's brief from its Apex, or its Apex's later word, the person's own
 * message its Apex passed on, and the reports an Apex hears from its Fins.
 * Read from their header, so live and saved draw the same card.
 */
export const AgentWordsCard = memo(function AgentWordsCard({ words, raw, timestamp }: { words: AgentWords; raw: string; timestamp?: number }) {
  const source = useTranscriptSource()
  const apexTitle = useApexTitle(source.liveId, source.threadPath)
  const { from, body, passedOn } = words
  const name = from === YOUR_APEX ? (apexTitle ?? `its ${APEX_WORD}`) : from === YOUR_FINS ? `its ${FIN_WORD}s` : from
  const kind = passedOn ? "Passed on" : from === YOUR_FINS ? "Reports" : isBrief(raw) ? "Brief" : "Message"
  return (
    <div data-agent-words={kind} className="rounded-lg bg-shell/55 px-4 py-3 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
      <div className="flex items-center gap-2 text-label text-faint">
        <ApexMark className="size-3.5" />
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
