import { watch, type FSWatcher } from "node:fs"
import type { AgentHost } from "../host.js"
import type { HostEvent, SearchOptions } from "../shared.js"
import { registerIpc } from "./register.js"
import { hostMachine } from "../machine.js"

export interface WorkspaceIpcContext {
  withHost<TResult>(
    operation: (host: AgentHost) => TResult | Promise<TResult>
  ): Promise<TResult>
  emit(event: HostEvent): void
}

let fileWatcher: FSWatcher | null = null
let fileWatchTimer: NodeJS.Timeout | null = null

export function stopWorkspaceIpc(): void {
  fileWatcher?.close()
  fileWatcher = null
  if (fileWatchTimer) clearTimeout(fileWatchTimer)
  fileWatchTimer = null
}

export function installWorkspaceIpc(context: WorkspaceIpcContext): void {
  const { emit, withHost } = context
  registerIpc(
    "mako:create-workspace-text",
    (_event, cwd: string, path: string, text: string) =>
      withHost((host) => host.createWorkspaceText(cwd, path, text))
  )
  registerIpc("mako:list-files", () => withHost((host) => host.listFiles()))
  registerIpc("mako:read-file", (_event, path: string) =>
    withHost(async (host) => {
      const file = await host.readWorkspaceFile(path)
      if (file.media !== "spreadsheet") return file
      const machine = hostMachine()
      if (machine.kind === "absent") return file
      const absolute = await host.resolvePath(path)
      const thumbnail = await machine.thumbnail(absolute, 1200).catch(() => null)
      if (thumbnail) file.thumbnailUrl = `data:image/png;base64,${thumbnail.toString("base64")}`
      return file
    })
  )
  /**
   * Watch the one file the viewer has open. An agent mid-edit rewrites it
   * every few seconds; the viewer should breathe with it, not wait for a
   * manual reopen. One watcher, replaced on every call, dropped on unwatch.
   */
  registerIpc("mako:watch-file", (_event, path: string) => {
    stopWorkspaceIpc()
    try {
      let timer: NodeJS.Timeout | null = null
      fileWatcher = watch(path, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => emit({ type: "file-changed", path }), 120)
      })
    } catch {
      // A file that cannot be watched simply does not live-update.
    }
  })
  registerIpc("mako:unwatch-file", stopWorkspaceIpc)
  registerIpc("mako:search", (_event, query: string, options?: SearchOptions) =>
    withHost((host) => host.search(query, options))
  )
  registerIpc("mako:stage-file", (_event, name: string, base64: string) =>
    withHost((host) => host.stageFile(name, base64))
  )
  registerIpc("mako:stage-file-path", (_event, sourcePath: string) =>
    withHost((host) => host.stageFilePath(sourcePath))
  )
}
