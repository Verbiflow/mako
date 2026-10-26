// Explicit fixture page: a turn's media, as the transcript draws it from saved records.
import { createRoot } from "react-dom/client"
import type { Entry } from "@mako/sessions/entries"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { TranscriptPaneContext } from "@/state/conversation-scope"
import { TooltipProvider } from "@/components/ui/tooltip"
import { entriesToMessages } from "@/lib/entry-messages"
import { toExchanges } from "@/lib/exchanges"
import { foldTools } from "@/lib/tools"
import { getMako } from "@/lib/bridge"
import { prefsStore, bindTheme } from "@/state/prefs"
import { installMockBridge } from "./mock-bridge"
import signin from "./assets/media-shelf/signin.jpg?url"
import dashboard from "./assets/media-shelf/dashboard.jpg?url"
import settings from "./assets/media-shelf/settings.jpg?url"
import flow from "./assets/media-shelf/sign-in-flow.mp4?url"
import report from "./assets/media-shelf/report.html?raw"
import "../index.css"

installMockBridge()
const params = new URL(location.href).searchParams
prefsStore.set({ theme: params.get("theme") === "light" ? "light" : "dark" })
bindTheme()

const project = "/Users/you/ledgerline"
interface FixtureFile { url?: string; html?: string; mimeType: string; media?: "image" | "video" }
const files = new Map<string, FixtureFile>([
  ["signin.png", { url: signin, mimeType: "image/png", media: "image" }],
  ["dashboard.png", { url: dashboard, mimeType: "image/png", media: "image" }],
  ["settings.png", { url: settings, mimeType: "image/png", media: "image" }],
  ["sign-in-flow.mp4", { url: flow, mimeType: "video/mp4", media: "video" }],
  ["report.html", { html: report, mimeType: "text/html" }],
])
const fileOf = (path: string) => files.get(path.split("/").at(-1) ?? "")
const bridge = getMako()
bridge.readThreadFile = async (_thread, path) => {
  const file = fileOf(path)
  if (!file) throw new Error(`No file at ${path}`)
  return { path, contents: file.html ?? "", size: file.html?.length ?? 80_000, binary: !file.html, truncated: false, mimeType: file.mimeType, ...file.media && { media: file.media }, ...file.url && { previewUrl: file.url } }
}
bridge.resolveFileUrl = (url) => url
bridge.resolveTurnMedia = async (checks) => checks.map((check) => {
  const file = fileOf(check.path)
  return file
    ? { kind: "kept" as const, media: { path: check.path, file: check.path, digest: "0".repeat(64), kind: file.media ?? "html", mimeType: file.mimeType, bytes: 80_000, ...file.media === "image" && { width: 1280, height: 768 } } }
    : { kind: "dropped" as const, reason: "No such file" }
})

let clock = Date.parse("2026-10-26T09:12:00Z")
const at = (seconds: number) => (clock += seconds * 1000)
const shell = (id: string, command: string, named: string[]): Entry => ({
  type: "tool", id, name: "Bash", status: "completed", input: JSON.stringify({ command, description: "Capture the page" }), output: "", at: at(2), endedAt: at(3),
  effects: [{ kind: "command", command, cwd: project, exitCode: 0, named }],
})
const prompt = (text: string): Entry => ({ type: "user", id: `p-${text.length}`, text, at: at(0) })
const answer = (text: string): Entry => ({ type: "text", id: `t-${text.length}`, text, at: at(4), model: "claude-opus-5-5" })

