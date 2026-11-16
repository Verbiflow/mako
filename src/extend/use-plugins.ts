import { useEffect } from "react"
import { getMako, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import { plugins } from "@/extend/plugin-registry"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"

/** How long a plugin runtime that didn't load waits before it's asked again, once. */
export const PLUGINS_RETRY_MS = 2_000

/** Settings › UI extensions, where each plugin's error is on its row. */
function openPlugins() {
  window.dispatchEvent(new CustomEvent("mako:settings", { detail: "plugins" }))
}

/**
 * Keeps the loaded plugins in step with the plugins directory.
 *
 * Loaded once at boot and re-loaded whenever the host says a file changed —
 * which happens when the agent writes one with its ordinary tools. Nothing in
 * the loop is development-only: it is the same in a packaged build, which is
 * the entire reason this exists rather than leaning on the bundler's hot
 * replacement.
 */
export function usePlugins() {
  useEffect(() => {
    if (!hasBridge()) return
    const bridge = getMako()

    let live = true
    // The plugin runtime and its compiler (sucrase) load with the first plugin, never for a person with none.
    let host: typeof import("@/extend/plugin-host") | undefined

    const sync = async () => {
      const files = await bridge.listPlugins().catch(() => [])
      if (!live || (!files.length && !host)) return
      host ??= await import("@/extend/plugin-host")
      if (!live) return
      const { loadPlugin, unloadPlugin } = host

      const present = new Set(files.map((file) => file.id))
      // A plugin whose file is gone must give its registrations back, or a
      // deleted plugin would keep a command in the palette until restart.
      for (const [id] of plugins.entries()) {
        if (!present.has(id)) unloadPlugin(id)
      }

      for (const file of files) {
        // Unchanged source is skipped: re-evaluating a module that did not
        // change would tear down and rebuild its contributions for nothing,
        // which is visible as a flicker in whatever slot it renders into.
        if (plugins.get(file.id)?.source === file.source) continue
        const loaded = await loadPlugin(file.id, file.source, file.error)
        // A broken save should say so the moment it happens — the person
        // (or agent) who wrote it is looking at the wrong window to notice.
        // Its error is on its row in Settings › UI extensions, where it can be read whole; the toast says where.
        if (loaded.error) {
          console.warn(`A plugin didn't load ${JSON.stringify({ plugin: file.id, error: loaded.error })}`)
          toast.error(`Plugin "${file.id}" didn't load`, { duration: ACTION_TOAST_MS, action: { label: "Show the error", onClick: openPlugins } })
        }
      }
    }

    // A runtime that can't load leaves every plugin unloaded. A moment's failure is asked again once, quietly; one that
    // stays is a window older than the app (an update replaced the chunk it asks for), which a reload fixes.
    const syncing = () => sync().catch(async (first: Error) => {
      console.warn(`Plugins didn't load; asked again ${JSON.stringify({ error: first.message })}`)
      await new Promise((resolve) => setTimeout(resolve, PLUGINS_RETRY_MS))
      if (!live) return
      await sync().catch((error: Error) => {
        console.warn(`Plugins didn't load ${JSON.stringify({ error: error.message })}`)
        toast.error("UI extensions didn't load", { duration: ACTION_TOAST_MS, action: { label: "Reload", onClick: () => window.location.reload() } })
      })
    })
    void syncing()
    const unsubscribe = bridge.onEvent((event) => {
      if (event.type === "plugins-changed") void syncing()
    })

    return () => {
      live = false
      unsubscribe()
    }
  }, [])
}
