// The far end of test/daemon-held-loop.mjs: a catalog served on a socket from a thread of its own, the way mako-syncd
// serves the host from a process of its own, so it answers while the host's thread is held. Told "hold", it holds its
// own thread instead, as a daemon busy for seconds does.
import { parentPort, workerData } from "node:worker_threads"
import { serveCatalog } from "../dist/daemon.js"

const catalog = {
  count: 0,
  list: () => [],
  open: async () => null,
  page: async () => null,
  follow: () => () => {},
  onEvent: () => () => {},
  stop: () => {},
}
await serveCatalog(catalog, workerData.socketPath, undefined, { memoryGuard: false })
parentPort.on("message", (message) => {
  if (message !== "hold") return
  const until = performance.now() + 1_500
  while (performance.now() < until) {}
  parentPort.postMessage("held")
})
parentPort.postMessage("ready")
