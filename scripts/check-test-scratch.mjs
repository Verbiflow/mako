#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A UI test's Chromium profile and Vite cache are about 200 MB a run, and folders made with `mkdtemp` stay for good. So
 * a test that's a UI test or launches Electron takes its folder from `testScratch` (`scripts/lib/test-scratch.mjs`),
 * which removes it however the test ends.
 */
const LAUNCHES = /\.bin\/electron|from ["']electron["']|require\(["']electron["']\)|electronPath/

/** Where each `mkdtemp` call under the temporary folder starts, however it's spread over lines. */
function underTemp(source) {
  const lines = []
  for (const call of source.matchAll(/\bmkdtemp(?:Sync)?\s*\(/g)) {
    let depth = 1
    let at = call.index + call[0].length
    for (; at < source.length && depth; at++) {
      if (source[at] === "(") depth++
      if (source[at] === ")") depth--
    }
    if (/\btmpdir\s*\(|\bTMPDIR\b/.test(source.slice(call.index, at))) lines.push(source.slice(0, call.index).split("\n").length)
  }
  return lines
}

export function scratchProblems(root = "scripts") {
  const problems = []
  for (const name of readdirSync(root)) {
    if (!/^test-.*\.(?:mjs|tsx?)$/.test(name) || name === "test-test-scratch.mjs") continue
    const path = join(root, name)
    const source = readFileSync(path, "utf8")
    if (!/ui/.test(name) && !LAUNCHES.test(source)) continue
    for (const line of underTemp(source)) problems.push(`${path}:${line}: use testScratch from scripts/lib/test-scratch.mjs, which removes it however the test ends`)
  }
  return problems
}

const problems = scratchProblems(process.argv[2])
if (problems.length) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log("Test scratch: every UI and Electron test's folder is removed however it ends")
