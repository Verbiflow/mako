// Isolated host process for the cross-host wake test. No provider is launched.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { startWebHost } from "../../electron/web-host.ts"
import { SessionMemory } from "../../electron/session-memory.ts"
import { hostCallInputs } from "../../electron/contracts/host-call-inputs.ts"
const root = process.env.MAKO_DATA_ROOT
const fixture = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"))
const memory = new SessionMemory(fixture.ledger, { pid: process.pid, startedAt: Math.round(performance.timeOrigin), label: "Mako's restarted dev3 host", socket: process.env.MAKO_WEB_SOCKET })
memory.hold("fixture", "restart-native", fixture.id)
const requests = []
const host = await startWebHost(process.env.MAKO_WEB_SOCKET, async (channel, args) => {
  if (channel === "mako:live-snapshot") return JSON.stringify({ ok: true, value: {
    session: { id: fixture.id, nativeId: "restart-native", harness: "fixture" }, requests,
  } })
  if (channel === "mako:live-prompt") {
    const [id, requestId, text] = hostCallInputs[channel].parse(args)
    if (id !== fixture.id) throw new Error("Wrong conversation")
    let request = requests.find((item) => item.id === requestId)
    if (!request) {
      request = { id: requestId, text, status: "queued" }
      requests.push(request)
      writeFileSync(join(root, "requests.json"), JSON.stringify(requests))
    }
    return JSON.stringify({ ok: true, value: request })
  }
  throw new Error(`Unexpected method ${channel}`)
}, async () => new Response(null, { status: 404 }), undefined, {
  protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: ["mako:live-snapshot", "mako:live-prompt"],
})
process.once("SIGTERM", () => {
  memory.close()
  host.close()
  setTimeout(() => process.exit(0), 300)
})
