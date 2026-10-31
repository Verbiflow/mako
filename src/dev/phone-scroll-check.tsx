// Explicit isolated fixture for scrolling a phone's live Session; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applyLiveBatch, applyLiveSnapshot } from "@/state/live-recovery"
import { acpStore } from "@/state/acp"
import { threadsStore } from "@/state/thread-store"
import { store } from "@/state/session"
import type { LiveRequest, LiveSnapshot } from "@/lib/types"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { listedOwner, listedSummary } from "@mako/host/contracts/listed-conversations"
import { WebClient, WebClientContext } from "@/web-client/client"
import LiveSession from "@/web-client/live-session"
import { applyTheme } from "@/web-client/theme"
import type { WebSession } from "@/web-client/threads"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

/**
 * The phone's live Session (`LiveSession`: the desktop's transcript, the dock, the composer) holding a long
 * conversation, for `test-phone-scroll-ui.mjs`. `window.scrollCheck` drives what the host would: a turn that streams
 * its answer a few words a frame (`stream`), as the host's batches bring it, until `stop`. `?turns=` sets how many
 * turns come before it; `?theme=light` draws it light.
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")

const mock = installMockBridge()
const conversation = "dddddddd-4444-4444-8444-444444444444"
const cwd = "/fixture/payments"
const TURNS = Number(search.get("turns") ?? 40)

let seed = 11
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
  "The webhook handler acknowledges first and does its work after, so the provider never retries a slow answer.",
]

function paragraph(sentences: number) {
  return Array.from({ length: sentences }, () => pick(SENTENCES)).join(" ")
}

function answer(index: number) {
  const parts = [paragraph(2 + Math.floor(random() * 5))]
  if (index % 3 === 0) parts.push(["```ts", ...Array.from({ length: 4 + Math.floor(random() * 10) }, (_, line) => `const delay${line} = retryDelay(${line}, { cap: 6_400 })`), "```"].join("\n"))
  if (index % 4 === 1) parts.push(Array.from({ length: 3 + Math.floor(random() * 3) }, () => `- ${pick(SENTENCES)}`).join("\n"))
  parts.push(paragraph(1 + Math.floor(random() * 3)))
  return parts.join("\n\n")
}

const requestId = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
const requests: LiveRequest[] = []
const blocks: LiveSnapshot["blocks"] = []
for (let index = 0; index < TURNS; index += 1) {
  const id = requestId(index + 1)
  requests.push({ id, text: `Question ${index}: ${pick(SENTENCES)}`, attachments: [], status: "completed" })
  blocks.push({ type: "user", text: `Question ${index}: ${pick(SENTENCES)}`, requestId: id })
  if (index % 2 === 0) blocks.push({ type: "tool", id: `read-${index}`, toolKind: "read", title: `Read src/payments/retry-${index}.ts`, input: `{"path":"src/payments/retry-${index}.ts"}`, output: "export function retryDelay(attempt: number) {}", status: "completed" })
  blocks.push({ type: "text", text: answer(index) })
}
const live = requestId(TURNS + 1)
requests.push({ id: live, text: "Stream a long answer about the retry fix", attachments: [], status: "completed" })
blocks.push({ type: "user", text: "Stream a long answer about the retry fix", requestId: live })
blocks.push({ type: "text", id: "streaming", text: "Here is the whole story of the retry fix. " })

const snapshot: LiveSnapshot = {
  session: {
    id: conversation,
    harness: "codex",
    nativeId: "native-scroll",
    cwd,
    title: "Retry backoff on slow runners",
    connection: "connected",
    status: "running",
    modes: [{ id: "auto", name: "Auto", access: "ask" }],
    currentMode: "auto",
    configOptions: [],
    settings: { model: "gpt-5.5", options: { effort: "medium" } },
  },
  revision: 1,
  epoch: "phone-scroll",
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
applyLiveSnapshot(snapshot)
acpStore.set({ activeKey: conversation })

const listed: ListedSession = {
  session: "00000000-0000-4000-8000-0000000000a1",
  thread: "00000000-0000-4000-8000-0000000000a2",
  conversation,
  harness: "codex",
  state: "working",
  folder: cwd,
  createdAt: new Date(1).toISOString(),
  activityAt: new Date().toISOString(),
  generation: 1,
  runsOn: { kind: "device", deviceId: "00000000-0000-4000-8000-0000000000a3" },
  listedAt: new Date().toISOString(),
}
const session: WebSession = { row: listed, owner: listedOwner(listed), summary: listedSummary(listed, "Studio", undefined), where: "Studio", waiting: [] }
// A stand-in for the started client, without its constructor's gateway: this page opens none, and its conversation is
// already in the store. `LiveSession` asks it only for these.
const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-check" },
  gateway: { wake: () => undefined },
  conversations: async () => ({ open: () => () => undefined }),
})

let revision = snapshot.revision
let streaming: ReturnType<typeof setInterval> | undefined
let part = 0
const words = SENTENCES.join(" ").split(" ")

const check = {
  /** The turn's answer grows by `perBatch` words every `everyMs`, a paragraph each 40 words, as the host's batches do. */
  stream(everyMs = 50, perBatch = 3) {
    clearInterval(streaming)
    streaming = setInterval(() => {
      let text = ""
      for (let word = 0; word < perBatch; word += 1) {
        text += `${words[part % words.length]} `
        part += 1
        if (part % 40 === 0) text += `\n\nPart ${part / 40}. `
      }
      applyLiveBatch({ id: conversation, epoch: "phone-scroll", revision: ++revision, updates: [{ kind: "text", id: "streaming", text }] })
    }, everyMs)
  },
  stop() {
    clearInterval(streaming)
    streaming = undefined
  },
}
Reflect.set(window, "scrollCheck", check)

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <WebClientContext value={client}>
      <div className="web-app flex flex-col bg-surface text-foreground">
        <LiveSession session={session} />
      </div>
      <Toaster position="top-center" />
    </WebClientContext>
  </TooltipProvider>
)
