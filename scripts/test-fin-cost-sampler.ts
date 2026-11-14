import assert from "node:assert/strict"
import { buildProcess, FinCostSampler } from "@mako/host/conversations/fin-cost-sampler"
import { readProcessTable, type ProcessRow } from "@mako/host/usage/mako-footprint"

const row = (pid: number, ppid: number, rssMb: number, cpuSeconds: number, command: string): ProcessRow =>
  ({ pid, ppid, rssKb: rssMb * 1024, cpuPercent: 0, cpuSeconds, command })

let now = 0
let table: ProcessRow[] = []
const owned = [
  { pid: 10, owner: "cursor-fin" },
  { pid: 20, owner: "codex-fin" },
  { pid: 30, owner: "idle-session" },
]
const sampler = new FinCostSampler({ table: async () => table, owned: () => owned, now: () => now })
const fins = [
  { conversation: "cursor-fin", harness: "cursor" },
  { conversation: "codex-fin", harness: "codex" },
  { conversation: "not-started", harness: "claude" },
]

table = [
  row(1, 0, 900, 500, "/Applications/Mako.app/Contents/MacOS/Mako"),
  row(10, 1, 80, 100, "mako-cursor-sdk"),
  row(11, 10, 4, 1, "/bin/zsh -c git status"),
  row(20, 1, 160, 50, "/opt/codex/bin/codex app-server"),
  row(30, 1, 120, 10, "mako-cursor-sdk"),
]
assert.equal(await sampler.sample(fins), undefined, "the first reading only opens the window")

now = 10_000
table = [
  row(1, 0, 900, 520, "/Applications/Mako.app/Contents/MacOS/Mako"),
  row(10, 1, 90, 102, "mako-cursor-sdk"),
  row(11, 10, 4, 1.5, "/bin/zsh -c git status"),
  // Started since the last reading: all of its 30 s is this window's.
  row(12, 11, 600, 30, "/usr/local/bin/node /repo/node_modules/typescript/bin/tsc -b"),
  row(20, 1, 170, 53, "/opt/codex/bin/codex app-server"),
  row(30, 1, 120, 40, "mako-cursor-sdk"),
]
const readings = await sampler.sample(fins)
assert.ok(readings)
assert.equal(readings.length, 2, "a Fin whose provider isn't running gives no reading, and a session that isn't a Fin isn't read")
const [cursor, codex] = readings
assert.equal(cursor!.harness, "cursor")
assert.ok(Math.abs(cursor!.cores - 3.25) < 1e-9, `the provider and all it started, new processes in full: ${cursor!.cores}`)
assert.equal(cursor!.memoryBytes, (90 + 4 + 600) * 1024 * 1024)
assert.equal(cursor!.build, true, "a tsc under the Fin's shell marks the reading a build's")
assert.deepEqual(codex, { harness: "codex", cores: 0.3, memoryBytes: 170 * 1024 * 1024 }, "the Mako app's own time is no Fin's")

now = 10_500
assert.equal(await sampler.sample(fins), undefined, "a window under a second gives nothing and keeps the last reading")
now = 20_000
table = table.filter((entry) => entry.pid !== 12).map((entry) => (entry.pid === 10 ? { ...entry, cpuSeconds: 103 } : entry))
const after = await sampler.sample(fins)
assert.ok(after)
assert.ok(Math.abs(after[0]!.cores - 0.1) < 1e-9 && after[0]!.build === undefined, "once the build ends the Fin reads light again")

for (const [command, expected] of [
  ["cargo build --release", true],
  ["/usr/bin/xcodebuild -scheme App", true],
  ["npm run build:electron", true],
  ["pnpm test", true],
  ["go test ./...", true],
  ["node /repo/node_modules/.bin/vitest run", true],
  ["python3 -m pytest tests", true],
  ["node /usr/local/lib/node_modules/npm/bin/npm-cli.js run lint", false],
  ["npm install", false],
  ["/bin/zsh -lc rg foo", false],
  ["node /repo/scripts/serve.mjs", false],
  ["mako-cursor-sdk", false],
] as const) assert.equal(buildProcess(command), expected, command)

// This machine's own table reads: every row has a pid, and some process has spent CPU time.
const live = await readProcessTable()
assert.ok(live.length > 1 && live.every((entry) => entry.pid > 0) && live.some((entry) => entry.cpuSeconds > 0))
console.log("Fin cost sampler: each Fin's provider and what it started, per harness, new processes in full, builds marked, other sessions and the app left out; the live process table reads")
