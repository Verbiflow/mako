// Explicit deterministic fixture page. Normal verification still uses the real host.
import { useState, useSyncExternalStore } from "react"
import type { ThreadEntry } from "@mako/sessions"
import { mcpServerFailedEvent } from "@mako/sessions/events"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { acpBlocksToMessages } from "@/lib/acp-blocks"
import { Prose } from "@/components/transcript/markdown"
import { TranscriptAttachment } from "@/components/transcript/attachment"
import { TranscriptSourceContext } from "@/components/transcript/source-context"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { TooltipProvider } from "@/components/ui/tooltip"
import { threadToMessages } from "@/lib/foreign-thread"
import { toExchanges } from "@/lib/exchanges"
import { installMockBridge } from "./mock-bridge"
import { installBuiltins } from "@/desk/builtins"
import { HARNESS_TOOL_SAMPLES } from "./harness-tool-samples"
import "../index.css"

installMockBridge()
installBuiltins()
let reads = 0
const listeners = new Set<() => void>()
const source = { threadPath: "/fixture/native-thread" }
const imageUrl = new URL("/icons/app-icon.png", location.href).href
window.mako!.readThreadFile = async (_threadPath, path) => {
  reads += 1
  listeners.forEach((listener) => listener())
  if (path.includes("missing")) throw new Error("File no longer exists")
  return {
    path,
    contents: "",
    binary: true,
    truncated: false,
    size: 512,
    media: "image",
    mimeType: "image/png",
    previewUrl: imageUrl,
  }
}
window.mako!.resolveFileUrl = (url) => url
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const entries: ThreadEntry[] = [
  { kind: "user", text: "Read the retained image and update the file" },
  {
    kind: "assistant",
    blocks: [
      {
        type: "tool",
        id: "read",
        name: "Read",
        input: '{"path":"/fixture/proof.png"}',
        output: "",
        attachments: [
          {
            type: "attachment",
            name: "Returned image",
            mimeType: "image/png",
            source: { kind: "url", url: imageUrl },
          },
        ],
      },
      {
        type: "tool",
        id: "edit",
        name: "Edit",
        output: "",
        details: [
          {
            type: "diff",
            path: "/fixture/app.ts",
            oldText: "const answer = 1\n",
            newText: "const answer = 2\n",
          },
          { type: "terminal", terminalId: "terminal-7" },
        ],
      },
      {
        type: "tool",
        id: "plan",
        name: "Plan",
        output: "",
        details: [
          {
            type: "plan",
            entries: [
              { content: "Read the **image**", status: "completed" },
              { content: "Update `src/app.ts`", status: "completed" },
            ],
          },
        ],
      },
      {
        type: "thinking",
        text: "**Checking evidence**\n\n- Retain image ownership\n- Inspect `src/app.ts:12-18`",
      },
      {
        type: "text",
        text: "Done. The returned image belongs inside its Read result.",
      },
    ],
  },
]
const exchanges = toExchanges(threadToMessages(entries, 0, "claude"))
const providerTurnEntries: ThreadEntry[] = [
  { kind: "user", text: "Start `sleep 8; echo BG-DONE` in the background and don't wait for it" },
  {
    kind: "assistant",
    blocks: [
      { type: "tool", id: "bash", name: "Bash", input: '{"command":"sleep 8; echo BG-DONE","run_in_background":true}', output: "Command running in background with ID: b79s33s60" },
      { type: "text", text: "Started it in the background." },
    ],
  },
  { kind: "event", at: "2026-09-27T01:20:14.000Z", label: 'Background command "Sleep 8 seconds then print BG-DONE" completed (exit code 0)', opensTurn: true },
  { kind: "assistant", blocks: [{ type: "text", text: "The background command finished and printed `BG-DONE`." }] },
  { kind: "event", label: 'Background command "Watch the test logs" failed (exit code 1)', opensTurn: true },
  { kind: "user", text: "What failed in the watcher?" },
  { kind: "assistant", blocks: [{ type: "text", text: "The watcher exited with code 1 after the fixture server closed." }] },
]
const providerTurnExchanges = toExchanges(threadToMessages(providerTurnEntries, 0, "claude"))
const mcpFailure = (server: string, reason: string): LiveUpdate => ({ kind: "event", ...mcpServerFailedEvent(server, reason) })
const configWarning: LiveUpdate = {
  kind: "event", label: "Warning", detail: "Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.",
  body: "unknown keys: model_reasoning_summary_format, experimental_resume", tone: "warning", setup: true,
}
// A Codex session start's setup report, then markers that belong to the work.
// The second prompt follows a wake that reports the same setup again.
const eventBlocks = reduceLiveUpdates([], [
  configWarning,
  { kind: "user", text: "The selected options are not available together for Claude Opus 5.5. Why?" },
  mcpFailure("wisprflow", "sign-in required"),
  mcpFailure("todoist", "sign-in required"),
  mcpFailure("axiom", "sign-in required"),
  mcpFailure("paper", "MCP startup failed: handshaking with MCP server failed: connection closed: initialize response\nCaused by: process exited with status 1"),
  { kind: "text", id: "a1", text: "Variant matching required every option, including Plan, to be encoded by a variant." },
  { kind: "event", label: "Model changed", detail: "gpt-6-astra → gpt-5.5 · capacity" },
  { kind: "text", id: "a2", text: "Fixed: only encoded parameters pick a variant." },
  { kind: "user", text: "Run the suite" },
  configWarning,
  mcpFailure("wisprflow", "sign-in required"),
  mcpFailure("axiom", "sign-in required"),
  { kind: "event", label: "Context compacted", detail: "Automatic · 182k → 24k tokens · took 8s", body: "The conversation so far: fixing variant matching." },
  { kind: "event", label: "Turn failed", detail: "stream disconnected before completion", tone: "error" },
])
const eventExchanges = toExchanges(acpBlocksToMessages(eventBlocks, false, "codex").messages)
// One Thread per harness, each call as its native store records it, read
// through the same history path a real Thread takes.
const harnessToolExchanges = [...new Set(HARNESS_TOOL_SAMPLES.flatMap((sample) => sample.source.harness ?? []))].flatMap((harness) =>
  toExchanges(threadToMessages([
    { kind: "user", text: harness },
    {
      kind: "assistant",
      blocks: HARNESS_TOOL_SAMPLES.flatMap((sample, index) => sample.source.harness === harness && sample.source.name
        ? [{ type: "tool" as const, id: `${harness}-${index}`, name: sample.source.name, input: sample.source.input, output: "ok" }]
        : []),
    },
  ], 0, harness))
)
const code =
  "```typescript\nconst answer: number = 42\n\nconsole.log(answer)\n```\n\n```mermaid\nflowchart LR\n  Prompt --> Agent\n  Agent --> Tool\n  Tool --> Answer\n```"
