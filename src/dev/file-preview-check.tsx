/* eslint-disable react-refresh/only-export-components -- This isolated acceptance entry exposes controlled fixture inputs and receipts. */
import { z } from "zod"
// Explicit browser acceptance fixture. No native agent is started.
import { createRoot } from "react-dom/client"
import { createElement, useState, useEffect } from "react"
import { installMockBridge } from "./mock-bridge"
import { fixtureHarnesses } from "./harness-fixtures"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { Composer } from "@/components/composer/composer"
import { ProviderAccounts } from "@/components/settings/provider-accounts"
import { NativeAuthoringSection } from "@/components/settings/native-authoring-section"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { bindTheme, prefsStore } from "@/state/prefs"
import { accountsStore } from "@/state/accounts"
import { threadsStore } from "@/state/thread-store"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { acpStore } from "@/state/acp-state"
import type { Exchange } from "@/lib/exchanges"
import type { FileContents, LiveSnapshot } from "@/lib/types"
import {
  filePreviewFormat,
  diagnosticFormat,
} from "../../electron/contracts/file-preview"
import "../index.css"

bindTheme()
export function fixtureTheme(theme: "light" | "dark") { prefsStore.set({ theme }) }
let setReply: ((text: string) => void) | undefined
export function fixtureReply(text: string) { setReply?.(text) }
let setPrompt: ((prompt: Exchange["prompt"]) => void) | undefined
export function fixturePrompt(prompt: Exchange["prompt"]) { setPrompt?.(prompt) }
const mock = installMockBridge()
const authoringBridge = window.mako!
const authored = new Map<string, { contents: string; revision: string }>([["claude:commands:review", { contents: "---\ndescription: Review the current diff\n---\nReview $ARGUMENTS and explain the important risks.\n", revision: "1".repeat(64) }]])
authoringBridge.nativeAuthoringCatalog = async () => ({ cwd: "/fixture", capabilities: fixtureHarnesses.flatMap((harness) => (["commands", "hooks"] as const).map((family) => ({ provider: harness.provider, label: harness.displayName, family, supported: family === "commands" && (harness.provider === "claude" || harness.provider === "opencode") || family === "hooks" && harness.provider === "claude", detail: "Controlled acceptance fixture. Native syntax is preserved; changes are discovered by a new connection." }))) })
authoringBridge.listNativeAuthoring = async (target) => target.family === "hooks" ? [{ id: "configuration", name: "Hook configuration" }] : [...authored.keys()].filter((key) => key.startsWith(`${target.provider}:${target.family}:`)).map((key) => ({ id: key.split(":")[2], name: `/${key.split(":")[2]}` }))
authoringBridge.readNativeAuthoring = async (target, id) => { const entry = authored.get(`${target.provider}:${target.family}:${id}`); return { id, name: id, path: `/fixture/.${target.provider}/${target.family}/${id}.md`, contents: entry?.contents ?? (target.family === "hooks" ? "{}" : ""), revision: entry?.revision ?? null } }
authoringBridge.writeNativeAuthoring = async (value) => { const key = `${value.provider}:${value.family}:${value.id}`; if ((authored.get(key)?.revision ?? null) !== value.revision) throw new Error("This file changed after opening. Reload it before saving."); authored.set(key, { contents: value.contents, revision: crypto.randomUUID().replaceAll("-", "").repeat(2) }); return authoringBridge.readNativeAuthoring(value, value.id) }
authoringBridge.removeNativeAuthoring = async (value) => { const key = `${value.provider}:${value.family}:${value.id}`; if (authored.get(key)?.revision !== value.revision) throw new Error("This file changed after opening. Reload it before removing."); authored.delete(key) }
export function fixtureExternalCommandEdit() { authored.set("claude:commands:review", { contents: "Externally updated instructions.", revision: "e".repeat(64) }) }
const files = new Map<string, FileContents>()
export function fixtureFile(file: FileContents) {
  files.set(file.path, file)
}
function textFile(path: string, contents: string) {
  fixtureFile({
    path,
    contents,
    binary: false,
    truncated: false,
    size: new TextEncoder().encode(contents).length,
    diagnostic: diagnosticFormat(path),
    previewUrl: URL.createObjectURL(
      new Blob([contents], { type: "application/json" })
    ),
  })
}
textFile(
  "/fixture/guide.md",
  "# Previewing your files\n\nKeep the conversation in view while inspecting output.\n\n- **Markdown** retains formatting\n- Media stays playable\n- Diagnostics run off the rendering thread\n\n| Format | View |\n| --- | --- |\n| HAR | Requests |\n| CPU profile | Sampled functions |"
)
textFile(
  "/fixture/report.html",
  '<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui;padding:24px;background:var(--surface);color:var(--foreground)}h1{font-size:24px}.card{padding:20px;border:1px solid var(--border);border-radius:12px}button{padding:8px 14px;border-radius:6px}</style></head><body><h1>Build report</h1><div class="card"><p>Inline HTML preview</p><p>3 checks passed · 0 failures</p><button onclick="this.textContent=\'Interaction works\'">Try interaction</button></div></body></html>'
)
textFile(
  "/fixture/requests.har",
  JSON.stringify({
    log: {
      entries: Array.from({ length: 120 }, (_, i) => ({
        startedDateTime: new Date(1_759_400_000_000 + i * 5).toISOString(),
        time: 12 + (i % 9) * 20,
        request: {
          method: i % 7 ? "GET" : "POST",
          url: `https://example.test/${i % 4 ? "assets/bundle.js" : "api/projects"}?private=hidden`,
        },
        response: {
          status: i % 11 ? 200 : 500,
          content: { size: 1024 + i * 8 },
        },
      })),
    },
  })
)
textFile(
  "/fixture/render.cpuprofile",
  JSON.stringify({
    startTime: 0,
    endTime: 300000,
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "renderTranscript",
          url: "timeline.tsx",
          lineNumber: 80,
        },
      },
      {
        id: 2,
        callFrame: {
          functionName: "parseMarkdown",
          url: "markdown.ts",
          lineNumber: 20,
        },
      },
    ],
    samples: [1, 2, 1],
    timeDeltas: [100000, 50000, 150000],
  })
)
textFile(
  "/fixture/memory.heapsnapshot",
  JSON.stringify({
    snapshot: {
      node_count: 3,
      edge_count: 0,
      meta: { node_fields: ["type", "name", "self_size"] },
    },
    nodes: [0, 0, 1024, 0, 1, 2048, 0, 0, 4096],
    strings: ["Transcript cache", "Preview worker"],
  })
)
textFile(
  "/fixture/allocation.heapprofile",
  JSON.stringify({
    head: {
      callFrame: { functionName: "loadPreview", url: "preview.ts" },
      selfSize: 4096,
      children: [],
    },
  })
)
textFile(
  "/fixture/main.trace.json",
  JSON.stringify({
    traceEvents: [
      { ph: "X", name: "Layout", cat: "renderer", ts: 0, dur: 24000 },
      { ph: "X", name: "Paint", cat: "renderer", ts: 24000, dur: 8000 },
      { ph: "M" },
    ],
  })
)
textFile("/fixture/malformed.har", "{ invalid diagnostic")
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" rx="24" fill="#282828"/><text x="40" y="150" fill="#eee" font-family="system-ui" font-size="32">Native image asset</text><text x="40" y="195" fill="#aaa" font-family="system-ui" font-size="18">Extensionless source · detected by the host</text></svg>'
fixtureFile({
  path: "/fixture/native-image",
  contents: "",
  binary: true,
  media: "image",
  mimeType: "image/svg+xml",
  previewUrl: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })),
  size: svg.length,
  truncated: false,
})
// Only this explicit fixture persists its bounded file samples; product drafts
// continue storing authorised staged paths rather than base64 or blob URLs.
const fixtureAssets = z
  .array(
    z.object({
      path: z.string(),
      mime: z.string(),
      media: z.enum(["image", "video", "audio", "pdf"]).optional(),
      data: z.string().max(1_000_000),
    })
  )
  .max(8)