const scenes = new Map<string, Entry[]>(Object.entries({
  uncited: [
    prompt("Take screenshots of the sign-in page, the dashboard and settings so I can check the new nav."),
    { type: "tool", id: "read-nav", name: "Read", status: "completed", input: JSON.stringify({ file_path: `${project}/src/nav.tsx` }), output: "export function Nav() {…}", at: at(1), endedAt: at(1), effects: [{ kind: "read", path: `${project}/src/nav.tsx` }] },
    shell("shot-1", "npx playwright screenshot --viewport-size=1280,768 http://localhost:5173/sign-in shots/signin.png", [`${project}/shots/signin.png`]),
    shell("shot-2", "npx playwright screenshot --viewport-size=1280,768 http://localhost:5173/ shots/dashboard.png", [`${project}/shots/dashboard.png`]),
    shell("shot-3", "npx playwright screenshot --viewport-size=1280,768 http://localhost:5173/settings shots/settings.png", [`${project}/shots/settings.png`]),
    answer("Captured the sign-in page, the dashboard and settings. The new nav shows on the two signed-in pages, the avatar sits flush right, and **New invoice** keeps its place when the window narrows. Sign-in has no nav, as before."),
  ],
  recording: [
    prompt("Record the sign-in flow end to end so I can watch it."),
    { type: "tool", id: "js-rec", name: "mcp__mako-computer__js", status: "completed", at: at(1), endedAt: at(9),
      input: JSON.stringify({ code: "const tab = await control.tab({ url: 'http://localhost:5173/sign-in' })\nconst rec = await tab.record()\nawait tab.fill(tab.locator({ role: 'textbox', name: 'Work email' }), 'dana@northwind.dev')\n…\nreturn await rec.stop()" }),
      output: "recording finished · 6.2 s · 37 frames", details: [{ type: "media", via: "produced", files: [{ path: `${project}/.mako/recordings/sign-in-flow.mp4` }] }] },
    answer("Recorded it: typing the email and password, pressing **Sign in**, then the dashboard loading. It takes about a second from submit to the first chart."),
  ],
  html: [
    prompt("Compare checkout performance before and after lazy-loading the payment form, and give me something I can share."),
    shell("perf", "node scripts/perf.mjs --runs 5 --out reports/report.html", [`${project}/reports/report.html`]),
    { type: "tool", id: "write-report", name: "Write", status: "completed", input: JSON.stringify({ file_path: `${project}/reports/report.html` }), output: "File written", at: at(1), endedAt: at(1), effects: [{ kind: "create", path: `${project}/reports/report.html` }] },
    answer("Largest contentful paint dropped from 3.4 s to 1.6 s and total blocking time from 420 ms to 90 ms. Layout shift rose slightly (0.02 to 0.03), from the form's placeholder; worth a fixed height."),
  ],
  show: [
    prompt("Show me the sign-in page and the dashboard after the nav change."),
    shell("shot-1", "npx playwright screenshot http://localhost:5173/sign-in shots/signin.png", [`${project}/shots/signin.png`]),
    shell("shot-2", "npx playwright screenshot http://localhost:5173/ shots/dashboard.png", [`${project}/shots/dashboard.png`]),
    { type: "tool", id: "show-1", name: "mcp__mako__show", status: "completed", at: at(1), endedAt: at(1),
      input: JSON.stringify({ title: "After the nav change", files: [{ path: `${project}/shots/signin.png`, caption: "Sign-in keeps its own layout, no nav" }, { path: `${project}/shots/dashboard.png`, caption: "Dashboard with the new nav and New invoice on the right" }] }),
      output: "Shown to the person in your reply: signin.png, dashboard.png.",
      details: [{ type: "media", via: "show", title: "After the nav change", files: [{ path: `${project}/shots/signin.png`, caption: "Sign-in keeps its own layout, no nav" }, { path: `${project}/shots/dashboard.png`, caption: "Dashboard with the new nav and New invoice on the right" }] }] },
    answer("Both look right. The nav only appears once you're signed in."),
  ],
}))

const entries = (scenes.get(params.get("scene") ?? "uncited") ?? scenes.get("uncited")!).map((entry, index) => ({ ...entry, id: entry.id ?? `e${index}` }))
const exchanges = toExchanges(foldTools(entriesToMessages(entries, { kind: "saved", provider: "claude", path: "/fixture/media-shelf.jsonl" }).messages))

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <TranscriptPaneContext value="media-shelf">
      <div className="h-screen bg-background text-foreground">
        <div className="mx-auto flex h-full max-w-[760px] flex-col px-6">
          <ConversationTimeline source={{ threadPath: "/fixture/media-shelf.jsonl" }} identity="media-shelf" exchanges={exchanges} empty={null} entrance={false} />
        </div>
      </div>
    </TranscriptPaneContext>
  </TooltipProvider>
)
