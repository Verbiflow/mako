import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir, userInfo } from "node:os"
import { dirname, join, relative } from "node:path"
import { createInterface } from "node:readline"
import { PackagedApp } from "./lib/packaged-app.mjs"
import { run as runHarness } from "./native-harnesses.ts"
import { SECRET_FILES, assertScratchEnvironment, readPersonSignIns, scratchHostHome, scratchInstall, seedScratchHome, sweepScratchHomes } from "./scratch-harness-home.ts"

/**
 * No proof or test runs a real harness in the person's own home. A harness
 * run there writes its sessions into their stores (`~/.claude`, `~/.codex`
 * and the like), which their own Mako lists and keeps copies of: removing the
 * files afterwards leaves the rows in their sidebar. So every one runs in a
 * scratch home (`scratch-harness-home.ts`), and this holds them to it:
 *
 * - installs: `scratchInstall` is the one way a proof runs an installer, and
 *   refuses an environment whose `HOME`, or any folder a harness or npm writes
 *   under, is theirs; every proof script's installer goes through it;
 * - the scratch home itself: access-only credentials, nothing inherited that
 *   points a harness elsewhere, the person's CLIs on `PATH`, and on macOS a
 *   keychain of its own that leaves theirs untouched;
 * - the copies' lifetime: each 0600 in 0700 folders, never in a Git checkout,
 *   gone when the run that made them ends (normally, or by SIGTERM), and a
 *   killed run's swept by the next, which says so without their contents;
 * - the shared drivers refuse the person's home before spawning:
 *   `PackagedApp` and `native-harnesses.ts`'s `run`;
 * - every script that starts a harness session in a host or app it spawns, or
 *   through the Agent SDK, gives it a scratch or sealed home; one that spawns a
 *   harness CLI does too; and none drives this Mac's own Mako, unless it's
 *   named below with the reason no real harness runs there.
 */

