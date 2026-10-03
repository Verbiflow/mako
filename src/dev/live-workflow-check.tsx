/* eslint-disable react-refresh/only-export-components -- This isolated acceptance entry exports controlled inputs; the application never imports it. */
import { fixtureHarnesses } from "./harness-fixtures"
import {
  preserveSendingDraft,
  interruptSendingDraft,
} from "@/state/send-recovery"
// Explicit isolated fixture; never imported by the application entry point.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Composer } from "@/components/composer/composer"
import { AppshotButton } from "@/components/composer/appshot-button"
import { registerSlot } from "@/extend/slots"
import { HotIndicator } from "@/components/shell/hot-indicator"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { Exchange } from "@/components/transcript/exchange"
import { ActivityMark } from "@/components/ui/activity-mark"
import { MODE_DRAWS, resolvePreset } from "thinking-orbs"
import { AgentsPanel } from "@/components/inspector/agents-panel"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { HostConnectionNotice } from "@/components/shell/host-connection-notice"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { acpStore } from "@/state/acp"
import { threadsStore } from "@/state/thread-store"
import { store } from "@/state/session"
import type { LiveSnapshot } from "@/lib/types"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

const mock = installMockBridge()
registerSlot("appshot", "composer.controls", AppshotButton, -10)
const id = "11111111-1111-4111-8111-111111111111"
const requestId = "22222222-2222-4222-8222-222222222222"
const cwd = "/fixture/project"
const snapshot: LiveSnapshot = {
  session: {
    id,
    harness: "claude",
    nativeId: "fixture-parent",
    cwd,
    title: "Review the routing changes",
    connection: "connected",
    status: "ready",
    modes: [
      { id: "default", name: "Ask for approval" },
      { id: "plan", name: "Plan" },
    ],
    currentMode: "default",
    configOptions: [],
  },
  revision: 1,
  createdAt: 1,
  base: null,
  permissions: [],
  requests: [
    {
      id: requestId,
      text: "Review the routing changes and check the tests.",
      attachments: [],
      status: "completed",
    },
  ],
  blocks: [
    { type: "user", text: "Keep the reply in the same Claude conversation." },
    { type: "text", text: "The provider session ID now owns continuation. An account-specific path is an alias, not a reason to create a new conversation." },
    { type: "user", text: "Preserve my unfinished prompt when I return to this project." },
    { type: "text", text: "The draft belongs to the project until it is sent. Opening New again restores the text and its staged attachments." },
    { type: "user", text: "Check the composer and keyboard navigation." },
    { type: "tool", id: "test-command", toolKind: "execute", title: "Run composer tests", input: "{\"command\":\"npm run test:live-controls\"}", output: "All composer checks passed.", status: "completed" },
    { type: "text", text: "Attachment references remain part of the text. Their previews carry the remove buttons, and the turn navigator stays beside the transcript." },
    {
      type: "user",
      text: "Review the routing changes and check the tests.",
      requestId,
    },
    {
      type: "text",
      text: "The route handling is consistent. One missing case needs attention: an expired session should return to sign-in while preserving the requested destination.",
    },
  ],
  control: {
    activeBindingId: id,
    bindings: [],
    children: [],
    merges: [],
    transfers: [],
    actions: [],
  },
  nativeAgents: {
    limited: false,
    agents: [
      {
        bindingId: id,
        provider: "claude",
        nativeId: "working",
        title: "Check route recovery and session expiry",
        role: "Explore",
        state: {
          kind: "working",
          activity: "Reading the session guard and redirect tests",
        },
        observedAt: 1,
        usage: { tokens: 2450, toolUses: 6, durationMs: 23000 },
      },
      {
        bindingId: id,
        provider: "claude",
        nativeId: "done",
        title: "Review test coverage",
        state: {
          kind: "completed",
          summary:
            "The success and signed-out paths have coverage.\n\nThe expired-session path does not. Add a regression test that expires the session, opens a protected deep link, and verifies that signing in returns to the same destination.\n\nNo files were changed.",
        },
        observedAt: 1,
        usage: { tokens: 6210, toolUses: 11, durationMs: 54000 },
      },
      {
        bindingId: id,
        provider: "claude",
        nativeId: "failed",
        title: "Check browser behavior",
        state: {
          kind: "failed",
          error:
            "Browser connection ended before the redirect could be checked.",
        },
        observedAt: 1,
      },
    ],
  },
}
threadsStore.set({
  composerHarness: "claude",
  descriptors: fixtureHarnesses.map((entry) => ({ ...entry, canSteer: entry.provider === "claude" })),
})
store.set({ messages: [], stream: null })
acpStore.set({ activeKey: id })
snapshot.blocks.push({
  type: "proposed-plan",
  id: "routing-plan",
  text: "# Route recovery\n\nPreserve the destination when an expired session sends the user to sign-in.\n\n## Implementation\n\n1. Keep the original URL while refreshing the session.\n2. Restore that URL after successful sign-in.\n3. Use the existing safe redirect validation.\n\n## Verification\n\nCover a protected deep link, an expired session, and an external redirect attempt.",
  status: "proposed",
})
mock.setLiveSnapshot(snapshot)
applyLiveSnapshot(snapshot)

