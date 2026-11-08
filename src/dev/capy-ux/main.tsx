// Prototype of the proposed navigation (orchestration/capy-ux.md); never imported by the application.
import { useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import "../../index.css"
import "./capy-ux.css"
import type { ChildState } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { useAcp } from "@/state/acp-state"
import { threadsStore } from "@/state/thread-store"
import { fixtureHarnesses } from "../harness-fixtures"
import { installMockBridge } from "../mock-bridge"
import { apexSnapshots, APEX_CONVERSATION } from "../mock-apex-thread"
import { asksOf, crewRollup, finsOf, FIXTURE_FINS, type Fin, type MarkState } from "./data"
import { LiveMark, Pips, CrewBar } from "./marks"
import { markWord } from "./mark-word"
import { Sidebar, type Place } from "./sidebar"
import { ApexView, FinView, InboxView, TabStrip } from "./thread-view"
import { PhoneApex, PhoneList } from "./phone"

const search = new URLSearchParams(location.search)
document.documentElement.classList.toggle("light", search.get("theme") === "light")
document.documentElement.classList.toggle("dark", search.get("theme") !== "light")
if (search.has("still")) document.documentElement.dataset.still = ""

installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })
for (const snapshot of apexSnapshots()) applyLiveSnapshot(snapshot)

/** What answering a Fin's ask does to it here: it goes back to work, as a real one does once its ask is answered. */
function answered(agent: NativeAgent): NativeAgent {
  const state: ChildState = { kind: "working", step: "Read the answer" }
  return { ...agent, state: { kind: "working", activity: "Read the answer" }, child: agent.child && { ...agent.child, state } }
}

function useCrew() {
  const roster = useAcp((state) => {
    const conversation = state.conversations[APEX_CONVERSATION]
    return conversation && "nativeAgents" in conversation ? conversation.nativeAgents?.agents : undefined
  })
  const [done, setDone] = useState<ReadonlySet<string>>(new Set())
  const agents = useMemo(() => (roster ?? FIXTURE_FINS).map((agent) => (done.has(agent.nativeId) ? answered(agent) : agent)), [roster, done])
  const fins = useMemo(() => finsOf(agents), [agents])
  const counts = useMemo(() => crewRollup(agents), [agents])
  const answer = (fin: Fin) => setDone((current) => new Set([...current, fin.agent.nativeId]))
  return { fins, counts, answer }
}

function initialPlace(fins: Fin[]): Place {
  const screen = search.get("screen")
  if (screen === "inbox") return { kind: "inbox" }
  if (screen === "fin") return { kind: "fin", id: fins.find((fin) => fin.name === "sheet-motion")!.agent.nativeId }
  return { kind: "thread", id: "mobile-polish" }
}

export function Desk() {
  const { fins, counts, answer } = useCrew()
  const [place, setPlace] = useState<Place>(() => initialPlace(fins))
  const asks = asksOf(fins)
  const fin = place.kind === "fin" ? fins.find((candidate) => candidate.agent.nativeId === place.id) : undefined
  const openFin = (target: Fin) => setPlace({ kind: "fin", id: target.agent.nativeId })
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-shell font-sans text-foreground antialiased">
      <Sidebar place={place} fins={fins} counts={counts} asks={asks.length} onPlace={setPlace} />
      <main className="flex min-w-0 flex-1 flex-col">
        <TabStrip place={place} fins={fins} onPlace={setPlace} />
        {place.kind === "inbox" ? (
          <InboxView asks={asks} fins={fins} onAnswer={answer} onOpenFin={openFin} />
        ) : fin ? (
          <FinView fin={fin} onBack={() => setPlace({ kind: "thread", id: "mobile-polish" })} onAnswer={answer} />
        ) : (
          <ApexView fins={fins} counts={counts} onAnswer={answer} onOpenFin={openFin} />
        )}
      </main>
    </div>
  )
}

export function Phone() {
  const { fins, counts, answer } = useCrew()
  const [screen, setScreen] = useState(search.get("screen") === "apex" ? "apex" : "list")
  return (
    <div className="h-screen w-screen overflow-hidden font-sans text-foreground antialiased">
      {screen === "apex" ? (
        <PhoneApex fins={fins} counts={counts} onBack={() => setScreen("list")} onAnswer={answer} />
      ) : (
        <PhoneList fins={fins} counts={counts} asks={asksOf(fins).length} onOpenApex={() => setScreen("apex")} />
      )}
    </div>
  )
}

const STATES: { state: MarkState; harness: string; note: string }[] = [
  { state: "working", harness: "claude", note: "A comet runs round the agent's mark; its tail breathes. Ember on the one Thread you're in." },
  { state: "background", harness: "grok", note: "The same comet at half speed, quieter: the turn ended, a watcher or its Fins still run." },
  { state: "starting", harness: "devin", note: "The ring draws itself in while a machine boots." },
  { state: "needs", harness: "cursor", note: "A caution ring breathes every 2.4 s: waiting on you." },
  { state: "lead", harness: "grok", note: "A dotted ring drifts: a Fin asking its Apex, not you." },
  { state: "queued", harness: "opencode", note: "Dashed and still, the mark dimmed: waiting its turn." },
  { state: "failed", harness: "codex", note: "A red dot where the ring would be." },
  { state: "unread", harness: "codex", note: "A dot in the text colour: an answer you haven't read." },
  { state: "done", harness: "claude", note: "The mark alone." },
]

export function Legend() {
  const { fins, counts } = useCrew()
  return (
    <div className="min-h-screen bg-surface p-10 font-sans text-foreground antialiased">
      <h1 className="text-title font-semibold">One live mark: who, and how it's going</h1>
      <p className="mt-1 text-ui text-muted-foreground">Every Thread and Fin wears the same mark in the sidebar, the tabs, the crew and the Inbox.</p>
      <div className="mt-8 grid grid-cols-2 gap-x-10 gap-y-6">
        {STATES.map(({ state, harness, note }) => (
          <div key={state} className="flex items-center gap-5">
            <span className="flex size-14 items-center justify-center bg-shell">
              <LiveMark harness={harness} state={state} lit={state === "working"} className="scale-[2]" />
            </span>
            <span className="flex flex-col">
              <span className="text-ui font-medium">{markWord(state)}</span>
              <span className="text-label text-muted-foreground">{note}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="mt-10 flex items-center gap-6 bg-shell p-5">
        <span className="flex flex-col gap-2">
          <span className="text-ui font-medium">An Apex's crew</span>
          <span className="text-label text-muted-foreground">One pip per Fin, needs-you first; the working ones pulse in a wave.</span>
        </span>
        <Pips fins={fins} className="scale-[2] origin-left" />
        <span className="w-24" />
        <CrewBar counts={counts} className="w-56" />
      </div>
    </div>
  )
}

const form = search.get("form")
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>{form === "phone" ? <Phone /> : search.get("screen") === "states" ? <Legend /> : <Desk />}</TooltipProvider>
)
