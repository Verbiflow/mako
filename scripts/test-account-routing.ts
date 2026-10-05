import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { mock } from "node:test"
import {
  accountDir,
  accountsRoot,
  readSelection,
  writeSelection,
} from "../electron/accounts-common.js"
import { codexAccountCapability } from "../electron/providers/codex/accounts.js"
import { openCodeAccountCapability } from "../electron/providers/opencode/accounts.js"
import { claudeAccountCapability } from "../electron/providers/claude/accounts.js"

const sandbox = await mkdtemp(join(os.tmpdir(), "mako-account-routing-"))
mock.method(os, "homedir", () => sandbox)
syncBuiltinESMExports()
try {
  for (const capability of [codexAccountCapability, claudeAccountCapability]) {
    const base = {
      OPENAI_API_KEY: "fixture",
      ANTHROPIC_API_KEY: "fixture",
      CLAUDE_CONFIG_DIR: "/elsewhere",
      CODEX_HOME: "/elsewhere",
      PATH: "/fixture",
    }
    const overrides = capability.provider === "codex"
      ? ["OPENAI_API_KEY", "CODEX_HOME"]
      : ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]
    const ordinary = Object.fromEntries(Object.entries(base).filter(([key]) => !overrides.includes(key)))
    assert.deepEqual(await capability.accountEnv(null, base), ordinary, "the default is the CLI's ordinary login, whatever the shell exported")
    await assert.rejects(
      capability.accountEnv("missing", base),
      /selected.*account/i
    )
    for (const invalid of ["../escape", "/absolute", "..", "a/b", "a\\b"])
      assert.throws(
        () => accountDir(capability.provider, invalid),
        /Invalid account name/
      )
    const directory = accountDir(capability.provider, "saved")
    await mkdir(directory, { recursive: true })
    const marker = join(directory, "existing-identity")
    await writeFile(marker, "preserve")
    assert.ok(capability.captureAccount, `${capability.provider} captures accounts`)
    await assert.rejects(capability.captureAccount("saved"), /EEXIST/)
    assert.equal(await readFile(marker, "utf8"), "preserve")
  }
  const codexDir = accountDir("codex", "ready")
  await mkdir(codexDir, { recursive: true })
  await writeFile(
    join(codexDir, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "fixture" })
  )
  const realCodex = join(sandbox, ".codex")
  await mkdir(join(realCodex, "sessions"), { recursive: true })
  for (const name of ["state_5.sqlite", "models_cache.json", "auth.json.bak"])
    await writeFile(join(realCodex, name), "")
  const nameLine = (id: string, name: string, at: string) =>
    JSON.stringify({ id, thread_name: name, updated_at: at })
  const sharedLog = [
    nameLine("a", "shared older", "2026-09-28T10:00:00.5Z"),
    nameLine("c", "shared newer", "2026-09-28T10:00:00.5Z"),
  ]
  await writeFile(join(realCodex, "session_index.jsonl"), `${sharedLog.join("\n")}\n`)
  const ownLog = [
    nameLine("a", "own newer", "2026-09-28T10:00:00.51Z"),
    nameLine("b", "own only", "2026-09-28T09:00:00Z"),
    nameLine("c", "own older", "2026-09-28T10:00:00.41Z"),
  ]
  await writeFile(join(codexDir, "session_index.jsonl"), `${ownLog.join("\n")}\n`)
  const ownArchive = join(codexDir, "archived_sessions")
  await mkdir(ownArchive)
  await writeFile(join(ownArchive, "rollout-own.jsonl"), "{}\n")
  const codexEnv = await codexAccountCapability.accountEnv("ready", {
    OPENAI_API_KEY: "other",
    CODEX_HOME: join(sandbox, "elsewhere"),
  })
  assert.deepEqual(codexEnv, { CODEX_HOME: codexDir })
  for (const name of [
    "sessions",
    "archived_sessions",
    "session_index.jsonl",
    "state_5.sqlite",
  ])
    assert.equal(
      await realpath(join(codexDir, name)),
      await realpath(join(realCodex, name)),
      `${name} is shared`
    )
  for (const name of ["models_cache.json", "auth.json.bak"])
    assert.equal(existsSync(join(codexDir, name)), false, `${name} stays private`)
  assert.equal(
    await readFile(join(realCodex, "archived_sessions", "rollout-own.jsonl"), "utf8"),
    "{}\n"
  )
  assert.equal(
    await readFile(join(realCodex, "session_index.jsonl"), "utf8"),
    `${[...sharedLog, ownLog[0], ownLog[1]].join("\n")}\n`
  )
  await codexAccountCapability.accountEnv("ready", {})
  assert.equal(
    (await readFile(join(realCodex, "session_index.jsonl"), "utf8")).split("\n").length,
    5,
    "adopting again adds nothing"
  )
  await assert.rejects(
    codexAccountCapability.accountEnv("saved", {}),
    /signed out\. Sign in again/
  )
  await writeFile(join(codexDir, "auth.json"), "{}")
  await assert.rejects(
    codexAccountCapability.accountEnv("ready", {}),
    /login is unreadable\. Sign in again/
  )
  const claudeDir = accountDir("claude", "ready")
  await mkdir(claudeDir, { recursive: true })
  await writeFile(join(claudeDir, ".credentials.json"), "{}")
  await assert.rejects(
    claudeAccountCapability.accountEnv("ready", {}),
    /signed out\. Sign in again/
  )
  await writeFile(
    join(claudeDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fixture" } })
  )
  assert.deepEqual(
    await claudeAccountCapability.accountEnv("ready", {
      ANTHROPIC_API_KEY: "other",
    }),
    { CLAUDE_CONFIG_DIR: claudeDir }
  )
  await Promise.all([
    writeSelection("codex", "ready"),
    writeSelection("claude", "saved"),
  ])
  assert.equal(await readSelection("codex"), "ready")
  assert.equal(await readSelection("claude"), "saved")
  await writeFile(join(accountsRoot(), "selection", "codex.json"), "broken")
  await assert.rejects(readSelection("codex"), /selection is invalid/)
  await writeSelection("codex", null)
  assert.equal(await readSelection("codex"), null)
  const savedHomes = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  }
  try {
    process.env.CODEX_HOME = codexDir
    process.env.CLAUDE_CONFIG_DIR = claudeDir
    process.env.XDG_DATA_HOME = join(sandbox, "xdg")
    await mkdir(join(process.env.XDG_DATA_HOME, "opencode"), {
      recursive: true,
    })
    await writeFile(
      join(process.env.XDG_DATA_HOME, "opencode", "auth.json"),
      JSON.stringify({ fixture: { type: "api", key: "fixture" } })
    )
    assert.equal(
      (await codexAccountCapability.listAccounts(null)).find(
        (account) => account.name === "default"
      )?.dir,
      realCodex,
      "an exported CODEX_HOME does not move the default account"
    )
    assert.equal(
      (await claudeAccountCapability.listAccounts(null)).find(
        (account) => account.name === "default"
      )?.dir,
      join(sandbox, ".claude"),
      "an exported CLAUDE_CONFIG_DIR does not move the default account"
    )
    assert.equal(
      (await openCodeAccountCapability.listAccounts(null))[0]?.providerId,
      "fixture"
    )
    for (const capability of [
      codexAccountCapability,
      claudeAccountCapability,
      openCodeAccountCapability,
    ]) {
      assert.ok(capability.label)
      assert.ok(capability.loginCommand)
    }
  } finally {
    for (const [key, value] of Object.entries(savedHomes)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  console.log(
    "Account routing rejects missing identities and traversal, keeps the default on the CLI's ordinary login, preserves existing captures, and shares a Codex account's archive, names and state with the real home"
  )
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
  await rm(sandbox, { recursive: true, force: true })
}