try {
  const stored: unknown = JSON.parse(
    sessionStorage.getItem("shared-preview-fixture-assets") ?? "[]"
  )
  for (const input of fixtureAssets.parse(stored)) {
    const bytes = Uint8Array.from(atob(input.data), (value) =>
      value.charCodeAt(0)
    )
    fixtureFile({
      path: input.path,
      contents: "",
      binary: true,
      media: input.media,
      mimeType: input.mime,
      size: bytes.length,
      truncated: false,
      previewUrl: URL.createObjectURL(new Blob([bytes], { type: input.mime })),
    })
  }
} catch {
  sessionStorage.removeItem("shared-preview-fixture-assets")
}
export const previewReadEvidence: {
  kind: string
  owner: string
  path: string
}[] = []
const owners = new Map<string, FileContents>()
export function fixtureOwnedFile(
  kind: "live" | "thread",
  owner: string,
  path: string,
  file: FileContents
) {
  owners.set(JSON.stringify([kind, owner, path]), file)
}
const read = async (path: string) => {
  const file = files.get(path)
  if (!file) throw new Error("The fixture file is unavailable")
  return { ...file }
}
const readOwned = async (
  kind: "live" | "thread",
  owner: string,
  path: string
) => {
  previewReadEvidence.push({ kind, owner, path })
  if (previewReadEvidence.length > 100) previewReadEvidence.shift()
  const file = owners.get(JSON.stringify([kind, owner, path]))
  if (file) return { ...file }
  if (kind === "live" && owner === "81111111-1111-4111-8111-111111111111")
    return read(path)
  throw new Error("This file does not belong to the requested conversation")
}
if (!window.mako) throw new Error("Missing fixture bridge")
window.mako.readFile = read
window.mako.readLiveFile = (id, path) => readOwned("live", id, path)
window.mako.readThreadFile = (id, path) => readOwned("thread", id, path)
threadsStore.set({ descriptors: fixtureHarnesses, composerHarness: "claude" })
const id = "81111111-1111-4111-8111-111111111111"
const snapshot: LiveSnapshot = {
  session: {
    id,
    nativeId: "preview-fixture",
    harness: "claude",
    cwd: "/fixture/project",
    status: "ready",
    connection: "connected",
    modes: [],
    currentMode: null,
    configOptions: [],
  },
  revision: 1,
  createdAt: 1,
  base: null,
  requests: [],
  permissions: [],
  blocks: [],
}
mock.setLiveSnapshot(snapshot)
applyLiveSnapshot(snapshot)
acpStore.set({ activeKey: id })
export function fixtureTokenSpend() {
  const current = acpStore.get().conversations[id]
  if (current?.kind !== "live") throw new Error("Fixture conversation is unavailable")
  acpStore.set({ conversations: { ...acpStore.get().conversations, [id]: {
    ...current, session: { ...current.session, usage: { tokens: {
      input: 4_000_000, output: 800_000, cacheRead: 3_000_000, cacheWrite: 0,
    } } },
  } } })
}
export function fixtureReferenceTitles() {
  threadsStore.set({ threads: [
    { harness: "cursor", nativeId: "22222222-2222-4222-8222-222222222222", path: "/fixture/reference-short", title: "Short title" },
    { harness: "cursor", nativeId: "33333333-3333-4333-8333-333333333333", path: "/fixture/reference-long", title: "A long referenced conversation title that must truncate within the typed token without moving the caret or filling unused space" },
  ] })
}
accountsStore.set({
  providers: [
    {
      provider: "claude",
      label: "Claude Code",
      mode: "selectable",
      loginCommand: "claude auth login",
    },
  ],
  accounts: [
    {
      harness: "claude",
      name: "work",
      email: "work@example.test",
      active: true,
      source: "mako",
    },
    {
      harness: "claude",
      name: "personal",
      email: "personal@example.test",
      active: false,
      source: "mako",
    },
  ],
  usage: {},
})
let earlierGate: Promise<void> | undefined
export function holdFixtureHistory() {
  const pending = Promise.withResolvers<void>()
  earlierGate = pending.promise
  return () => {
    earlierGate = undefined
    pending.resolve()
  }
}
const exchange = (number: number, text?: string): Exchange => ({
  id: `turn-${number}`,
  prompt: {
    id: `turn-${number}`,
    role: "user",
    blocks: [
      {
        type: "text",
        text: `Question ${number}: inspect the shared preview and navigation behavior.`,
      },
    ],
  },
  response: [
    {
      id: `reply-${number}`,
      role: "assistant",
      provider: "claude",
      blocks: [
        {
          type: "text",
          text:
            text ??
            `Reply ${number}\n\n${"Variable-height output. ".repeat((number % 7) * 15 + 5)}`,
        },
      ],
    },
  ],
  system: [],
})
const diagnosticPaths = [
  "requests.har",
  "render.cpuprofile",
  "memory.heapsnapshot",
  "allocation.heapprofile",
  "main.trace.json",
  "malformed.har",
]
function Fixture() {
  const [scenario, setScenario] = useState("media")
  const [reply, updateReply] = useState<string>()
  const [prompt, updatePrompt] = useState<Exchange["prompt"]>()
  useEffect(() => { setReply = updateReply; return () => { setReply = undefined } }, [])
  useEffect(() => { setPrompt = updatePrompt; return () => { setPrompt = undefined } }, [])
  const [start, setStart] = useState(41)
  const [count, setCount] = useState(40)
  const [tail, setTail] = useState(0)
  const turns =
    scenario === "scroll"
      ? Array.from({ length: count }, (_, i) =>
          exchange(
            start + i,
            i === count - 1
              ? `Last reply\n\n${"Streaming output. ".repeat(5 + tail * 30)}`
              : undefined
          )
        )
      : scenario === "diagnostics"
        ? [
            exchange(
              1,
              diagnosticPaths
                .map((path, index) =>
                  index === 0
                    ? `Inspect [${path}](/fixture/${path}) here.`
                    : `- **[${path}](/fixture/${path})**`
                )
                .join("\n")
            ),
          ]
        : scenario === "documents"
          ? [
              exchange(
                1,
                "[guide.md](/fixture/guide.md)\n\n[report.html](/fixture/report.html)\n\n[document.pdf](/fixture/document.pdf)"
              ),
            ]
          : scenario === "office"
            ? [
                exchange(
                  1,
                  "[report.docx](/fixture/report.docx)\n\n[measurements.xlsx](/fixture/measurements.xlsx)\n\n[review.pptx](/fixture/review.pptx)"
                ),
              ]
            : [
                exchange(
                  1,
                  "Here are the generated assets.\n\n![Native asset](/fixture/native-image)\n\n[demo.mp4](/fixture/demo.mp4)\n\n[voice.wav](/fixture/voice.wav)"
                ),
              ]
  if (reply !== undefined) turns.splice(0, turns.length, exchange(1, reply))
  if (prompt && turns[0]) turns[0].prompt = prompt
  if (scenario === "native-documents")
    turns[0]!.response[0]!.blocks = [
      { type: "attachment", name: "generated.md", mimeType: "text/markdown", source: { kind: "inline", data: btoa("# Native Markdown\n\n**Formatted content** from the native attachment, without a filesystem path.\n\n- Shared renderer\n- Preserved source") } },
      { type: "attachment", name: "generated.html", mimeType: "text/html", source: { kind: "inline", data: btoa('<!doctype html><html><head></head><body style="font:16px system-ui;padding:24px;background:var(--surface);color:var(--foreground)"><h1>Native HTML attachment</h1><p>Inline reply preview</p><button onclick="this.textContent=\'Interaction works\'">Try interaction</button></body></html>') } },
    ]
  return (
    <TooltipProvider>
      <WorkspaceFocusContext
        value={{
          identity: "fixture-preview",
          cwd: "/fixture/project",
          ready: true,
        }}
      >
        <div className="mx-auto flex h-screen max-w-6xl flex-col bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-3 text-label">
            <span className="mr-3 text-faint">
              Shared preview acceptance · no agent started
            </span>
            {[
              "media",
              "documents",
              "office",
              "native-documents",
              "diagnostics",
              "scroll",
              "accounts",
              "authoring",
            ].map((name) => (
              <button
                key={name}
                className="pressable rounded bg-raised px-3 py-1.5"
                onClick={() => setScenario(name)}
              >
                {name}
              </button>
            ))}
            {scenario === "scroll" ? (
              <>
                {[6, 100, 101].map((size) => (
                  <button
                    key={size}
                    onClick={() => {
                      setStart(1)
                      setCount(size)
                    }}
                  >
                    {size} turns
                  </button>
                ))}
                <button
                  onClick={() => {
                    setStart(1)
                    setCount(200)
                  }}
                >
                  200 turns
                </button>
                <button
                  onClick={() => {
                    setStart(1)
                    setCount(201)
                  }}
                >
                  201 turns
                </button>
                <button
                  onClick={() => {
                    setStart(1)
                    setCount(240)
                  }}
                >
                  240 turns
                </button>
                <button onClick={() => setTail(tail + 1)}>Stream more</button>
              </>
            ) : null}
          </div>
          {scenario === "authoring" ? <div className="max-w-3xl overflow-auto p-8"><button className="mb-4 pressable rounded bg-raised px-3 py-1.5" onClick={fixtureExternalCommandEdit}>Fixture external edit</button><NativeAuthoringSection /></div> : scenario === "accounts" ? (
            <div className="max-w-2xl p-8">
              <ProviderAccounts providerId="claude" />
            </div>
          ) : (
            <>
              <div className="flex min-h-0 flex-1">
                <ConversationTimeline
                  identity={`preview-${scenario}`}
                  source={{ liveId: id }}
                  exchanges={turns}
                  empty={null}
                  hasEarlier={scenario === "scroll" && start > 1}
                  onLoadEarlier={async () => {
                    await earlierGate
                    setCount(count + start - 1)
                    setStart(1)
                  }}
                  entrance={false}
                />
              </div>
              <div className="border-t border-hairline">
                <Composer />
              </div>
            </>
          )}
        </div>
      </WorkspaceFocusContext>
    </TooltipProvider>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)
export { filePreviewFormat }

/** Mount the production inspector with controlled worker lifetime in acceptance checks. */
export async function mountDiagnosticChecks(urls: string[]) {
  const { DiagnosticPreview } =
    await import("@/components/viewer/diagnostic-preview")
  const element = document.createElement("div")
  element.dataset.diagnosticAcceptance = ""
  document.body.append(element)
  const root = createRoot(element)
  const render = (values: string[]) =>
    root.render(
      createElement(
        "div",
        {},
        values.map((url) =>
          createElement(DiagnosticPreview, { key: url, url, format: "har" })
        )
      )
    )
  render(urls)
  return {
    render,
    close: () => {
      root.unmount()
      element.remove()
    },
  }
}
