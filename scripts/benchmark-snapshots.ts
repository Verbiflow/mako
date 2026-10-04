import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { WorkspaceSnapshots } from "../electron/workspace-snapshots.js"
import { snapshotPayloadBytes } from "../electron/workspace-snapshot-git.js"

const root = await mkdtemp(join(tmpdir(), "mako-snapshot-benchmark-"))
const results = []
for (const files of [100, 5000]) {
  const cwd = join(root, `workspace-${files}`)
  const storage = join(root, `snapshots-${files}`)
  await mkdir(cwd)
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
      { cwd, encoding: "utf8" }
    ).trim()
  const contents = (index: number) =>
    `Snapshot benchmark file ${index}\n${"content\n".repeat(128)}`
  for (let offset = 0; offset < files; offset += 64)
    await Promise.all(
      Array.from({ length: Math.min(64, files - offset) }, (_, index) =>
        writeFile(join(cwd, `${offset + index}.txt`), contents(offset + index))
      )
    )
  git("init", "-q")
  git("add", ".")
  git("commit", "-qm", "fixture")
  const store = new WorkspaceSnapshots(storage)
  try {
    let started = performance.now()
    const before = await store.capture(cwd)
    const coldCaptureMs = performance.now() - started
    await writeFile(join(cwd, "0.txt"), "changed")
    started = performance.now()
    await store.capture(cwd)
    const warmCaptureMs = performance.now() - started
    started = performance.now()
    const preview = await store.preview(before.id)
    const previewMs = performance.now() - started
    started = performance.now()
    await store.restore(
      {
        sourceId: randomUUID(),
        targetId: before.id,
        expectedId: preview.current.id,
        fork: {
          id: randomUUID(),
          provider: "benchmark",
          point: { kind: "run", requestId: randomUUID() },
        },
      },
      () => {}
    )
    const restoreMs = performance.now() - started
    assert.equal(await readFile(join(cwd, "0.txt"), "utf8"), contents(0))
    assert.equal(git("diff", "--cached", "--name-only"), "")
    let retainedBytes = 0
    for (const id of await readdir(storage)) {
      if (/^[a-f0-9-]{36}$/.test(id))
        retainedBytes += await snapshotPayloadBytes(join(storage, id))
    }
    results.push({
      files,
      coldCaptureMs,
      warmCaptureMs,
      previewMs,
      restoreMs,
      retainedBytes,
    })
  } finally {
    store.close()
    await rm(cwd, { recursive: true, force: true })
    await rm(storage, { recursive: true, force: true })
  }
}
await writeFile(
  join(root, "results.json"),
  JSON.stringify({ results }, null, 2)
)
console.log(JSON.stringify(results, null, 2))
console.log(`Snapshot benchmark: ${join(root, "results.json")}`)