const table =
  "| File | Confidence | Result |\n| --- | --- | --- |\n| `src/app.ts:12` | Confirmed | A complete readable result without splitting the header |\n| `package.json` | Confirmed | 3 checks passed |"
export function Fixtures() {
  const [mode, setMode] = useState<
    "Media" | "Code and diagrams" | "Tool results" | "Tables" | "Provider turns" | "Harness tools" | "Event markers"
  >("Media")
  const count = useSyncExternalStore(subscribe, () => reads)
  return (
    <TooltipProvider>
      <div className="h-screen overflow-auto bg-surface text-foreground">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-hairline bg-shell p-4">
          <h1 className="text-title font-semibold">Transcript fixtures</h1>
          {(
            ["Media", "Code and diagrams", "Tool results", "Tables", "Provider turns", "Harness tools", "Event markers"] as const
          ).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              className="pressable rounded border border-hairline px-2 py-1 text-ui"
              onClick={() => setMode(value)}
            >
              {value}
            </button>
          ))}
          <span className="text-label text-faint">{count} file reads</span>
        </header>
        <main className="mx-auto max-w-content p-6">
          <TranscriptSourceContext value={source}>
            {mode === "Media" ? (
              <div className="space-y-6">
                <Prose text="Local Markdown image: ![Local proof](/fixture/proof.png)" />
                <TranscriptAttachment
                  attachment={{
                    type: "attachment",
                    name: "URL image",
                    mimeType: "image/png",
                    source: { kind: "url", url: imageUrl },
                  }}
                />
                <Prose
                  text={
                    "![Missing image](/fixture/missing.png)\n\n![Audio proof](https://example.invalid/proof.mp3)\n\n![Video proof](https://example.invalid/proof.mp4)"
                  }
                />
                <div className="pt-[2000px]">
                  <TranscriptAttachment
                    attachment={{
                      type: "attachment",
                      name: "Offscreen proof",
                      mimeType: "image/png",
                      source: { kind: "file", path: "/fixture/offscreen.png" },
                    }}
                  />
                </div>
              </div>
            ) : mode === "Code and diagrams" ? (
              <Prose text={code} />
            ) : mode === "Tables" ? (
              <Prose text={table} />
            ) : mode === "Harness tools" ? (
              <ConversationTimeline
                identity="harness-tools-fixture"
                source={source}
                exchanges={harnessToolExchanges}
                empty={null}
              />
            ) : mode === "Event markers" ? (
              <ConversationTimeline
                identity="event-marker-fixture"
                source={source}
                exchanges={eventExchanges}
                empty={null}
              />
            ) : mode === "Provider turns" ? (
              <ConversationTimeline
                identity="provider-turn-fixture"
                source={source}
                exchanges={providerTurnExchanges}
                empty={null}
              />
            ) : (
              <ConversationTimeline
                identity="transcript-fixture"
                source={source}
                exchanges={exchanges}
                empty={null}
              />
            )}
          </TranscriptSourceContext>
        </main>
      </div>
    </TooltipProvider>
  )
}
