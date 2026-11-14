/* eslint-disable react-refresh/only-export-components -- This isolated acceptance entry is never imported by the application. */
// Explicit isolated fixture for opening a phone's live Session; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import { createHook, createStore } from "@/state/store"
import { TooltipProvider } from "@/components/ui/tooltip"
import { landTranscriptsAtEnd } from "@/components/transcript/transcript-end"
import { acp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { applyLiveSnapshot, hydrateLive, listLive, unloadLive } from "@/state/live-recovery"
import { threadsStore } from "@/state/thread-store"
import { store } from "@/state/session"
import type { LiveRequest, LiveSnapshot } from "@/lib/types"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { listedOwner, listedSummary } from "@mako/host/contracts/listed-conversations"
import { WebClient, WebClientContext } from "@/web-client/client"
import LiveSession from "@/web-client/live-session"
import { readingsStore } from "@/web-client/probe"
import { syncingStore } from "@/web-client/syncing"
import { applyTheme } from "@/web-client/theme"
import { listedFacts, type WebSession } from "@/web-client/threads"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

/**
 * Opening a phone's live Session (`LiveSession`) on a long finished conversation, for `test-phone-open-ui.mjs`: the
 * Open button mounts it as a Thread's screen does, opened as `WebConversations.open` opens one (listed, made active,
 * read from its owner). `window.openCheck.forget()` lets the transcript go, as a reload does, so the next open reads
 * it from its owner, whose answer takes `?answer=` ms (default 300); otherwise the next open paints what's held.
 * `?turns=` sets how many turns it has; `?theme=light` draws it light; `?form=desk` draws it as a laptop's browser
 * does, with the desktop's own composer; `?machine` has it run on a machine of the person's own rather than a Mac.
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")

const mock = installMockBridge()
const conversation = "eeeeeeee-5555-4555-8555-555555555555"
const cwd = "/fixture/payments"
const TURNS = Number(search.get("turns") ?? 40)
const ANSWER_MS = Number(search.get("answer") ?? 300)
const DESK = search.get("form") === "desk"
const WHERE = search.has("machine") ? "build-box" : "Studio"

let seed = 7
const random = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}
const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!

const SENTENCES = [
  "The retry backoff doubles from 200 ms and stops at 6.4 s, so a slow runner gets six tries before the job fails.",
  "Jitter keeps two runners from retrying in step, which is what made the queue spike every few minutes.",
  "A failed charge is kept with its last error, so the dashboard can say why it stopped.",
  "The worker reads its attempts from the queue's config instead of a constant baked into the build.",
  "Every case passes now, including the one that used to time out on the slow runner.",
]

function paragraph(sentences: number) {
  return Array.from({ length: sentences }, () => pick(SENTENCES)).join(" ")
}

function answer(index: number, newest: boolean) {
  const parts = [paragraph(2 + Math.floor(random() * 5))]
  if (index % 3 === 0 || newest) parts.push(["```ts", ...Array.from({ length: 4 + Math.floor(random() * 10) }, (_, line) => `const delay${line} = retryDelay(${line}, { cap: 6_400 })`), "```"].join("\n"))
  if (index % 4 === 1 || newest) parts.push(Array.from({ length: 3 + Math.floor(random() * 3) }, () => `- ${pick(SENTENCES)}`).join("\n"))
  parts.push(paragraph(1 + Math.floor(random() * 3)))
  if (newest) parts.push("That is the whole of the retry fix.")
  return parts.join("\n\n")
}

const requestId = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
const requests: LiveRequest[] = []
const blocks: LiveSnapshot["blocks"] = []
for (let index = 0; index < TURNS; index += 1) {
  const id = requestId(index + 1)
  const text = `Question ${index}: ${pick(SENTENCES)}`
  requests.push({ id, text, attachments: [], status: "completed" })
  blocks.push({ type: "user", text, requestId: id })
  if (index % 2 === 0) blocks.push({ type: "tool", id: `read-${index}`, toolKind: "read", title: `Read src/payments/retry-${index}.ts`, input: `{"path":"src/payments/retry-${index}.ts"}`, output: "export function retryDelay(attempt: number) {}", status: "completed" })
  blocks.push({ type: "text", text: answer(index, index === TURNS - 1) })
}

const snapshot: LiveSnapshot = {
  session: {
    id: conversation,
    harness: "codex",
    nativeId: "native-open",
    cwd,
    title: "Retry backoff on slow runners",
    connection: "connected",
    status: "ready",
    modes: [{ id: "auto", name: "Auto", access: "ask" }],
    currentMode: "auto",
    configOptions: [],
    settings: { model: "gpt-5.5", options: { effort: "medium" } },
  },
  revision: 1,
  epoch: "phone-open",
  createdAt: 1,
  base: null,
  permissions: [],
  requests,
  blocks,
  control: { activeBindingId: conversation, bindings: [], merges: [], transfers: [], actions: [] },
}

threadsStore.set({ composerHarness: "codex", descriptors: fixtureHarnesses })
store.set({ messages: [], stream: null })
mock.setLiveSnapshot(snapshot)
const answered = window.mako!.liveSnapshot
// The owner's answer, over the network.
window.mako!.liveSnapshot = async (id) => {
  await new Promise((resolve) => setTimeout(resolve, ANSWER_MS))
  return answered(id)
}

const listed: ListedSession = {
  session: "00000000-0000-4000-8000-0000000000b1",
  thread: "00000000-0000-4000-8000-0000000000b2",
  conversation,
  harness: "codex",
  state: "idle",
  folder: cwd,
  createdAt: new Date(1).toISOString(),
  activityAt: new Date().toISOString(),
  generation: 1,
  runsOn: { kind: "device", deviceId: "00000000-0000-4000-8000-0000000000b3" },
  listedAt: new Date().toISOString(),
}
const session: WebSession = { row: listed, owner: listedOwner(listed), summary: listedSummary(listed, WHERE, undefined), where: WHERE, waiting: [], facts: listedFacts(listed, false) }
// A stand-in for the started client, without its constructor's gateway: its conversations open as the browser's do.
const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-check" },
  gateway: { wake: () => undefined },
  conversations: async () => ({
    open: () => {
      listLive([session.summary])
      acp.activate(conversation, false)
      // Read from its owner, "Syncing…" meanwhile, as `WebConversations.open` reads it.
      syncingStore.set({ conversation })
      void hydrateLive(conversation).finally(() => syncingStore.set({ conversation: undefined }))
      return () => {
        if (acpStore.get().activeKey === conversation) acp.deactivate()
      }
    },
  }),
})

const screenStore = createStore({ open: false })
const useScreen = createHook(screenStore)
const check = {
  close: () => screenStore.set({ open: false }),
  /** The transcript let go, as a reload leaves it: the next open reads it from its owner. */
  forget: () => unloadLive(conversation),
  /** Held from the start, as a Thread already read is. */
  hold: () => applyLiveSnapshot(snapshot),
  readings: () => readingsStore.get().readings.filter((reading) => reading.name === "web.thread-open").map((reading) => reading.props),
}
Reflect.set(window, "openCheck", check)

function Screen() {
  const open = useScreen((state) => state.open)
  if (!open)
    return (
      <button
        type="button"
        data-open-thread
        className="m-6 border border-hairline px-4 py-3 text-left"
        onClick={() => {
          screenStore.set({ open: true })
          // As the app does: a Thread opened again lands on its newest message.
          requestAnimationFrame(() => landTranscriptsAtEnd())
        }}
      >
        Retry backoff on slow runners
      </button>
    )
  return <LiveSession session={session} desk={DESK} />
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <WebClientContext value={client}>
      <div className="web-app flex flex-col bg-surface text-foreground">
        <Screen />
      </div>
    </WebClientContext>
  </TooltipProvider>
)
