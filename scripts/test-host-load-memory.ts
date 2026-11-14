import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readResident, unmeasured, type ResidentMemory } from "./lib/host-load-memory.ts"

/** The load bench's memory gate: a `ps` that doesn't answer must never read as a host using no memory. */
const folder = mkdtempSync(join(tmpdir(), "mako-host-load-memory-"))
const realPath = process.env.PATH
const fresh = (): ResidentMemory => ({ peakKb: 0, readings: 0, misses: 0 })
const pid = String(process.pid)

const withPs = async (script: string): Promise<ResidentMemory> => {
  writeFileSync(join(folder, "ps"), `#!/bin/sh\n${script}\n`)
  chmodSync(join(folder, "ps"), 0o755)
  process.env.PATH = folder
  const memory = fresh()
  await readResident(pid, memory)
  process.env.PATH = realPath
  return memory
}

try {
  const real = fresh()
  await readResident(pid, real)
  assert.equal(real.readings, 1, "this process can be read")
  assert.ok(real.peakKb > 1024, `and uses memory (${real.peakKb} KB)`)

  assert.deepEqual(await withPs("echo '  2048'"), { peakKb: 2048, readings: 1, misses: 0 }, "as ps pads it")
  for (const [what, script] of [
    ["refusing", "exit 1"],
    ["refusing after a number", "echo 2048; exit 1"],
    ["saying nothing", "exit 0"],
    ["saying blank", "echo '   '"],
    ["saying no number", "echo unavailable"],
    ["saying two lines", "printf '2048\\n4096\\n'"],
    ["saying zero", "echo 0"],
    ["saying less than nothing", "echo -5"],
  ] as const) assert.deepEqual(await withPs(script), { peakKb: 0, readings: 0, misses: 1 }, `ps ${what} is no reading`)

  process.env.PATH = join(folder, "nowhere")
  const missing = fresh()
  await readResident(pid, missing)
  process.env.PATH = realPath
  assert.deepEqual(missing, { peakKb: 0, readings: 0, misses: 1 }, "no ps at all is no reading, and no crash")

  const peaks = fresh()
  for (const kb of [100, 300, 200]) {
    writeFileSync(join(folder, "ps"), `#!/bin/sh\necho ${kb}\n`)
    process.env.PATH = folder
    await readResident(pid, peaks)
    process.env.PATH = realPath
  }
  assert.equal(peaks.peakKb, 300, "the peak of what it read")

  const memory = (readings: number, misses: number): ResidentMemory => ({ peakKb: readings ? 1024 : 0, readings, misses })
  assert.equal(unmeasured(memory(60, 0), 60), undefined, "a reading a second judges")
  assert.equal(unmeasured(memory(54, 6), 60), undefined, "through a few that didn't answer")
  assert.ok(unmeasured(memory(0, 0), 60), "no reading at all can't")
  assert.ok(unmeasured(memory(0, 60), 60), "nor every reading refused")
  assert.ok(unmeasured(memory(50, 10), 60), "nor a sixth of them")
  assert.ok(unmeasured(memory(5, 0), 60), "nor a sampler that stopped early: the peak may be after it")
  console.log("Host load memory: only what ps says plainly is a reading, and a gate won't pass on what it couldn't read")
} finally {
  process.env.PATH = realPath
  rmSync(folder, { recursive: true, force: true })
}
