import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { claudeProcessProbeFor } from "../electron/providers/claude/process-probe.ts"
import { grokProcessProbe } from "../electron/providers/grok/process-probe.ts"
import { codexProcessProbe } from "../electron/providers/codex/process-probe.ts"
import { resumeVerdict } from "../electron/native-continuation.ts"

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
  }
  console.log("Recovery probe scope: custom Claude/Grok/Codex sources and incomplete inventory refusal verified; process stand-in only, no native model prompt")
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    await once(child, "exit")
  }
  await rm(root, { recursive: true, force: true })
}
