import type { MethodTable } from "../host-methods.js"
import type { ThreadArchives } from "../thread-archives.js"
import type { ThreadLifecycle } from "../thread-lifecycle.js"
import type { ArchiveCommand, StopTarget, ThreadTarget } from "../contracts/thread-lifecycle.js"
import type { HostEvent } from "../contracts/host-events-boot.js"

export function installThreadLifecycleIpc(methods: MethodTable, lifecycle: ThreadLifecycle, archives: ThreadArchives, emit: (event: HostEvent) => void) {
  methods.handle("mako:thread-archives", () => archives.snapshot())
  methods.handle("mako:thread-controls", (target: ThreadTarget) => lifecycle.controls(target))
  methods.handle("mako:thread-archive", (command: ArchiveCommand) => {
    const snapshot = lifecycle.archive(command)
    emit({ type: "thread-archives", snapshot })
    return snapshot
  })
  methods.handle("mako:thread-stop", (target: StopTarget) => lifecycle.stop(target))
}