/** No authentication, native launch or prompt delivery occurs in this fixture. */
export function fixtureAuthRecovery(harness: string) {
  if (!fixtureHarnesses.some((entry) => entry.provider === harness)) throw new Error("Unknown fixture harness")
  const next: LiveSnapshot = {
    ...snapshot,
    revision: (acpStore.get().conversations[id]?.revision ?? 0) + 1,
    session: { ...snapshot.session, harness, status: "failed", connection: "disconnected", error: "Native sign-in expired." },
    blocks: [],
    permissions: [],
    nativeAgents: undefined,
    requests: [{
      id: `auth-recovery-${harness}`, status: "failed", failure: "auth", error: "Native sign-in expired.",
      text: "Review the report [Attachment 1]", displayText: "Review the report [Attachment 1]",
      attachments: [{ name: "report.pdf", mimeType: "application/pdf", size: 123, path: "/fixture/report.pdf" }],
      nativeDelivery: { attemptId: "22222222-2222-4222-8222-222222222222", bindingId: id, ownerEpoch: "fixture", evidence: { kind: "accepted", source: "native-response" } },
    }],
  }
  threadsStore.set({ composerHarness: harness })
  mock.setLiveSnapshot(next)
  applyLiveSnapshot(next)
}
const quietBlocks = {
  "quiet-tool": { type: "tool", id: "quiet-build", toolKind: "execute", title: "npm run build", input: "{\"command\":\"npm run build\"}", output: "", status: "pending" },
  "quiet-reply": { type: "text", text: "The route guard keeps the destination, and the session refresh" },
} as const
const nativeScenes = {
  compacting: () => ({ activity: { kind: "compacting", since: Date.now() - 72_000 }, blocks: [] }),
  retrying: () => ({ activity: { kind: "retrying", attempt: 2, maxAttempts: 10, reason: "Overloaded (529)", since: Date.now() - 3_000, retryAt: Date.now() + 9_000 }, blocks: [] }),
  compacted: () => ({
    activity: undefined,
    blocks: [
      { type: "event", label: "Context compacted", detail: "Automatic · 182k → 24k tokens", body: "## Where things stand\n\nThe route guard now keeps the destination through sign-in. Remaining: the session-expiry deep link and its regression test.\n\n- `src/router/guard.ts` — keeps `returnTo`\n- `src/session/refresh.ts` — retries once before signing out" },
      { type: "event", label: "Model changed", detail: "claude-opus-4 → claude-sonnet-4 · after a refusal" },
      { type: "event", label: "Rate limited", detail: "Reached your 5-hour limit · resets 3:40 PM", tone: "warning" },
      { type: "event", label: "Turn failed", detail: "Server overloaded", body: "stream disconnected before completion: Our servers are currently overloaded. Please try again later.", tone: "error" },
      { type: "text", text: "Picking up from the summary: the deep link is next." },
    ],
  }),
} satisfies Record<string, () => { activity: LiveSnapshot["nativeActivity"]; blocks: LiveSnapshot["blocks"] }>
function publishNative(scene: keyof typeof nativeScenes) {
  const { activity, blocks } = nativeScenes[scene]()
  const next: LiveSnapshot = {
    ...snapshot,
    revision: (acpStore.get().conversations[id]?.revision ?? 0) + 1,
    session: { ...snapshot.session, status: "running", connection: "connected" },
    blocks: [...snapshot.blocks, ...blocks],
    activityAt: Date.now(),
    nativeActivity: activity,
    requests: [{ ...snapshot.requests[0]!, status: "dispatching" }],
  }
  mock.setLiveSnapshot(next)
  applyLiveSnapshot(next)
}
function publishQueue(phase: "starting" | "reasoning" | "responding" | keyof typeof quietBlocks) {
  const starting = phase === "starting"
  const quiet = phase === "quiet-tool" || phase === "quiet-reply" ? quietBlocks[phase] : undefined
  const next: LiveSnapshot = {
    ...snapshot,
    revision: (acpStore.get().conversations[id]?.revision ?? 0) + 1,
    session: {
      ...snapshot.session,
      status: starting ? "starting" : "running",
      connection: starting ? "starting" : "connected",
    },
    blocks: starting ? [] : [...snapshot.blocks, quiet ?? (phase === "reasoning" ? { type: "thinking", text: "Checking the route guard before changing session recovery." } : { type: "text", text: "Here is the final routing summary." })],
    activityAt: quiet ? Date.now() - (phase === "quiet-tool" ? 4 : 2) * 60_000 : Date.now(),
    requests: [
      {
        ...snapshot.requests[0]!,
        text: "Review the routing changes and check the tests.",
        status: starting ? "queued" : "dispatching",
      },
      ...(starting
        ? []
        : [
            {
              id: "33333333-3333-4333-8333-333333333333",
              text: "Also check keyboard navigation and focus after signing in.",
              attachments: [],
              status: "queued" as const,
            },
            {
              id: "44444444-4444-4444-8444-444444444444",
              text: "Keep the existing deep link when the session expires. Include a regression test.",
              attachments: [],
              status: "queued" as const,
            },
            {
              id: "55555555-5555-4555-8555-555555555555",
              text: "Give me a short summary of what changed.",
              attachments: [],
              status: "queued" as const,
            },
          ]),
    ],
  }
  mock.setLiveSnapshot(next)
  applyLiveSnapshot(next)
}
const formattingPrompt = "- **85** still have no usable office street candidate.\n\n\n\n\nNo way dude. This is fucking not possible. We have to figure this out. Either the office address or sometimes the office address, maybe also their first address where they incorporated, or whatever it is. California must have that address or Delaware or something. They must have that address. We should get that shit. Come on man"

