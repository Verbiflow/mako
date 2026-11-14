import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { allowed, containerExec, localExec, markerOn, rejected, type Exec } from "./lib/placed-proof-evidence.ts"

/**
 * The placed Fins proof's evidence that a command ran, or didn't, on the device: a search that found the marker, one
 * that completed and found nothing, or one that failed. The reject step must fail on a failed search, as when the
 * container it reads can't be reached, which once read as "nothing ran".
 */
const root = mkdtempSync(join(tmpdir(), "mako-proof-evidence-"))

test("a marker found holds the command's word; a search that completes and finds nothing is absence", async () => {
  const data = join(root, "data", "worktrees", "hello-world", "proof")
  mkdirSync(data, { recursive: true })
  assert.deepEqual(await markerOn(localExec, join(root, "data"), ".mako-proof-HOTEL"), { kind: "absent" })
  assert.deepEqual(rejected(await markerOn(localExec, join(root, "data"), ".mako-proof-HOTEL")), { ok: true })
  writeFileSync(join(data, ".mako-proof-HOTEL"), "HOTEL\n")
  const found = await markerOn(localExec, join(root, "data"), ".mako-proof-HOTEL")
  assert.deepEqual(found, { kind: "found", holds: "HOTEL" })
  assert.deepEqual(allowed(found, "HOTEL"), { ok: true })
  assert.equal(allowed(found, "INDIA").ok, false, "another word isn't the command's")
  assert.equal(rejected(found).ok, false, "a marker found fails a rejection")
})

test("a search that can't look fails both steps: find under a root that isn't there", async () => {
  const searched = await markerOn(localExec, join(root, "no-such-root"), ".mako-proof-HOTEL")
  assert.equal(searched.kind, "failed", JSON.stringify(searched))
  assert.equal(allowed(searched, "HOTEL").ok, false)
  assert.equal(rejected(searched).ok, false, "a failed search proves no rejection")
})

test("a planted failing exec, as docker exec into a container that doesn't exist, fails the reject step", async () => {
  // What `docker exec no-such-container find …` answers: status 1 and the daemon's words, nothing on stdout.
  const planted: Exec = async (command, args) => {
    assert.equal(command, "docker")
    assert.deepEqual(args.slice(0, 2), ["exec", "no-such-container"])
    return { status: 1, stdout: "", stderr: "Error response from daemon: No such container: no-such-container\n" }
  }
  const searched = await markerOn(containerExec("no-such-container", planted), "/data", ".mako-proof-INDIA")
  assert.equal(searched.kind, "failed")
  assert.match(searched.kind === "failed" ? searched.why : "", /No such container/)
  const verdict = rejected(searched)
  assert.equal(verdict.ok, false, "the reject step fails when the container couldn't be searched")
  assert.match(verdict.ok ? "" : verdict.why, /couldn't be searched/)
  // And a container that exists but holds no marker: `find` completes with nothing, which is a rejection proven.
  const empty: Exec = async () => ({ status: 0, stdout: "", stderr: "" })
  assert.deepEqual(rejected(await markerOn(containerExec("a-container", empty), "/data", ".mako-proof-INDIA")), { ok: true })
})

test("a spawn that fails is a failed search too", async () => {
  const searched = await markerOn(localExec, root, ".mako-proof-HOTEL").then(() => markerOn(async () => ({ status: null, stdout: "", stderr: "spawn docker ENOENT" }), "/data", "x"))
  assert.equal(searched.kind, "failed")
  assert.equal(rejected(searched).ok, false)
})

process.on("exit", () => rmSync(root, { recursive: true, force: true }))
