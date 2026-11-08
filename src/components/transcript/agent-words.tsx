import { memo } from "react"
import { isBrief, YOUR_APEX, YOUR_FINS, type AgentWords } from "@mako/host/contracts/children"
import { APEX_WORD, FIN_WORD } from "@mako/host/contracts/agents"
import { AgentAvatar } from "@/components/transcript/message-avatar"
import { FinReports } from "@/components/transcript/fin-report"
import { Prose } from "@/components/transcript/markdown"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { formatTime } from "@/lib/format"
import { useApexHarness, useApexTitle, useThreadChildren } from "@/state/apex-fins"
import { useAcp } from "@/state/acp"

/**
 * Words another Thread wrote into this one, where a prompt would stand: a
 * Fin's brief from its Apex, or its Apex's later word, the person's own
 * message its Apex passed on, and the reports an Apex hears from its Fins,
 * which draw as their Fins' own messages (`FinReports`) when the wake carries
 * them as data. Read from their header, so live and saved draw the same card.
 */
export const AgentWordsCard = memo(function AgentWordsCard({ words, raw, timestamp }: { words: AgentWords; raw: string; timestamp?: number }) {
  const source = useTranscriptSource()
  const apexTitle = useApexTitle(source.liveId, source.threadPath)
  const apexHarness = useApexHarness(source.liveId, source.threadPath)
  const { from, body, passedOn } = words
  const fin = useFinHarness(source.liveId, from === YOUR_APEX || from === YOUR_FINS ? undefined : from)
  const harness = from === YOUR_APEX ? apexHarness : fin
  const name = from === YOUR_APEX ? (apexTitle ?? `its ${APEX_WORD}`) : from === YOUR_FINS ? `its ${FIN_WORD}s` : from
  const kind = passedOn ? "Passed on" : from === YOUR_FINS ? "Reports" : isBrief(raw) ? "Brief" : "Message"
  // A wake's reports are the Fins' own messages; the words around them are the Apex's to read, not the person's.
  if (words.reports?.length) return <FinReports reports={words.reports} timestamp={timestamp} />
  return (
    <div data-agent-words={kind} className="bg-shell/55 px-4 py-3 [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
      <div className="flex items-center gap-2 text-label text-faint">
        <AgentAvatar harness={harness} kind={from === YOUR_APEX ? "thread" : "fin"} label={name} className="bg-surface" />
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

/** The harness of the Fin of this Thread named `name`, for its avatar on what it wrote. */
function useFinHarness(liveId: string | undefined, name: string | undefined): string | undefined {
  const thread = useAcp((state) => (liveId ? state.conversations[liveId]?.threadId : undefined))
  const children = useThreadChildren(name ? thread : undefined)
  return name ? children.find((agent) => agent.title === name || agent.child?.name === name)?.provider : undefined
}
