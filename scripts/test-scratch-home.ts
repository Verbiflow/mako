import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { assertScratchEnvironment, scratchInstall } from "./scratch-harness-home.ts"

/**
 * No proof installs a CLI into the person's own home. `scratchInstall` is
 * the one way a proof runs an installer, and it refuses an environment
 * whose `HOME`, or any folder a harness or npm writes under, is theirs; every
 * proof script's installer goes through it.
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
  console.log(`Scratch home: installs refuse the person's home (${refusals.length} cases) before spawning, run in a scratch home, and ${proofs.length} proof scripts install only through scratchInstall`)
} finally {
  await rm(root, { recursive: true, force: true })
}