const real = homedir()
const root = await mkdtemp(join(tmpdir(), "mako-scratch-home-"))
try {
  const home = join(root, "home")
  const scratch = { PATH: process.env["PATH"] ?? "", HOME: home, GROK_HOME: join(home, ".grok"), CODEX_HOME: join(home, ".codex") }

  // Refused: no environment (the process's own), none naming HOME, the person's home, one holding it, a harness folder outside the scratch home.
  const refusals: [string, NodeJS.ProcessEnv | undefined, RegExp][] = [
    ["the process's own environment", undefined, /this process's environment/],
    ["no HOME", { PATH: scratch.PATH }, /names no HOME/],
    ["the person's HOME", { ...process.env, HOME: real }, /person's own home or holds it/],
    ["a HOME holding theirs", { ...scratch, HOME: "/" }, /person's own home or holds it/],
    ["GROK_HOME in the person's home", { ...scratch, GROK_HOME: join(real, ".grok") }, /GROK_HOME .* is outside its scratch home/],
    ["an npm prefix in the person's home", { ...scratch, npm_config_prefix: join(real, ".npm-global") }, /npm_config_prefix .* is outside its scratch home/],
  ]
  for (const [name, env, says] of refusals) assert.throws(() => assertScratchEnvironment(env, "npm install @xai-official/grok", real), says, name)
  assertScratchEnvironment(scratch, "npm install @xai-official/grok", real)
  // npm's cache may stay the person's: it's npm's, content-addressed, and no harness reads it.
  assertScratchEnvironment({ ...scratch, npm_config_cache: join(real, ".npm") }, "npm install", real)

  // A refused install spawns nothing: the command would leave a mark.
  const mark = join(root, "ran")
  const marking = ["-e", "require('node:fs').writeFileSync(process.argv[1], process.env.HOME)", mark]
  await assert.rejects(scratchInstall(process.execPath, marking, { env: { ...process.env, HOME: real } }, real), /person's own home/)
  assert.equal(existsSync(mark), false, "nothing ran with the person's home")
  await assert.rejects(scratchInstall(process.execPath, marking, { env: undefined }, real), /this process's environment/)
  assert.equal(existsSync(mark), false, "nothing ran with the process's own environment")
  await scratchInstall(process.execPath, marking, { env: scratch }, real)
  assert.equal(readFileSync(mark, "utf8"), home, "in its scratch home it runs, with that home")

  // Every proof's installer goes through `scratchInstall`: no proof spawns a package manager or an install script itself.
  const scripts = join(import.meta.dirname)
  const installer = /\brun\(\s*["'](?:npm|npx|pnpm|bun|brew)["']|execFile(?:Sync)?\(\s*["'](?:npm|npx|pnpm|bun|brew)["']|spawn(?:Sync)?\(\s*["'](?:npm|npx|pnpm|bun|brew)["']|curl [^"']*\| *(?:ba)?sh|npmInstall\(|scriptInstall\(|\.install\(\s*["']/
  const proofs = readdirSync(scripts).filter((name) => /^prove-.*\.ts$/.test(name) || name === "native-harnesses.ts")
  assert.ok(proofs.length >= 3, `the proofs are found (${proofs.join(", ")})`)
  for (const name of proofs) {
    readFileSync(join(scripts, name), "utf8").split("\n").forEach((line, index) => {
      if (installer.test(line) && !line.includes("scratchInstall(")) assert.fail(`${name}:${index + 1} runs an installer outside scratchInstall: ${line.trim()}`)
    })
  }

  // The scratch home, for a person of the test's own: their home holds sign-ins, and this shell points harnesses at it.
  const person = join(root, "person")
  const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.x`
  const hour = Math.floor(Date.now() / 1000) + 3600
  mkdirSync(join(person, ".codex"), { recursive: true })
  writeFileSync(join(person, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: jwt(hour), access_token: jwt(hour), refresh_token: "codex-refresh", account_id: "account" } }))
  mkdirSync(join(person, ".grok"), { recursive: true })
  writeFileSync(join(person, ".grok", "auth.json"), JSON.stringify({ xai: { key: "grok-access", refresh_token: "grok-refresh", expires_at: new Date(Date.now() + 3_600_000).toISOString() } }))
  mkdirSync(join(person, ".local", "share", "devin"), { recursive: true })
  writeFileSync(join(person, ".local", "share", "devin", "credentials.toml"), "api_key = \"devin\"\n")
  const saved = { ...process.env }
  Object.assign(process.env, {
    HOME: person, CURSOR_API_KEY: "cursor-api-key-0123456789", ANTHROPIC_API_KEY: "the-shell's", CLAUDE_CONFIG_DIR: join(person, ".claude"),
    CODEX_HOME: join(person, ".codex"), XDG_DATA_HOME: join(person, ".local", "share"), npm_config_prefix: join(person, ".npm-global"), MAKO_DATA_ROOT: join(person, "mako"),
  })
  try {
    const claude = { claudeAiOauth: { accessToken: "claude-access", refreshToken: "claude-refresh", expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"] } }
    const seeded = seedScratchHome(join(root, "seeded"), { ...readPersonSignIns(person), claude }, {}, person)
    const own = join(root, "seeded", "home")
    assert.equal(seeded.home, own)
    assertScratchEnvironment(seeded.env, "a seeded home", person)
    for (const name of ["ANTHROPIC_API_KEY", "XDG_DATA_HOME", "npm_config_prefix", "MAKO_DATA_ROOT"]) assert.equal(seeded.env[name], undefined, `${name} isn't inherited`)
    assert.equal(seeded.env["CLAUDE_CONFIG_DIR"], join(own, ".claude"))
    assert.equal(seeded.env["CODEX_HOME"], join(own, ".codex"))
    assert.deepEqual(JSON.parse(readFileSync(join(own, ".claude", ".credentials.json"), "utf8")), { claudeAiOauth: { accessToken: "claude-access", expiresAt: claude.claudeAiOauth.expiresAt, scopes: ["user:inference"] } }, "a host's Claude finds the access token, and no refresh token")
    assert.equal(JSON.parse(readFileSync(join(own, ".codex", "auth.json"), "utf8")).tokens.refresh_token, "")
    const path = (seeded.env["PATH"] ?? "").split(":")
    assert.ok(path.indexOf(join(person, ".local", "bin")) > path.indexOf((saved["PATH"] ?? "").split(":")[0]!), "the person's CLIs come after this PATH")
    assert.ok(path.includes(join(person, ".grok", "bin")) && path.includes(join(person, ".opencode", "bin")), "every folder a host finds a harness CLI in is on PATH")

    // A host's or an app's home, from what the person is signed in with: on macOS a keychain of its own, and theirs untouched.
    const keychains = () => process.platform === "darwin"
      ? execFileSync("/usr/bin/security", ["list-keychains", "-d", "user"], { encoding: "utf8", env: { ...saved, HOME: userInfo().homedir } }) + execFileSync("/usr/bin/security", ["default-keychain", "-d", "user"], { encoding: "utf8", env: { ...saved, HOME: userInfo().homedir } })
      : ""
    const theirs = keychains()
    const host = scratchHostHome(join(root, "host"))
    scratchHostHome(join(root, "host"))
    assert.equal(JSON.parse(readFileSync(join(host.home, ".grok", "auth.json"), "utf8")).xai.refresh_token, "", "Grok's copy can't renew itself")
    assert.equal(readFileSync(join(host.home, ".local", "share", "devin", "credentials.toml"), "utf8"), "api_key = \"devin\"\n")
    assert.equal(host.env["CURSOR_API_KEY"], "cursor-api-key-0123456789")
    if (process.platform === "darwin") {
      const keychain = join(host.home, "Library", "Keychains", "scratch.keychain-db")
      assert.ok(existsSync(keychain), "the home has a keychain of its own")
      assert.match(execFileSync("/usr/bin/security", ["default-keychain", "-d", "user"], { encoding: "utf8", env: { ...saved, HOME: host.home } }), new RegExp(keychain.replaceAll(".", "\\.")), "it's the home's default keychain")
      assert.equal(keychains(), theirs, "the person's keychain search list and default are as they were")
    }

    // A packaged app runs as `root/home`; a caller's own HOME is taken, never the person's.
    const app = new PackagedApp({ executable: "/usr/bin/false", root: join(root, "app"), workspace: root })
    const env = app.environment()
    assert.equal(env.HOME, join(root, "app", "home"))
    assert.equal(env.MAKO_DATA_ROOT, join(root, "app", "profile"))
    assert.throws(() => new PackagedApp({ executable: "/usr/bin/false", root: join(root, "app"), workspace: root, env: { HOME: person } }).environment(), /person's own home/)

    // Each copy is 0600, in folders that are 0700 from the home down; disposing takes the home, or only its sign-ins.
    const mode = (path: string) => statSync(path).mode & 0o777
    const copies = SECRET_FILES.map((parts) => join(seeded.home, ...parts)).filter((path) => existsSync(path))
    assert.equal(copies.length, SECRET_FILES.length, "Claude's, Codex's, OpenCode's, Grok's and Devin's copies")
    for (const path of copies) {
      assert.equal(mode(path), 0o600, `${relative(seeded.home, path)} is 0600`)
      for (let folder = dirname(path); folder.startsWith(seeded.home); folder = dirname(folder)) assert.equal(mode(folder), 0o700, `${relative(root, folder)} is 0700`)
    }
    seeded.dispose()
    assert.equal(existsSync(seeded.home), false, "a disposed home is gone")
    const kept = seedScratchHome(join(root, "kept"), readPersonSignIns(person), { keep: true }, person)
    writeFileSync(join(kept.home, "session.jsonl"), "{}\n")
    kept.dispose()
    assert.deepEqual(readdirSync(kept.home).filter((name) => !name.startsWith(".")).sort(), ["session.jsonl"], "a kept home keeps its sessions")
    assert.deepEqual(SECRET_FILES.filter((parts) => existsSync(join(kept.home, ...parts))), [], "and loses every sign-in")
    // A home in a Git checkout could have a copy committed.
    execFileSync("git", ["init", "-q", join(root, "checkout")])
    assert.throws(() => seedScratchHome(join(root, "checkout", "proof"), readPersonSignIns(person), {}, person), /inside the Git checkout/)

    // A harness CLI run for the record-store proofs is refused in the person's home before it's spawned.
    await assert.rejects(runHarness(process.execPath, marking, root, { ...process.env }), /person's own home/)
    assert.equal(existsSync(mark) && readFileSync(mark, "utf8") !== home, false, "the refused CLI never ran")

    // A run's home goes when it ends, normally or by SIGTERM; a run killed outright leaves it, and the next run sweeps
    // its sign-ins and says so without what they held.
    const child = join(root, "child.ts")
    writeFileSync(child, [
      // Run as one process (Node with tsx's loader), so the signal reaches the run itself.
      `import { scratchHostHome } from ${JSON.stringify(join(scripts, "scratch-harness-home.ts"))}`,
      `const [how, at] = process.argv.slice(2)`,
      `const { home } = scratchHostHome(at, { keep: how === "kill" })`,
      // Said once the pipe has it: a write to a pipe is asynchronous on macOS, and SIGKILL would drop it.
      `process.stdout.write(home + "\\n", () => { if (how === "kill") process.kill(process.pid, "SIGKILL") })`,
      `if (how === "term") setInterval(() => {}, 1000)`,
    ].join("\n"))
    const runChild = async (how: string) => {
      const at = join(root, `run-${how}`)
      const started = spawn(process.execPath, ["--import", "tsx", child, how, at], { cwd: join(scripts, ".."),  env: process.env, stdio: ["ignore", "pipe", "inherit"] })
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => started.once("exit", (code, signal) => resolve({ code, signal })))
      let homeOf = ""
      for await (const line of createInterface({ input: started.stdout })) {
        homeOf = line.trim()
        break
      }
      assert.ok(existsSync(join(homeOf, ".grok", "auth.json")) || how === "kill", `${how}: the run holds its sign-ins while it runs`)
      if (how === "term") started.kill("SIGTERM")
      return { home: homeOf, ...await ended }
    }
    const normal = await runChild("exit")
    assert.equal(normal.code, 0)
    assert.equal(existsSync(normal.home), false, "a run that ends normally takes its home with it")
    const terminated = await runChild("term")
    assert.equal(terminated.signal, "SIGTERM", "SIGTERM still ends the run")
    assert.equal(existsSync(terminated.home), false, "a run ended by SIGTERM takes its home with it")
    const killed = await runChild("kill")
    assert.equal(killed.signal, "SIGKILL")
    writeFileSync(join(killed.home, "session.jsonl"), "{}\n")
    const leftovers = SECRET_FILES.filter((parts) => existsSync(join(killed.home, ...parts)))
    assert.ok(leftovers.length > 0, "a run killed outright leaves its sign-ins")
    const secrets = ["grok-access", "cursor-api-key-0123456789", jwt(hour)]
    const said: string[] = []
    assert.ok(sweepScratchHomes((line) => said.push(line)).includes(killed.home), "the next run sweeps them")
    assert.deepEqual(SECRET_FILES.filter((parts) => existsSync(join(killed.home, ...parts))), [], "every sign-in it left is gone")
    if (process.platform === "darwin") assert.equal(existsSync(join(killed.home, "Library", "Keychains", "scratch.keychain-db")), false, "and its keychain")
    assert.ok(existsSync(join(killed.home, "session.jsonl")), "a kept home's sessions stay")
    assert.ok(said.some((line) => line.includes(killed.home)), "the sweep says which home")
    for (const line of said) for (const secret of secrets) assert.ok(!line.includes(secret), "and never what it held")
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }

  // Every script that starts a harness session runs it in a scratch or sealed home, and none drives this Mac's own Mako.
  const files = [...readdirSync(scripts), ...readdirSync(join(scripts, "lib")).map((name) => join("lib", name)), ...readdirSync(join(scripts, "linux-host")).map((name) => join("linux-host", name))]
    .filter((name) => /\.(ts|mjs)$/.test(name) && name !== "test-scratch-home.ts")
  const startsSession = /liveStart|mako:live-start|\bdriver\.start\(|\bowner\.start\(|\bquery\(\{/
  const runsHost = /node_modules\/\.bin\/electron|\(\s*["']electron["']\s*\)|electronExecutable|spawnHost\(|hostCommand\(|startHost\(|from\s+["']@anthropic-ai\/claude-agent-sdk["']/
  const runsCli = /(?:spawn|execFile|run|execute|execa)(?:Sync)?\(\s*["'`](?:claude|codex|grok|opencode|opencode2|devin|cursor-agent)["'`]/
  const personsMako = /runtimeDataRoot\(appDataFolder\(\)|localRuntime\(\)/
  const isolated = /scratchHostHome\(|scratchHarnessHome\(|enterScratchHome\(|seedScratchHome\(|sandboxed\(|assertScratchEnvironment\(|proofDataRoot\(|new PackagedApp\(|authoringWorld\(|\bHOME:\s*(?!homedir\(\)|process\.env)[\w(]/
  /** Scripts the rules above match where no real harness runs, or none in the person's stores; each says why. */
  const exempt = {
    "audit-native-claude-initialization.ts": "audits each account's Claude start; its one turn keeps no session (persistSession: false)",
    "linux-host/prove.mjs": "runs only inside the Linux host's container, whose home is the container's",
    "test-background-work.ts": "recorded Agent SDK messages; no Claude runs",
    "test-claude-runtime.ts": "intercepts the SDK's spawn; no Claude runs",
    "test-claude-sdk.ts": "injected Agent SDK queries; no Claude runs",
    "test-claude-sdk-startup.ts": "a shim stands in for Claude's executable",
    "test-native-agents.ts": "a fixture driver; no harness runs",
    "test-native-failures.mjs": "stand-in native processes for every harness",
    "test-fixture-desk.mjs": "the fixture desk refuses every live start",
    "test-session-memory.ts": "injected fixture drivers",
  } satisfies Record<string, string>
  const unsealed: string[] = []
  for (const name of files) {
    const text = readFileSync(join(scripts, name), "utf8")
    const why = (startsSession.test(text) && runsHost.test(text) && "starts a harness session in a host, app or SDK it runs")
      || (runsCli.test(text) && "spawns a harness CLI")
      || (startsSession.test(text) && personsMako.test(text) && "starts a session in this Mac's own Mako")
    if (why && !isolated.test(text) && !(name in exempt)) unsealed.push(`${name}: ${why} with the person's own home`)
  }
  assert.deepEqual(unsealed, [], `run each in a scratch home (scratch-harness-home.ts) or a host of its own (lib/proof-host.ts), or name it in this test's exemptions with why no real harness runs there:\n${unsealed.join("\n")}`)
  for (const name of Object.keys(exempt)) assert.ok(files.includes(name), `the exemption for ${name} names a script that exists`)
  console.log(`Scratch home: installs refuse the person's home (${refusals.length} cases) before spawning, ${proofs.length} proof scripts install only through scratchInstall, the home holds access alone${process.platform === "darwin" ? " and a keychain of its own" : ""}, 0600 in 0700 folders, gone when its run ends normally or by SIGTERM and swept after a kill, and of ${files.length} scripts every one that runs a harness gives it a scratch or sealed home (${Object.keys(exempt).length} named run none)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
