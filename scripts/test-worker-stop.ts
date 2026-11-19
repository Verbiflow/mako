import assert from "node:assert/strict"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { StoppableWorker } from "@mako/host/base/worker-stop"

/*
 * A worker the host stops ends itself (`StoppableWorker`, `exitWhenStopped`). `terminate()` landing between a zlib
 * handle's construction and its `init` aborts the whole process in Node 24 (nodejs/node#67485): the attribution
 * reader, closed while it decompressed stored content, took the test process down that way. Workers busy in zstd are
 * stopped here many times; one terminate in the wrong place would end this process with SIGABRT.
 */

// Beside the scripts, so each worker resolves the host's packages as they do.
const entry = (name: string, body: string) => {
  const path = join(import.meta.dirname, `.worker-stop-${name}-${process.pid}.ts`)
  writeFileSync(path, body)
  return path
}
const busy = entry("zstd", `
import { parentPort } from "node:worker_threads"
import { zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { exitWhenStopped } from "@mako/host/base/worker-stop"
exitWhenStopped()
const frame = zstdCompressSync(Buffer.alloc(256, 7))
const loop = () => { for (let i = 0; i < 500; i++) zstdDecompressSync(frame); setImmediate(loop) }
parentPort?.postMessage("busy")
loop()
`)
const deaf = entry("deaf", `
import { parentPort } from "node:worker_threads"
parentPort?.postMessage("busy")
const loop = () => setImmediate(loop)
loop()
`)

const started = async (worker: StoppableWorker) => {
  await new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject) })
}

test.after(() => {
  rmSync(busy, { force: true })
  rmSync(deaf, { force: true })
})

test("a worker stopped while it decompresses zstd ends itself, never terminated", async () => {
  for (let trial = 0; trial < 30; trial++) {
    const worker = new StoppableWorker(pathToFileURL(busy))
    let terminated = 0
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => { terminated++; return terminate() }
    await started(worker)
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 20))
    assert.equal(await worker.stop(), 0, "the worker exits from its own JS")
    assert.equal(terminated, 0, "a worker that ends itself is never terminated")
  }
})

test("a worker that never listens for its stop is terminated past the grace", async () => {
  const worker = new StoppableWorker(pathToFileURL(deaf))
  await started(worker)
  const at = performance.now()
  assert.equal(await worker.stop(100), 1, "terminate() ends a worker with code 1")
  assert.ok(performance.now() - at >= 90, "the worker had its grace first")
})

test("repeated stops share one exit, and a stop after the exit resolves with its code", async () => {
  const worker = new StoppableWorker(pathToFileURL(busy))
  await started(worker)
  const stopping = worker.stop()
  assert.equal(worker.stop(), stopping)
  assert.equal(await stopping, 0)
  // Terminated outright: the one that does no zlib.
  const ended = new StoppableWorker(pathToFileURL(deaf))
  await started(ended)
  const exited = new Promise((resolve) => ended.once("exit", resolve))
  await ended.terminate()
  await exited
  assert.equal(await ended.stop(), 1)
})
