import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { claudeCloudSignIn } from "@mako/host/harnesses/claude/accounts"
import { grokCloudSignIn } from "@mako/host/harnesses/grok/accounts"
import { chainFingerprint } from "@mako/host/harnesses/cloud-sign-in"
import { scriptedModel } from "./scripted-model.js"

/**
 * The refresh lock on the real CLIs: a harness whose sign-in lapsed while the Mac slept refreshes as it starts. Mako
 * holds the harness's own refresh lock (as `CloudSignInSync.wake` does), writes the pair Mako Cloud refreshed, and
 * lets go. The harness, waiting on the lock as on another of its own processes, reads its store again and runs on the
 * new pair: the stand-in model hears the new access token and never the old one, and the store keeps the new pair, so
 * no refresh was made. Claude Code as Mako ships it, and the Grok on this Mac (`GROK_BIN` for another), each in a
 * scratch home with a stand-in model and made-up tokens: no account is used.
 *
 *   npx tsx scripts/prove-refresh-lock.ts [claude] [grok]
 */
const CLAUDE = join(import.meta.dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude")
const GROK = process.env.GROK_BIN ?? join(homedir(), ".grok", "bin", "grok")
const which = process.argv.slice(2)
const runs = (harness: string) => !which.length || which.includes(harness)

/** Runs `command` to its end, timed from `began`. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, began: number) {
  return new Promise<{ code: number | null; out: string; err: string; ms: number }>((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk: Buffer) => (out += chunk))
    child.stderr.on("data", (chunk: Buffer) => (err += chunk))
    const limit = setTimeout(() => child.kill(), 60_000)
    child.on("exit", (code) => {
      clearTimeout(limit)
      resolve({ code, out, err, ms: performance.now() - began })
    })
  })
}

if (runs("claude")) await proveClaude()
if (runs("grok")) await proveGrok()

async function proveClaude() {
const home = await mkdtemp(join(tmpdir(), "mako-refresh-lock-"))
const model = await scriptedModel({ reply: () => ({ text: "ok" }), aside: "ok" })
try {
  const config = join(home, ".claude")
  await mkdir(config, { recursive: true, mode: 0o700 })
  const scopes = ["user:inference", "user:profile", "user:sessions:claude_code"]
  const lapsed = { accessToken: "sk-ant-oat01-slept", refreshToken: "sk-ant-ort01-slept", expiresAt: Date.now() - 60_000, scopes, subscriptionType: "max" }
  await writeFile(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: lapsed }), { mode: 0o600 })
  await writeFile(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { accountUuid: "a-1", emailAddress: "ada@example.invalid" } }))
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USER: process.env.USER,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: model.url,
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }
  const cloudPair = { accessToken: "sk-ant-oat01-cloud", refreshToken: "sk-ant-ort01-cloud", expiresAt: Date.now() + 8 * 3_600_000, scopes, subscriptionType: "max" }
  const began = performance.now()
  let claude: Promise<{ code: number | null; out: string; err: string; ms: number }> | undefined
  let wrote = 0
  const held = await claudeCloudSignIn.mirror!.hold!(env, async () => {
    // Claude starts with its sign-in lapsed, as after a night, and wants to refresh before its first request.
    claude = run(CLAUDE, ["-p", "Reply with the word ok."], home, env, began)
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    assert.deepEqual(model.bearers, [], "nothing reaches the model while Claude waits on its lock")
    // The pair Mako Cloud refreshed, written as the wake writes it: over the pair Claude holds, the lock already held.
    assert.equal(await claudeCloudSignIn.mirror!.write(env, { label: null, payload: { oauth: cloudPair, account: null } }, chainFingerprint(lapsed.refreshToken), true), true)
    wrote = performance.now() - began
    return true
  }, 2_000)
  assert.equal(held, true, "Mako held Claude's refresh lock")
  const ran = await claude!
  const stored = JSON.parse(await readFile(join(config, ".credentials.json"), "utf8")).claudeAiOauth
  console.log(`claude exited ${ran.code} after ${(ran.ms / 1000).toFixed(1)} s; Mako wrote the cloud's pair at ${(wrote / 1000).toFixed(1)} s and let go`)
  console.log(`the model heard: ${[...new Set(model.bearers)].join(", ") || "nothing"}`)
  assert.ok(model.bearers.length > 0, `Claude ran: ${ran.err.slice(-300)}`)
  assert.ok(model.bearers.every((bearer) => bearer === cloudPair.accessToken), "every request carried the cloud's access token, none the lapsed one")
  assert.equal(stored.refreshToken, cloudPair.refreshToken, "the store keeps the cloud's pair: Claude refreshed nothing")
  assert.match(ran.out, /ok/i)
  console.log("ok  the real Claude Code waits on its refresh lock while Mako writes the cloud's pair, then runs on that pair without refreshing")
} finally {
  await model.close()
  await rm(home, { recursive: true, force: true })
}
}

async function proveGrok() {
  const home = await mkdtemp(join(tmpdir(), "mako-refresh-lock-"))
  const model = await scriptedModel({
    answers: new Map([["/v1/models", JSON.stringify({ object: "list", data: [{ id: "grok-4.6", object: "model", name: "Grok", context_window: 256_000 }] })]]),
    reply: () => ({ text: "ok" }),
    aside: "ok",
  })
  try {
    const grokHome = join(home, ".grok")
    await mkdir(grokHome, { recursive: true, mode: 0o700 })
    // Shaped as `grok login` writes it, under Grok's own client.
    const client = "b1a00492-073a-47ea-816f-4c329264a828"
    const entry = {
      auth_mode: "oidc",
      email: "ada@example.invalid",
      first_name: "Ada",
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: client,
      principal_id: "u-1",
      principal_type: "User",
      user_id: "u-1",
      team_id: "t-1",
      create_time: new Date(Date.now() - 86_400_000).toISOString(),
      coding_data_retention_opt_out: true,
    }
    const id = `https://auth.x.ai::${client}`
    const lapsed = { ...entry, key: "grok-key-slept", refresh_token: "grok-refresh-slept", expires_at: new Date(Date.now() - 60_000).toISOString() }
    await writeFile(join(grokHome, "auth.json"), JSON.stringify({ [id]: lapsed }), { mode: 0o600 })
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USER: process.env.USER,
      GROK_HOME: grokHome,
      GROK_XAI_API_BASE_URL: `${model.url}/v1`,
      GROK_CLI_CHAT_PROXY_BASE_URL: `${model.url}/v1`,
      GROK_MODELS_BASE_URL: `${model.url}/v1`,
    }
    const cloudPair = { ...entry, key: "grok-key-cloud", refresh_token: "grok-refresh-cloud", expires_at: new Date(Date.now() + 6 * 3_600_000).toISOString() }
    const began = performance.now()
    let grok: ReturnType<typeof run> | undefined
    let wrote = 0
    const held = await grokCloudSignIn.mirror!.hold!(env, async () => {
      grok = run(GROK, ["-p", "Reply with the word ok."], home, env, began)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      assert.deepEqual(model.bearers.filter((bearer) => bearer.startsWith("grok-key")), [], "nothing reaches the model on a lapsed key while Grok waits on its lock")
      assert.equal(await grokCloudSignIn.mirror!.write(env, { label: null, payload: { auth: { [id]: cloudPair } } }, chainFingerprint(lapsed.refresh_token), true), true)
      wrote = performance.now() - began
      return true
    }, 2_000)
    assert.equal(held, true, "Mako held Grok's refresh lock")
    const ran = await grok!
    const stored = JSON.parse(await readFile(join(grokHome, "auth.json"), "utf8"))[id]
    const keys = [...new Set(model.bearers.filter((bearer) => bearer.startsWith("grok-key")))]
    console.log(`grok exited ${ran.code} after ${(ran.ms / 1000).toFixed(1)} s; Mako wrote the cloud's pair at ${(wrote / 1000).toFixed(1)} s and let go`)
    console.log(`the model heard: ${keys.join(", ") || "nothing"}`)
    assert.ok(keys.length > 0, `Grok ran: ${ran.err.slice(-400)}`)
    assert.deepEqual(keys, [cloudPair.key], "every request carried the cloud's key, none the lapsed one")
    assert.equal(stored.refresh_token, cloudPair.refresh_token, "the store keeps the cloud's pair: Grok refreshed nothing")
    console.log("ok  the real Grok waits on its refresh lock while Mako writes the cloud's pair, then runs on that pair without refreshing")
  } finally {
    await model.close()
    await rm(home, { recursive: true, force: true })
  }
}
