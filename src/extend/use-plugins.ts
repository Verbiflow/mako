import { useEffect } from "react"
import { getMako, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"
import { plugins } from "@/extend/plugin-registry"

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
        if (loaded.error) {
          toast.error(`Plugin "${file.id}" failed to load`, { description: loaded.error })
        }
      }
    }

    // A runtime that can't load (a chunk gone after an update) leaves every plugin unloaded: say so, as a plugin's own failure is said.
    const syncing = () => sync().catch((error) => {
      toast.error("Plugins couldn't load", { description: error instanceof Error ? error.message : String(error) })
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
