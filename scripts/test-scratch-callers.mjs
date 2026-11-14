import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import ts from "typescript"
import { transform } from "esbuild"

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const source = async path => {
  const text = await readFile(new URL(path, import.meta.url), "utf8")
  return { text, ast: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true) }
}
// Execute the actual containing lifetime with inert resource boundaries. No benchmark host,
// package builder, signing helper or process probe is started by these controls.
const bench = await source("./bench-host-load.ts")
const acquisition = bench.ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText() === "scratch"))
assert.ok(acquisition)
const benchBody = (await transform(bench.text.slice(acquisition.getStart()), { loader: "ts", format: "esm", define: { "import.meta.dirname": JSON.stringify("/fixture-only") } })).code
const exit = Symbol("actual fixture exit")
for (const cleanupFails of [false, true]) {
  const calls = [], primary = new Error("fixed fixture acquisition failure")
  let result
  const run = new AsyncFunction("ownedScratch", "values", "performance", "scale", "makeWorld", "say", "process", "console", benchBody)
  await assert.rejects(run(
    () => ({ path: "/fixture-only", dispose: async () => { calls.push("scratch"); if (cleanupFails) throw undefined } }), {},
    { now: () => 0 }, {}, async () => { calls.push("acquire"); throw primary }, message => { if (message.startsWith("bench:host-load failed:")) calls.push("primary") },
    { exit: code => { result = code; throw exit } }, { error: error => { assert.equal(error, primary); calls.push("primary") } },
  ), error => error === exit)
  assert.equal(result, 1)
  assert.deepEqual(calls, ["acquire", "primary", "scratch"], "world acquisition failure reaches the registered cleanup owner")
}
const pkg = await source("./package-mac.mjs")
const lifetime = pkg.ast.statements.find(ts.isTryStatement)
assert.ok(lifetime)
const importing = 'await import("@mako/host/application/local-update-installer")'
assert.equal(lifetime.getText().split(importing).length, 2)
const packageBody = pkg.text.slice(pkg.text.indexOf("let failed = false")).replace(importing, "await importInstaller()")
for (const cleanupFails of [false, true]) {
  const calls = [], cleanup = new Error("fixed fixture disposal failure")
  const run = new AsyncFunction("execFileSync", "process", "join", "project", "stageOwner", "importInstaller", "pruneReleaseBuilds", "output", "console", packageBody)
  await assert.rejects(run(
    () => { calls.push("builder"); throw undefined }, { execPath: "/fixture-only" }, (...parts) => parts.join("/"), "/fixture-only",
    { dispose: async () => { calls.push("scratch"); if (cleanupFails) throw cleanup } },
    async () => ({ unregisterBundle: () => {} }), async () => { calls.push("prune") }, "/fixture-only/output", { warn: () => {} },
  ), error => cleanupFails ? error instanceof AggregateError && error.errors[0] === undefined && error.errors[1] === cleanup : error === undefined)
  assert.deepEqual(calls, ["builder", "scratch", "prune"])
}
console.log("Scratch callers: actual benchmark acquisition and package builder lifetimes reach cleanup; primary and falsey failures remain observable; no real builders or hosts started")
