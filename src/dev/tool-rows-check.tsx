// Explicit isolated fixture for a turn's tool rows as they stream; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import { Composer } from "@/components/composer/composer"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applyLiveBatch, applyLiveSnapshot } from "@/state/live-recovery"
import { acpStore } from "@/state/acp"
import { threadsStore } from "@/state/thread-store"
import { store } from "@/state/session"
import type { LiveRequest, LiveSnapshot } from "@/lib/types"
import type { LiveUpdate } from "@mako/sessions/live-content"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { listedOwner, listedSummary } from "@mako/host/contracts/listed-conversations"
import { WebClient, WebClientContext } from "@/web-client/client"
import LiveSession from "@/web-client/live-session"
import { applyTheme } from "@/web-client/theme"
import { installBuiltins } from "@/desk/builtins"
import { listedFacts, type WebSession } from "@/web-client/threads"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import { wordsBlocks } from "./tool-words-fixture"

/**
 * A Cursor turn's file edits streaming as the host's batches bring them, for `test-tool-rows-ui.mjs`: each call opens
 * as "Editing", its path arrives, and it settles as "Edit" while the next one opens. `?surface=desk` draws it in the
 * Mac's conversation (`AcpPanel`), `?surface=phone` in the phone's live Session; `?turns=` sets how many turns of file
 * rows come before it (over 200 windows the transcript); `?theme=light` draws it light. `window.toolRows.stream`
 * plays the turn, `settle` ends it.
 */

const search = new URLSearchParams(location.search)
const surface = search.get("surface") === "phone" ? "phone" : "desk"
const theme = search.get("theme") === "light" ? "light" : "dark"
// `?rows=words` draws one turn of every tool of Mako's own server and the row facts (`tool-words-fixture.ts`) instead.
const words = search.get("rows") === "words"
const TURNS = Number(search.get("turns") ?? (words ? 0 : 12))
await (surface === "phone" ? import("../web-client/style.css") : import("../index.css"))
applyTheme(theme)

const mock = installMockBridge()
installBuiltins()
const conversation = "eeeeeeee-5555-4555-8555-555555555555"
const cwd = "/fixture/mako"
// Notes outside the conversation's folder read with their folder, as a sibling checkout's do.
const NOTES = "/srv/agents/thread-data/folder-0a1b2c3d/workers"
const FILES = [
  `${NOTES}/orch-design.md`,
  `${NOTES}/inline-preview.md`,
  `${cwd}/src/components/transcript/conversation-timeline.tsx`,
  `${cwd}/src/components/transcript/tool-row.tsx`,
  `${NOTES}/row-overlap.report.md`,
  `${cwd}/scripts/test-tool-rows-ui.mjs`,
]
const CALLS = [
  { name: "StrReplace", args: (path: string) => ({ path, old_string: "a", new_string: "b" }) },
  { name: "Write", args: (path: string) => ({ path, contents: "# Notes\n\nOne line.\n" }) },
  { name: "Read", args: (path: string) => ({ path }) },
]
const json = (args: Record<string, string>) => JSON.stringify(args, null, 2)

const requestId = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
const requests: LiveRequest[] = []
const blocks: LiveSnapshot["blocks"] = []
for (let index = 0; index < TURNS; index += 1) {
  const id = requestId(index + 1)
  requests.push({ id, text: `Update the notes, part ${index}`, attachments: [], status: "completed" })
  blocks.push({ type: "user", text: `Update the notes, part ${index}`, requestId: id })
  for (let call = 0; call < 3; call += 1) {
    const { name, args } = CALLS[(index + call) % CALLS.length]!
    const path = FILES[(index + call) % FILES.length]!
    blocks.push({ type: "tool", id: `call-${index}-${call}`, name, title: name, input: json(args(path)), output: "ok", status: "completed" })
  }
  blocks.push({ type: "text", text: `Part ${index} of the notes is up to date.` })
}
const live = requestId(TURNS + 1)
if (words) {
  requests.push({ id: live, text: "Start the Fins, open the PR and check the app", attachments: [], status: "completed" })
  blocks.push(...wordsBlocks(live))
} else {
  requests.push({ id: live, text: "Write the design notes, then the preview's", attachments: [], status: "completed" })
  blocks.push({ type: "user", text: "Write the design notes, then the preview's", requestId: live })
  blocks.push({ type: "text", id: "lead", text: "Writing both notes now, one after the other." })
}

