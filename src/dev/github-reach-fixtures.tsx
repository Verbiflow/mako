// Explicit deterministic fixture page for GitHub reach without a gateway or a host: the desktop's part as Settings › Apps
// draws it (`?view=desk`), the web app's Settings in a laptop's browser (`?view=web`: every project's asks at the top,
// then the desktop's part for a project), or a phone's touch layout (`?view=phone`). `?theme=light`,
// `?scene=repository|chosen|installation|asks|answered|refused` (`mock-github-reach.ts`), and `?step=add` to add a
// repository (in `refused`, one the App can't see). In `answered` the first ask's "Allow for this Thread" is pressed,
// and lands as already answered elsewhere. The desk's own Settings › Apps shows the same scenes under
// `?mock&invited&github-reach=…`.
import { useEffect } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { GitHubReach } from "@/components/settings/github-reach"
import type { GitHubReachTransport } from "@/state/github-reach"
import { GitHubAsksPart, GitHubReachProjects } from "@/web-client/settings"
import { GITHUB_REACH_THREADS, githubReachScene, mockGitHubReachStore } from "./mock-github-reach"
import "../web-client/style.css"

const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle("light", params.get("theme") === "light")
const scene = githubReachScene(params.get("scene"))
const PROJECTS = ["https://github.com/acme/shop", "https://github.com/acme/docs"]
const store = mockGitHubReachStore(scene)
store.seed(PROJECTS)
const titles = new Map<string, string>(Object.entries(GITHUB_REACH_THREADS))
const transport: GitHubReachTransport = { ...store, threadTitle: (threadId) => titles.get(threadId) }
const view = params.get("view") === "phone" ? "phone" : params.get("view") === "web" ? "web" : "desk"

function useScript() {
  useEffect(() => {
    const press = (selector: string) => document.querySelector<HTMLElement>(selector)?.click()
    const type = (selector: string, text: string) => {
      const input = document.querySelector<HTMLInputElement>(selector)
      if (!input) return
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }
    const timer = setTimeout(() => {
      if (scene === "answered") press('[data-github-ask-answer="thread"]')
      if (params.get("step") !== "add") return
      press('[data-github-reach-mode="chosen"]')
      setTimeout(() => {
        type('input[aria-label="Repository to add"]', scene === "refused" ? "secret-ops" : "acme/web-components")
        setTimeout(() => press('[data-github-reach-add] button[type="submit"]'), 50)
      }, 50)
    }, 150)
    return () => clearTimeout(timer)
  }, [])
}

/** The part as each surface lays it out: the desk's Settings pane, a laptop browser's Settings column, or a phone's screen. */
export function GitHubReachCheck() {
  useScript()
  if (view === "desk")
    return (
      <TooltipProvider>
        <div className="min-h-screen bg-surface px-10 py-8 text-foreground">
          <div className="mx-auto flex max-w-[720px] flex-col gap-5">
            <div>
              <h2 className="text-title font-semibold">shop</h2>
              <p className="mt-0.5 text-label text-faint">Settings › Apps · In Mako Cloud</p>
            </div>
            <GitHubReach transport={transport} repository={PROJECTS[0]!} />
          </div>
        </div>
      </TooltipProvider>
    )
  const touch = view === "phone"
  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col bg-shell text-foreground">
        <header className="web-bar flex shrink-0 items-center gap-1 px-5">
          <h1 className="flex-1 text-ui font-semibold">Settings</h1>
        </header>
        <div className="px-4 pb-6">
          <div className="mx-auto flex max-w-[560px] flex-col gap-7 pt-3">
            <GitHubAsksPart transport={transport} touch={touch} />
            <GitHubReachProjects transport={transport} projects={PROJECTS} touch={touch} />
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
