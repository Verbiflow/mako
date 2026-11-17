import assert from "node:assert/strict"
// Grok's account of a folder (`grok inspect --json`) is asked again only when something it reads changed: a hook
// file added, its folder trust written, its executable replaced. A warm launch spawns nothing. An answer Grok
// couldn't give (`unsure`) isn't kept, so the next launch asks again. A stand-in `grok` prints what the test sets and
// counts each time it runs.
//
//   npx tsx scripts/test-grok-inspect-cache.ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { grokPersonCode, type GrokAnswers } from "@mako/host/harnesses/grok/person-code"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-grok-inspect-cache-")))
try {
  const home = join(root, "home"), project = join(root, "project"), bin = join(root, "bin")
  for (const folder of [home, join(project, ".git"), bin]) mkdirSync(folder, { recursive: true })
  const said = join(root, "said.json"), runs = join(root, "runs")
  const grok = join(bin, "grok")
  writeFileSync(grok, `#!/bin/sh\necho run >> "${runs}"\ncat "${said}"\n`)
  chmodSync(grok, 0o755)
  /** What the stand-in Grok says, as `grok inspect --json` does (1.0.70). */
  interface Said { hooks?: { event: string; source: { type: string } }[] }
  const answer = (fields: Said) => writeFileSync(said, JSON.stringify({ projectTrusted: true, hooks: [], plugins: [], mcpServers: [], lspServers: [], ...fields }))
  const spawned = () => readFileSync(runs, "utf8").split("\n").filter(Boolean).length
  // Times move in whole milliseconds at least: what's changed between two launches is a step later than what was.
  const later = () => delay(20)

  const answers: GrokAnswers = new Map()
  const launch = { executable: grok, env: { HOME: home, PATH: process.env.PATH }, cwd: project, servers: [] }
  answer({})
  writeFileSync(runs, "")
  assert.equal(await grokPersonCode(launch, answers), false, "a trusted folder with nothing of the person's")
  assert.equal(spawned(), 1, "the first launch asks Grok")
  assert.equal(await grokPersonCode(launch, answers), false)
  assert.equal(await grokPersonCode(launch, answers), false)
  assert.equal(spawned(), 1, "a warm launch spawns nothing")
  console.log("PASS: a warm launch reads Grok's last answer and spawns nothing")

  // A hook file added under the home's hooks folder.
  await later()
  mkdirSync(join(home, ".grok", "hooks"), { recursive: true })
  writeFileSync(join(home, ".grok", "hooks", "pre.json"), "{}")
  answer({ hooks: [{ event: "pre_tool_use", source: { type: "user" } }] })
  assert.equal(await grokPersonCode(launch, answers), true, "the hook Grok now names is heard")
  assert.equal(spawned(), 2, "a hook file added is asked about")
  // Edited in place, which moves only the file's own time.
  await later()
  writeFileSync(join(home, ".grok", "hooks", "pre.json"), JSON.stringify({ hooks: {} }))
  answer({})
  assert.equal(await grokPersonCode(launch, answers), false)
  assert.equal(spawned(), 3, "a hook file edited in place is asked about")
  // The folder-trust store written (a trust given or taken back).
  await later()
  writeFileSync(join(home, ".grok", "trusted_folders.toml"), `[[folders]]\npath = "${project}"\n`)
  assert.equal(await grokPersonCode(launch, answers), false)
  assert.equal(spawned(), 4, "trusted_folders.toml written is asked about")
  // A project's own config, in the folder itself.
  await later()
  mkdirSync(join(project, ".grok"), { recursive: true })
  writeFileSync(join(project, ".grok", "config.toml"), "")
  assert.equal(await grokPersonCode(launch, answers), false)
  assert.equal(spawned(), 5, "a project config added is asked about")
  // The executable replaced, as an update does: a new build may load what the last didn't.
  const moved = new Date(Date.now() + 60_000)
  utimesSync(grok, moved, moved)
  assert.equal(await grokPersonCode(launch, answers), false)
  assert.equal(spawned(), 6, "an executable whose time moved is asked again")
  assert.equal(await grokPersonCode(launch, answers), false)
  assert.equal(spawned(), 6, "and then kept again")
  console.log("PASS: a hook added or edited, the trust store written, a project config or a replaced executable asks Grok again")

  // An answer Grok couldn't give isn't kept: each launch asks until one is.
  // (Grok's answer for an unchanged stamp is kept whatever it would say now: the stamp is the rule, so it moves first.)
  await later()
  writeFileSync(join(home, ".grok", "hooks", "pre.json"), "{}")
  writeFileSync(said, "not json")
  assert.equal(await grokPersonCode(launch, answers), true, "an unreadable answer holds nothing")
  const unsure = spawned()
  assert.equal(await grokPersonCode(launch, answers), true)
  assert.equal(spawned(), unsure + 1, "an unsure answer isn't kept: the same stamp asks again")
  answer({})
  assert.equal(await grokPersonCode(launch, answers), false, "the first definite answer is heard")
  assert.equal(await grokPersonCode(launch, answers), false)
  assert.equal(spawned(), unsure + 2, "and kept")
  console.log("PASS: an answer Grok couldn't give isn't kept, and the next definite one is")

  // A process MCP server of the launch's needs no asking: it holds nothing whatever Grok says.
  const before = spawned()
  assert.equal(await grokPersonCode({ ...launch, servers: [{ name: "theirs", process: true }] }, answers), true)
  assert.equal(spawned(), before, "a launch with the person's process server spawns nothing")
  console.log("PASS: a launch passing the person's process MCP server holds nothing without asking Grok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
