// Runs every suite `npm run test:attribution` names (and the holds suite), one after another, and goes on past a
// failure so one run says how many pass: the list is read from package.json, never copied here.
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts
const suites = [...`${scripts["test:attribution"]} && ${scripts["test:attribution-holds"]}`.matchAll(/tsx (scripts\/[\w.-]+\.ts)/g)].map((match) => match[1])
const tsx = new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url)
const failed = []
// Open on Windows: a suite whose every case passes there but whose process doesn't end, with why. It is given a
// minute, ended, and counted as passing only if no case failed; anything else of it still fails the run.
const ENDED_HERE = process.platform === "win32" ? { "scripts/test-shared-journal-reach.ts": "three pipes and a timer stay open after its cases (a host whose owner couldn't start)" } : {}
const logs = process.env.MAKO_SUITE_LOGS
if (logs) mkdirSync(logs, { recursive: true })
for (const suite of [...new Set(suites)]) {
  const began = Date.now()
  const run = spawnSync(process.execPath, [tsx.pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--test-reporter=tap", suite], { encoding: "utf8", timeout: ENDED_HERE[suite] ? 60_000 : 300_000, maxBuffer: 256 * 2 ** 20 })
  const said = `${run.stdout ?? ""}`
  const endedHere = Boolean(ENDED_HERE[suite]) && run.status === null && /^ok \d+ /m.test(said) && !/^not ok /m.test(said)
  if (endedHere) console.log(`OPEN ${suite}: ${ENDED_HERE[suite]}; its cases passed and the runner ended it`)
  const ok = run.status === 0 || endedHere
  console.log(`${ok ? "ok  " : "FAIL"} ${suite} (${Math.round((Date.now() - began) / 1000)} s)`)
  if (!ok) {
    failed.push(suite)
    // The whole output is kept where MAKO_SUITE_LOGS says; here, the test runner's own list of what failed, or the end.
    const text = `${run.stdout ?? ""}${run.stderr ?? ""}`
    if (logs) writeFileSync(join(logs, `${basename(suite)}.log`), text)
    const lines = text.split("\n").filter((line) => line.trim() && !line.startsWith("warning: in the working copy"))
    // Each failed case as TAP writes it (`not ok`, then what it says of it), and the end, where a crash is.
    const said = []
    for (let at = 0; at < lines.length && said.length < 400; at++) {
      if (!lines[at].startsWith("not ok")) continue
      const end = lines.findIndex((line, index) => index > at && line.trim() === "...")
      said.push(...lines.slice(at, Math.min(end < 0 ? at + 1 : end, at + 28)))
    }
    console.log([...said, ...lines.slice(-12)].join("\n"))
  }
}
console.log(`${suites.length - failed.length} of ${suites.length} attribution suites pass`)
if (failed.length) {
  console.log(`failed: ${failed.join(", ")}`)
  process.exit(1)
}
