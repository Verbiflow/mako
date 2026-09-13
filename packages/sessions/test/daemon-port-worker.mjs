// The far end of test/daemon.mjs's worker-port check: a catalog served over a
// port that was transferred into this thread, the way the host's catalog
// worker receives its port.
import { workerData } from "node:worker_threads"
import { serveCatalogOnPort } from "../dist/daemon.js"

const ref = { harness: "codex", nativeId: "remote", path: "/remote", cwd: "/p", workspace: "/p" }
const catalog = {
  count: 1,
  list: () => [ref],
  open: async () => ({ ref, entries: [{ kind: "user", text: "from the worker" }] }),
  page: async () => null,
  follow: () => () => {},
  onEvent: () => () => {},
  stop: () => {},
}
serveCatalogOnPort(catalog, workerData.port, { memoryGuard: false })
