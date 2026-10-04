import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { JsonValue } from "../electron/codex-app-json.js"
import { containersBy, lookAtContainers } from "../electron/container-runtime.js"

// The engine's API over its Unix socket, as Docker Desktop, OrbStack and Colima serve it.
const root = mkdtempSync(join(tmpdir(), "mako-containers-"))
const socket = join(root, "docker.sock")
const MB = 1024 * 1024
const asked: string[] = []
const server = createServer((request, response) => {
  asked.push(request.url ?? "")
  const json = (body: JsonValue) => response.end(JSON.stringify(body))
  if (request.url === "/containers/json") return json([
    { Id: "compose1", Names: ["/shop-db-1"], Image: "postgres:16", Labels: { "com.docker.compose.project": "shop", "com.docker.compose.project.working_dir": "/work/shop/infra" }, Mounts: [{ Type: "volume", Source: "/var/lib/docker/volumes/x" }], Ports: [{ PublicPort: 5432 }, { PublicPort: 5432 }, {}] },
    { Id: "bind2", Names: ["/scratch"], Image: "node:24", Labels: {}, Mounts: [{ Type: "bind", Source: "/work/shop-feature/src" }], Ports: [] },
    { Id: "loose3", Names: ["/loose"], Image: "redis", Labels: null, Mounts: null, Ports: null },
    { Id: "v1stats", Names: ["/old"], Image: "mysql", Labels: { "com.docker.compose.project.working_dir": "/work/shop" } },
  ])
  if (request.url === "/info") return json({ MemTotal: 8 * 1024 * MB })
  if (request.url?.startsWith("/containers/compose1/stats")) return json({ memory_stats: { usage: 400 * MB, stats: { inactive_file: 100 * MB, anon: 280 * MB } } })
  if (request.url?.startsWith("/containers/bind2/stats")) return json({ memory_stats: { usage: 50 * MB, stats: {} } })
  if (request.url?.startsWith("/containers/v1stats/stats")) return json({ memory_stats: { usage: 90 * MB, stats: { total_inactive_file: 10 * MB } } })
  if (request.url?.startsWith("/containers/loose3/stats")) { response.statusCode = 500; return response.end("{}") }
  response.statusCode = 404
  response.end("{}")
})
server.listen(socket)
await once(server, "listening")
try {
  const look = await lookAtContainers({ socket, now: () => 1 })
  assert.ok(look)
  assert.equal(look.totalBytes, 8 * 1024 * MB)
  assert.deepEqual(look.containers.map(({ name, bytes, folders, ports, project }) => ({ name, bytes, folders, ports, project })), [
    { name: "shop-db-1", bytes: 300 * MB, folders: ["/work/shop/infra"], ports: [5432], project: "shop" },
    { name: "scratch", bytes: 50 * MB, folders: ["/work/shop-feature/src"], ports: [], project: undefined },
    { name: "loose", bytes: undefined, folders: [], ports: [], project: undefined },
    { name: "old", bytes: 80 * MB, folders: ["/work/shop"], ports: [], project: undefined },
  ], "usage less reclaimable cache (cgroup v2 and v1), Compose folders and bind mounts, published ports once each, and a container whose stats failed kept without bytes")
  assert.ok(asked.every((path) => !path.includes("stats") || path.includes("one-shot=true")), "stats are read once, not streamed")

  const by = containersBy(look, [
    { owner: "main", folders: ["/work/shop"] },
    { owner: "feature", folders: ["/work/shop-feature"] },
    { owner: "infra", folders: ["/work/shop/infra"] },
  ])
  assert.deepEqual([...by].map(([owner, containers]) => [owner, containers.map((container) => container.name)]), [
    ["infra", ["shop-db-1"]],
    ["feature", ["scratch"]],
    ["main", ["old"]],
  ], "the deepest folder holding a container's folder owns it; a sibling folder with a shared prefix doesn't; a container tied to no folder is nobody's")

  server.close()
  assert.equal(await lookAtContainers({ socket }), undefined, "no engine answering is no runtime")
  assert.equal(await lookAtContainers({ socket: join(root, "missing.sock") }), undefined)
  console.log("container runtime: the engine's list, one-shot stats less cache, its machine's size, Compose folders and bind mounts, ownership by the deepest folder, and no engine")
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}