const snapshot: LiveSnapshot = {
  session: {
    id: conversation,
    harness: "cursor",
    nativeId: "native-tool-rows",
    cwd,
    title: "Design notes for the preview task",
    connection: "connected",
    status: "running",
    modes: [{ id: "agent", name: "Agent", access: "ask" }],
    currentMode: "agent",
    configOptions: [],
    settings: { model: "claude-opus-5-5", options: {} },
  },
  revision: 1,
  epoch: "tool-rows",
  createdAt: 1,
  base: null,
  permissions: [],
  requests,
  blocks,
  control: { activeBindingId: conversation, bindings: [], merges: [], transfers: [], actions: [] },
}

threadsStore.set({ composerHarness: "cursor", descriptors: fixtureHarnesses })
store.set({ messages: [], stream: null })
mock.setLiveSnapshot(snapshot)
applyLiveSnapshot(snapshot)
acpStore.set({ activeKey: conversation })

let revision = snapshot.revision
const batch = (updates: LiveUpdate[]) => applyLiveBatch({ id: conversation, epoch: "tool-rows", revision: ++revision, updates })
let playing: ReturnType<typeof setTimeout> | undefined
let opened = 0

const check = {
  /**
   * Plays `calls` edits, one phase every `everyMs`: a call opens with no arguments ("Editing"), its arguments arrive
   * (its path), then it settles in the same batch that opens the next.
   */
  stream(calls = 8, everyMs = 120) {
    clearTimeout(playing)
    const phases: LiveUpdate[][] = []
    for (let index = 0; index < calls; index += 1) {
      const id = `live-${opened + index}`
      const { name, args } = CALLS[index % CALLS.length]!
      const path = FILES[index % FILES.length]!
      const open: LiveUpdate = { kind: "tool", id, title: name, name, status: "running" }
      const previous = index ? [{ kind: "tool-update", id: `live-${opened + index - 1}`, status: "completed", output: "ok" } satisfies LiveUpdate] : []
      phases.push([...previous, open], [{ kind: "tool-update", id, title: name, input: json(args(path)) }])
    }
    opened += calls
    const step = () => {
      const next = phases.shift()
      if (!next) {
        playing = undefined
        return
      }
      batch(next)
      playing = setTimeout(step, everyMs)
    }
    step()
  },
  get streaming() {
    return playing !== undefined
  },
  /** Settles the newest call and ends the turn's answer. */
  settle() {
    clearTimeout(playing)
    playing = undefined
    batch([
      { kind: "tool-update", id: `live-${opened - 1}`, status: "completed", output: "ok" },
      { kind: "text", id: "done", text: "Both notes are written." },
    ])
  },
}
Reflect.set(window, "toolRows", check)

const listed: ListedSession = {
  session: "00000000-0000-4000-8000-0000000000b1",
  thread: "00000000-0000-4000-8000-0000000000b2",
  conversation,
  harness: "cursor",
  state: "working",
  folder: cwd,
  createdAt: new Date(1).toISOString(),
  activityAt: new Date().toISOString(),
  generation: 1,
  runsOn: { kind: "device", deviceId: "00000000-0000-4000-8000-0000000000b3" },
  listedAt: new Date().toISOString(),
}
const session: WebSession = { row: listed, owner: listedOwner(listed), summary: listedSummary(listed, "Studio", undefined), where: "Studio", waiting: [], facts: listedFacts(listed, false) }
// A stand-in for the started client, without its constructor's gateway, as `phone-scroll-check.tsx` has it.
const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-check" },
  gateway: { wake: () => undefined },
  conversations: async () => ({ open: () => () => undefined }),
})

export function Desk(): ReactNode {
  return (
    <WorkspaceFocusContext value={{ identity: `live:${conversation}`, cwd, title: snapshot.session.title, ready: true }}>
      <main className="agent-surface relative isolate flex h-screen min-w-0 flex-col overflow-hidden bg-surface text-foreground">
        <AcpPanel />
        <Composer />
      </main>
    </WorkspaceFocusContext>
  )
}

export function Phone(): ReactNode {
  return (
    <WebClientContext value={client}>
      <div className="web-app flex flex-col bg-surface text-foreground">
        <LiveSession session={session} />
      </div>
    </WebClientContext>
  )
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {surface === "phone" ? <Phone /> : <Desk />}
    <Toaster position={surface === "phone" ? "top-center" : undefined} />
  </TooltipProvider>
)
