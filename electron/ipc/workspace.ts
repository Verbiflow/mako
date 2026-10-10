import { watch, type FSWatcher } from "node:fs"
import type { AgentHost } from "../host.js"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { SearchOptions } from "@mako/host/contracts/git-workspace-search"
import type { MethodTable } from "@mako/host/base/methods"
import { hostMachine } from "@mako/host/base/machine"

export interface WorkspaceIpcContext {
  withHost<TResult>(
    operation: (host: AgentHost) => TResult | Promise<TResult>
  ): Promise<TResult>
  emit(event: HostEvent): void
}

/** Returns what stops the open file's watch. */
/** The file a client watches, between `mako:watch-file` and the host stopping. */
export interface WatchedFile {
  stop(): void
}

export function installWorkspaceIpc(methods: MethodTable, context: WorkspaceIpcContext): WatchedFile {
  const { emit, withHost } = context
  let fileWatcher: FSWatcher | null = null
  let fileChanged: NodeJS.Timeout | null = null
  const unwatch = (): void => {
    fileWatcher?.close()
    fileWatcher = null
    if (fileChanged) clearTimeout(fileChanged)
    fileChanged = null
  }
  methods.handle(
    "mako:create-workspace-text",
    (cwd: string, path: string, text: string) =>
      withHost((host) => host.createWorkspaceText(cwd, path, text))
  )
  methods.handle("mako:list-files", () => withHost((host) => host.listFiles()))
  methods.handle("mako:read-file", (path: string) =>
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
  methods.handle("mako:watch-file", (path: string) => {
    unwatch()
    try {
      fileWatcher = watch(path, () => {
        if (fileChanged) clearTimeout(fileChanged)
        fileChanged = setTimeout(() => emit({ type: "file-changed", path }), 120)
      })
    } catch {
      // A file that cannot be watched simply does not live-update.
    }
  })
  methods.handle("mako:unwatch-file", unwatch)
  methods.handle("mako:search", (query: string, options?: SearchOptions) =>
    withHost((host) => host.search(query, options))
  )
  methods.handle("mako:stage-file", (name: string, base64: string) =>
    withHost((host) => host.stageFile(name, base64))
  )
  methods.handle("mako:stage-file-path", (sourcePath: string) =>
    withHost((host) => host.stageFilePath(sourcePath))
  )
  return { stop: unwatch }
}
