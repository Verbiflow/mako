import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { claudeProcessProbeFor } from "@mako/host/harnesses/claude/process-probe"
import { grokProcessProbe } from "@mako/host/harnesses/grok/process-probe"
import { createCodexProcessProbe } from "@mako/host/harnesses/codex/process-probe"
import { cursorProcessProbe } from "@mako/host/harnesses/cursor/process-probe"
import { fileResumeEvidence, resumeVerdict } from "@mako/host/harnesses/native-continuation"

const codexProcessProbe = createCodexProcessProbe()
const run = promisify(execFile)

/** `/bin/sleep` under another name. macOS kills a copy whose signature no longer matches within a second, so it's signed again here. */
async function standIn(path: string): Promise<void> {
  await copyFile("/bin/sleep", path)
  if (process.platform === "darwin") await run("codesign", ["--sign", "-", "--force", path])
}

const root = await mkdtemp(join(tmpdir(), "mako-probe-scope-"))
const id = "recovery-scope-fixture"
let child: ReturnType<typeof spawn> | undefined
try {
  const profile = join(root, "custom-claude-account")
  await mkdir(join(profile, "sessions"), { recursive: true })
  const path = join(profile, "projects", "workspace", `${id}.jsonl`)
  await mkdir(join(profile, "projects", "workspace"), { recursive: true })
  await writeFile(path, "fixture source")
  await writeFile(join(profile, "sessions", "active.json"), JSON.stringify({ sessionId: id, pid: process.pid, state: "working" }))
  const binding = { id, provider: "claude", nativeId: id, path, coveredBlocks: 0, includesBase: false }
  const probe = claudeProcessProbeFor(join(root, "unrelated-default-home"))
  assert.equal((await resumeVerdict(binding, probe)).kind, "held", "custom-account registry owns its source even when the default registry is absent")
  await writeFile(join(profile, "sessions", "active.json"), JSON.stringify({ pid: process.pid }))
  assert.equal((await resumeVerdict(binding, probe)).kind, "unavailable", "an unidentifiable live record is incomplete evidence, not an empty registry")
  await writeFile(join(profile, "sessions", "active.json"), JSON.stringify({ sessionId: id, pid: process.pid, state: "working" }))
  // A record listed and then removed, as Claude Code removes its own as it exits, is a process that ended.
  await symlink(join(profile, "sessions", "removed-since-listing"), join(profile, "sessions", "ended.json"))
  assert.equal((await resumeVerdict(binding, probe)).kind, "held", "a record gone since the listing doesn't hide the live one")
  await rm(join(profile, "sessions", "ended.json"))
  await writeFile(join(profile, "sessions", "exited.json"), JSON.stringify({ sessionId: "another-session", pid: 2 ** 22 - 3, state: "working", startedAt: Date.now() }))
  assert.equal((await resumeVerdict(binding, probe)).kind, "held", "a record of a process that's gone is skipped")
  await rm(join(profile, "sessions", "exited.json"))
  await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(join(profile, "sessions", `extra-${index}`), "")))
  assert.equal((await resumeVerdict(binding, probe)).kind, "unavailable", "a truncated registry cannot establish an empty ownership inventory")

  const grok = join(root, "custom-grok-store")
  const grokPath = join(grok, "sessions", "workspace", id, "updates.jsonl")
  await mkdir(join(grok, "sessions", "workspace", id), { recursive: true })
  await writeFile(grokPath, "fixture source")
  await writeFile(join(grok, "active_sessions.json"), JSON.stringify([{ session_id: id, pid: process.pid }]))
  assert.equal((await resumeVerdict({ ...binding, provider: "grok", path: grokPath }, grokProcessProbe)).kind, "held", "admission uses the source store rather than the current GROK_HOME")
  await writeFile(join(grok, "active_sessions.json"), JSON.stringify([{ pid: process.pid }]))
  assert.equal((await resumeVerdict({ ...binding, provider: "grok", path: grokPath }, grokProcessProbe)).kind, "unavailable", "an unidentified Grok owner cannot establish an empty store")

  if (process.platform !== "win32") {
    const codexPath = join(root, "custom-codex-home", "sessions", `${id}.jsonl`)
    await mkdir(join(root, "custom-codex-home", "sessions"), { recursive: true })
    await writeFile(codexPath, '{"type":"event_msg","payload":{"type":"task_started"}}\n')
    child = spawn(process.execPath, ["-e", "process.title='codex';require('node:fs').openSync(process.argv[1],'r');console.log('ready');setInterval(()=>{},1000)", codexPath], { stdio: ["ignore", "pipe", "pipe"] })
    await once(child.stdout!, "data")
    assert.equal((await resumeVerdict({ ...binding, provider: "codex", path: codexPath }, codexProcessProbe)).kind, "held", "custom CODEX_HOME cannot evade the open-source ownership scan")
    child.kill("SIGTERM")
    await once(child, "exit")
    const cursorPath = join(root, "custom-cursor-sdk", "agents", "agent-fixture", "store.db")
    await mkdir(join(root, "custom-cursor-sdk", "agents", "agent-fixture"), { recursive: true })
    await writeFile(cursorPath, "fixture store")
    child = spawn(process.execPath, ["-e", "process.title='renamed-sdk';require('node:fs').openSync(process.argv[1],'r');console.log('ready');setInterval(()=>{},1000)", cursorPath], { stdio: ["ignore", "pipe", "pipe"] })
    await once(child.stdout!, "data")
    assert.equal((await resumeVerdict({ ...binding, provider: "cursor", path: cursorPath }, cursorProcessProbe)).kind, "held", "SDK stores outside cursor-agent roots cannot evade source-scoped ownership observation")
    child.kill("SIGTERM")
    await once(child, "exit")
    await writeFile(join(grok, "active_sessions.json"), "[]")
    const unrelated = join(root, "Grok Bot")
    await standIn(unrelated)
    child = spawn(unrelated, ["300"], { stdio: "ignore" })
    await once(child, "spawn")
    assert.equal((await resumeVerdict({ ...binding, provider: "grok", path: grokPath }, grokProcessProbe)).kind, "resumable", "an unrelated Grok Bot prefix match is not a CLI owner")
    child.kill("SIGTERM")
    await once(child, "exit")
    const grokExecutable = join(root, "grok-native")
    await standIn(grokExecutable)
    child = spawn(grokExecutable, ["300"], { stdio: "ignore", detached: true })
    const spawnedAt = Date.now()
    await once(child, "spawn")
    assert.equal((await resumeVerdict({ ...binding, provider: "grok", path: grokPath }, grokProcessProbe)).kind, "unavailable", "an unregistered live Grok process cannot be cleared by an empty registry")
    // An agent a Mako host recorded with the session it holds (`readMakoProcesses`), as another host's discovery is:
    // another session's or none isn't an unknown owner, the target's holds it, and a pid now running something else isn't it.
    const grokBinding = { ...binding, provider: "grok", path: grokPath }
    const recorded = (pid: number, session: string | null, startedAt = spawnedAt) => () => new Map([[pid, { session, startedAt, observed: false, host: process.pid }]])
    const inspect = (mako: ReturnType<typeof recorded>) => fileResumeEvidence(grokProcessProbe).inspect(grokBinding, mako)
    assert.equal((await inspect(recorded(child.pid!, "another-session"))).kind, "available", "a Mako host's agent on another session doesn't hide whether the target is free")
    assert.equal((await inspect(recorded(child.pid!, null))).kind, "available", "a Mako host's discovery holds no session")
    assert.equal((await inspect(recorded(child.pid!, id))).kind, "held", "a Mako host's agent on the target holds it")
    assert.equal((await inspect(recorded(child.pid!, null, spawnedAt - 3_600_000))).kind, "unavailable", "a recorded pid that now runs a process born otherwise isn't the recorded one")
    assert.equal((await inspect(recorded(child.pid! + 1, null))).kind, "unavailable", "a Grok process no Mako host recorded is still unknown")
    child.kill("SIGTERM")
    await once(child, "exit")
    // A native binary under its wrapper: placed by the wrapper's record, which leads the process group Mako started.
    child = spawn("/bin/sh", ["-c", '"$0" 300; :', grokExecutable], { stdio: "ignore", detached: true })
    const wrapperAt = Date.now()
    await once(child, "spawn")
    const wrapper = child.pid!
    assert.equal((await inspect(recorded(wrapper, "another-session", wrapperAt))).kind, "available", "the native binary is placed by its wrapper's record")
    process.kill(-wrapper, "SIGTERM")
    await once(child, "exit")
  }
  console.log("Recovery probe scope: custom Claude/Grok/Codex/Cursor sources and incomplete inventory refusal verified; process stand-in only, no native model prompt")
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM")
    await once(child, "exit")
  }
  await rm(root, { recursive: true, force: true })
}
