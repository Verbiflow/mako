// Explicit deterministic fixture page for a project's cloud access in the web app's Settings, without a gateway: a
// laptop browser's (`?view=web`, the desktop's own part) or a phone's touch layout (`?view=phone`). `?theme=light`,
// `?scene=none|connected|lapsed|refused`, `?step=connect` to open Cloudflare's two steps (and, with `scene=refused`,
// save a token the service refuses), and `?uses=open` to open Recent use. The desk's own Settings › Apps shows the
// same scenes under `?mock&invited&cloud-access=…`.
import { useEffect } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { CloudAccessTransport } from "@/state/cloud-access"
import { CloudAccessProjects } from "@/web-client/settings"
import { CLOUD_ACCESS_THREADS, mockCloudAccessStore, type CloudAccessScene } from "./mock-cloud-access"
import "../web-client/style.css"

const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle("light", params.get("theme") === "light")
const asked = params.get("scene")
const scene: CloudAccessScene = asked === "none" || asked === "lapsed" || asked === "refused" ? asked : "connected"
const store = mockCloudAccessStore(scene)
const titles = new Map<string, string>(Object.entries(CLOUD_ACCESS_THREADS))
const transport: CloudAccessTransport = { ...store, openUrl: () => undefined, threadTitle: (threadId) => titles.get(threadId) }
const REPOSITORIES = ["https://github.com/acme/shop", "https://github.com/acme/docs"]

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
      if (params.get("uses") === "open") press('button[aria-expanded="false"]')
      if (params.get("step") !== "connect") return
      press('[data-cloud-access-action="connect"]')
      if (scene !== "refused") return
      setTimeout(() => {
        type('input[aria-label="Cloudflare token"]', "made-up-token-for-the-fixture-0123456789")
        setTimeout(() => press('[data-cloud-access-form="cloudflare"] button[type="submit"]'), 50)
      }, 50)
    }, 150)
    return () => clearTimeout(timer)
  }, [])
}

/** Settings as the web client lays it out around the part: a laptop's column, or a phone's screen. */
export function CloudAccessCheck() {
  useScript()
  const phone = params.get("view") === "phone"
  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col bg-shell text-foreground">
        <header className="web-bar flex shrink-0 items-center gap-1 px-5">
          <h1 className="flex-1 text-ui font-semibold">Settings</h1>
        </header>
        <div className="px-4 pb-6">
          <div className="mx-auto flex max-w-[560px] flex-col gap-7 pt-3">
            <CloudAccessProjects transport={transport} repositories={REPOSITORIES} touch={phone} />
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