Object.assign(window, { makoActivityBenchmark: () => {
  const canvas = document.createElement("canvas")
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext("2d")
  if (!context) throw new Error("No 2D canvas")
  return ([20, 64] as const).flatMap((size) => (["working", "solving", "searching", "weaving", "shaping", "composing", "connecting"] as const).map((state) => {
    canvas.width = size * 2
    canvas.height = size * 2
    const preset = resolvePreset(state, size)
    const samples: number[] = []
    for (let index = 0; index < 120; index++) {
      const start = performance.now()
      context.setTransform(2, 0, 0, 2, 0, 0)
      context.clearRect(0, 0, size, size)
      MODE_DRAWS[preset.mode](context, size, index / 30, true, preset.opts)
      samples.push(performance.now() - start)
    }
    samples.sort((a,b) => a-b)
    return { state, size, meanMs: samples.reduce((a,b) => a+b, 0) / samples.length, p95Ms: samples[114] }
  }))
}})

export function Fixture() {
  const [narrow, setNarrow] = useState(false)
  if (new URLSearchParams(location.search).has("motion")) return (
    <main id="activity-gallery" className="mx-auto max-w-content p-8">
      <h1 className="mb-6 text-title font-semibold">Activity states</h1>
      <div className="grid grid-cols-3 gap-6">
        {([ ["reasoning","Reasoning"], ["searching","Searching / reading"], ["executing","Running tools"], ["editing","Editing"], ["responding","Responding"], ["connecting","Connecting"], ["waiting","Needs approval"], ["failed","Failed"], ["complete","Complete"] ] as const).map(([state,label]) => (
          <div key={state} className="flex flex-col items-center gap-2 border border-hairline p-4 text-ui"><ActivityMark state={state} size={64} /><span>{label}</span></div>
        ))}
      </div>
    </main>
  )
  if (new URLSearchParams(location.search).has("format")) return (
    <TooltipProvider>
      <main id="prompt-format" data-source={formattingPrompt} className="mx-auto max-w-content p-8">
        <Exchange exchange={{id:"format-prompt", prompt:{id:"format-prompt",role:"user",blocks:[{type:"text",text:formattingPrompt}]},response:[],system:[]}} />
      </main>
    </TooltipProvider>
  )
  return (
    <TooltipProvider>
      <WorkspaceFocusContext
        value={{
          identity: `live:${id}`,
          cwd,
          title: snapshot.session.title,
          ready: true,
        }}
      >
        <div className="flex h-screen flex-col bg-surface">
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline px-4 py-2 text-label text-faint">
            <span>{new URLSearchParams(location.search).has("native") ? "Development UI · real native provider session" : "Isolated live workflow fixture · no agent is started"}</span>
            <HotIndicator />
            <button
              className="pressable rounded border border-hairline px-2 py-1"
              onClick={() => publishQueue("starting")}
            >
              First message startup
            </button>
            <button
              className="pressable rounded border border-hairline px-2 py-1"
              onClick={() => {
                const receipt = preserveSendingDraft({
                  key: id,
                  text: "Recover the interrupted paragraph without replacing my new draft.",
                  attachments: [],
                })
                if (receipt) interruptSendingDraft(receipt)
              }}
            >
              Interrupted send
            </button>
            <button
              className="pressable rounded border border-hairline px-2 py-1"
              data-fixture="running"
              onClick={() => publishQueue("reasoning")}
            >
              Working with queue
            </button>
            <button className="pressable rounded border border-hairline px-2 py-1" data-fixture="responding" onClick={() => publishQueue("responding")}>Streaming reply</button>
            <button className="pressable rounded border border-hairline px-2 py-1" data-fixture="quiet-tool" onClick={() => publishQueue("quiet-tool")}>Quiet tool</button>
            <button className="pressable rounded border border-hairline px-2 py-1" data-fixture="quiet-reply" onClick={() => publishQueue("quiet-reply")}>Quiet reply</button>
            {(["compacting", "retrying", "compacted"] as const).map((scene) => (
              <button key={scene} className="pressable rounded border border-hairline px-2 py-1" data-fixture={scene} onClick={() => publishNative(scene)}>
                {{ compacting: "Compacting", retrying: "Retrying", compacted: "Provider markers" }[scene]}
              </button>
            ))}
            <button
              className="pressable rounded border border-hairline px-2 py-1"
              onClick={() => setNarrow((value) => !value)}
            >
              {narrow ? "Wide layout" : "Narrow layout"}
            </button>
          </div>
          <div
            className={`mx-auto flex min-h-0 w-full flex-1 ${narrow ? "max-w-[760px]" : "max-w-[1280px]"}`}
          >
            <main className="flex min-w-0 flex-1 flex-col">
              <HostConnectionNotice />
              <AcpPanel />
              <Composer />
            </main>
            <aside
              className={`min-h-0 shrink-0 border-l border-hairline ${narrow ? "w-80" : "w-96"}`}
              aria-label="Agents companion"
            >
              <AgentsPanel />
            </aside>
          </div>
        </div>
        <Toaster />
      </WorkspaceFocusContext>
    </TooltipProvider>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)
