import assert from "node:assert/strict"
import { HostStopping, type HostProbes, type RunningCommand } from "@mako/host/base/host-stopping"
import { probeOpenFiles } from "@mako/host/harnesses/open-files-probe"
import { cursorProcessProbe } from "@mako/host/harnesses/cursor/process-probe"
import { createDevinProcessProbe } from "@mako/host/harnesses/devin/process-probe"

/**
 * Where the host reads the running processes' names without starting a process (`HostProbes.commands`, Linux), a
 * harness none of whose processes runs is answered from them: no lsof, no pgrep. An idle machine asked lsof for each
 * harness every 30 s, and those asks kept the probe child alive. With a process by a matching name, or where the
 * names aren't read, lsof answers as before.
 */

const ran: string[] = []
let running: RunningCommand[] | undefined = []
const probes: HostProbes = {
  async run(file, args) {
    ran.push(`${file} ${args.join(" ")}`)
    // lsof and pgrep exit 1 when they find nothing.
    throw Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "" })
  },
  startedAt: async () => 0,
  commands: async () => running,
}
const stopping = new HostStopping()
stopping.probes = probes
const signal = new AbortController().signal
const names = (list: string[]) => list.map((comm) => ({ comm, args: `/usr/bin/${comm}` }))

await stopping.run(async () => {
  running = names(["systemd", "node", "mako-syncd", "bash"])
  const none = await probeOpenFiles({ processNames: ["claude"], signal, accept: () => false })
  assert.deepEqual(none, { kind: "available", paths: [], processFound: false, pids: [], groups: new Map() }, "no claude, the answer lsof gives for none")
  await probeOpenFiles({ processNames: ["/^grok$/", "/^grok-native$/"], signal, accept: () => false })
  assert.equal(ran.length, 0, "no lsof for a harness with no process")

  running = names(["node", "claude"])
  await probeOpenFiles({ processNames: ["claude"], signal, accept: () => false })
  running = names(["grok-native"])
  await probeOpenFiles({ processNames: ["/^grok$/", "/^grok-native$/"], signal, accept: () => false })
  assert.equal(ran.filter((command) => command.includes("lsof")).length, 2, "a name lsof matches, by prefix or by its expression, is asked as before")

  ran.length = 0
  running = names(["node", "bash"])
  await cursorProcessProbe.probe(signal)
  assert.equal(ran.length, 0, "the host's own Node isn't Cursor's")
  running = [{ comm: "node", args: "/home/node/.local/bin/cursor-agent acp" }]
  await cursorProcessProbe.probe(signal)
  assert.equal(ran.length, 1, "Cursor's CLI, Node by its name, is found by its command line")

  ran.length = 0
  running = names(["node"])
  assert.deepEqual(await createDevinProcessProbe().probe(signal), { kind: "available", sessions: [] })
  assert.equal(ran.length, 0, "no devin, no pgrep")
  running = names(["devin"])
  await createDevinProcessProbe().probe(signal)
  assert.ok(ran.some((command) => command.startsWith("pgrep")), "a devin is looked for as before")

  ran.length = 0
  running = undefined
  await probeOpenFiles({ processNames: ["claude"], signal, accept: () => false })
  assert.equal(ran.length, 1, "where the names aren't read, lsof answers")
  running = []
  await probeOpenFiles({ processNames: ["codex"], sourcePath: "/tmp/rollout.jsonl", signal, accept: () => false })
  assert.equal(ran.length, 2, "who holds a file open is lsof's to say, whatever its name")
})
console.log("Probe names: a harness with no process is answered without lsof or pgrep; a matching name, a Cursor command line, a file asked about, or no names read, asks as before")
