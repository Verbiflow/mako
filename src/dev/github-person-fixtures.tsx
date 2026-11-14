// Explicit deterministic fixture page for "Open pull requests as me" beyond the desk's own Settings (`?mock`): the
// transcript's notice under a refused pull request, drawn by the real timeline, and the web client's Settings group on
// a phone and in a laptop's browser. `?view=notice|phone|desk`, `?theme=light`, `?authorship=you|mako|failed`, and
// `?scene=off|asking|refused|on|expired|confirm`.
import { useEffect } from "react"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { personTokenRefusal, type GitHubTokenListing } from "@mako/host/contracts/github-person"
import { entriesToMessages } from "@/lib/entry-messages"
import { toExchanges } from "@/lib/exchanges"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { TooltipProvider } from "@/components/ui/tooltip"
import { installBuiltins } from "@/desk/builtins"
import type { CommitAuthor, GitHubAuthorship } from "@mako/host/contracts/github-authorship"
import type { GitHubTokens } from "@/state/github-token"
import type { GitHubAuthorships } from "@/state/github-authorship"
import { PullRequestsAsMe } from "@/components/settings/pull-requests-as-me"
import { TouchPullRequests } from "@/web-client/settings"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

installMockBridge()
installBuiltins()
const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle("light", params.get("theme") === "light")

const refused = personTokenRefusal({ reason: "expired", login: "ada", repository: "acme/shop", expiredAt: "2026-10-25T00:00:00.000Z" })
const updates: LiveUpdate[] = [
  { kind: "user", text: "Open a pull request for the cart work" },
  { kind: "tool", id: "status", title: "Pull request status", name: "mcp__mako__pull_request_status", status: "completed", input: "{}" },
  { kind: "tool-update", id: "status", output: "{\"branch\":\"cart\",\"opening\":{\"base\":\"main\",\"commits\":[\"3f1c2aa Add the cart\"]}}" },
  { kind: "tool", id: "open", title: "Pull request open", name: "mcp__mako__pull_request_open", status: "in_progress", input: JSON.stringify({ title: "Add the cart", body: "Adds the cart to the shop." }) },
  { kind: "tool-update", id: "open", status: "failed", output: refused },
  { kind: "text", id: "a1", text: "I didn't open it: your GitHub token for @ada expired on Oct 25, and you open pull requests as yourself, so I didn't switch to Mako by Verbiflow. Update the token in Settings › Git, or tell me to open it as Mako by Verbiflow this once." },
]
const exchanges = toExchanges(entriesToMessages(reduceLiveUpdates([], updates), { kind: "live", running: false, provider: "claude" }).messages)

export function Notice() {
  return (
    <TooltipProvider>
      <div className="h-screen overflow-auto bg-surface px-8 py-6 text-foreground">
        <div className="mx-auto max-w-[760px]">
          <ConversationTimeline identity="github-person-notice" source={{ threadPath: "/fixture/github-person" }} exchanges={exchanges} empty={null} />
        </div>
      </div>
    </TooltipProvider>
  )
}

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
const scene = params.get("scene") ?? "off"
let kept: GitHubTokenListing | null = scene === "on" || scene === "confirm" ? { login: "ada", savedAt: daysFromNow(-3), expiresAt: daysFromNow(57) } : scene === "expired" ? { login: "ada", savedAt: daysFromNow(-95), expiresAt: daysFromNow(-5) } : null
const tokens: GitHubTokens = {
  read: async () => kept,
  save: async (token) => {
    if (token.endsWith("refused")) throw new Error("This token can't reach acme/shop. Give it access to that repository on GitHub.")
    kept = { login: "ada", savedAt: new Date().toISOString(), expiresAt: daysFromNow(90) }
    return kept
  },
  remove: async () => void (kept = null),
  openUrl: () => undefined,
}
// The gateway's `github-authorship` route as it answers: `?authorship=mako` starts As Mako, `=failed` can't be read,
// `=missing` is a gateway without the route, `=refused` can't be saved, `=unanswered` saves but loses its answer, `=gone`
// fails the save and every read after it, and `=slow` hasn't been read yet.
let as: CommitAuthor = params.get("authorship") === "mako" ? "mako" : "you"
const answer = (): GitHubAuthorship => ({ as, pullRequests: as === "mako" ? "mako" : kept ? "you" : "mako-fallback", login: kept?.login ?? null })
let lost = false
const authorships: GitHubAuthorships = {
  read: async () => {
    if (lost) throw new Error("Error invoking remote method 'mako:github-authorship': GET answered 500")
    if (params.get("authorship") === "failed") throw new Error("Error invoking remote method 'mako:github-authorship': GET answered 500")
    if (params.get("authorship") === "missing") return null
    if (params.get("authorship") === "slow") await new Promise(() => {})
    return answer()
  },
  save: async (next) => {
    if (params.get("authorship") === "unanswered") as = next
    lost = params.get("authorship") === "gone"
    if (params.get("authorship") === "refused" || params.get("authorship") === "unanswered" || lost) throw new Error("Error invoking remote method 'mako:github-authorship-save': PUT answered 500")
    as = next
    return answer()
  },
}

/** A laptop browser's Settings: the desktop's own group, in the web client's pane. */
export function Desk() {
  return (
    <TooltipProvider>
      <div className="min-h-screen bg-shell px-5 py-6 text-foreground">
        <div className="mx-auto max-w-[560px]">
          <PullRequestsAsMe tokens={tokens} authorships={authorships} />
        </div>
      </div>
    </TooltipProvider>
  )
}

/** A phone's Settings screen around the group, as the web client lays it out. */
export function Phone() {
  useEffect(() => {
    const press = (selector: string) => document.querySelector<HTMLElement>(selector)?.click()
    const type = (text: string) => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="GitHub token"]')
      if (!input) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }
    const timer = setTimeout(() => {
      if (scene === "asking" || scene === "refused") press('[role="switch"][aria-label="Open pull requests as me"]')
      if (scene === "confirm") press('[role="switch"][aria-label="Open pull requests as me"]')
      if (scene === "refused") {
        setTimeout(() => {
          type("github_pat_11AAAAAAA0madeUpForTests_0123456789refused")
          setTimeout(() => press('button[type="submit"]'), 50)
        }, 50)
      }
    }, 100)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="flex min-h-screen flex-col bg-shell text-foreground">
      <header className="web-bar flex shrink-0 items-center gap-1 px-5">
        <h1 className="flex-1 text-ui font-semibold">Settings</h1>
      </header>
      <div className="px-4 pb-6">
        <div className="mx-auto flex max-w-[560px] flex-col gap-7 pt-3">
          <TouchPullRequests tokens={tokens} authorships={authorships} />
        </div>
      </div>
    </div>
  )
}
