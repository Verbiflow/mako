#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A UI test's Chromium profile and Vite cache are about 200 MB a run, and folders made with `mkdtemp` stay for good. So
 * a test that's a UI test or launches Electron takes its folder from `testScratch` (`scripts/lib/test-scratch.mjs`),
 * which removes it however the test ends.
 */
const MADE_UNDER_TEMP = /mkdtemp(?:Sync)?\(\s*(?:path\.)?(?:join\(\s*(?:os\.)?tmpdir\(\)|`\$\{(?:os\.)?tmpdir\(\)\}|(?:os\.)?tmpdir\(\)\s*\+)/
const LAUNCHES = /\.bin\/electron|from ["']electron["']|require\(["']electron["']\)|electronPath/

export function scratchProblems(root = "scripts") {
  const problems = []
  for (const name of readdirSync(root)) {
    if (!/^test-.*\.(?:mjs|ts)$/.test(name) || name === "test-test-scratch.mjs") continue
    const path = join(root, name)
    const source = readFileSync(path, "utf8")
    if (!/ui/.test(name) && !LAUNCHES.test(source)) continue
    source.split("\n").forEach((line, index) => {
      if (MADE_UNDER_TEMP.test(line)) problems.push(`${path}:${index + 1}: use testScratch from scripts/lib/test-scratch.mjs, which removes it however the test ends`)
    })
  }
  return problems
}

const problems = scratchProblems(process.argv[2])
if (problems.length) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log("Test scratch: every UI and Electron test's folder is removed however it ends")
