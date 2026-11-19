import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import ts from "typescript"
import { transform } from "esbuild"
import { EventEmitter, once } from "node:events"
import { z } from "zod"

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
const diagnostic = bench.ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText() === "CleanupCodeSchema"))
assert.ok(diagnostic)
const benchBody = (await transform(`${diagnostic.getText()}\n${bench.text.slice(acquisition.getStart())}`, { loader: "ts", format: "esm", define: { "import.meta.dirname": JSON.stringify("/fixture-only") } })).code
const exit = Symbol("actual fixture exit")
for (const cleanup of [null, undefined, Object.assign(new Error("PRIVATE-DETAIL"), { code: "EACCES" }), new Error("PRIVATE-DETAIL", { cause: { code: "EPERM" } })]) {
  const calls = [], primary = new Error("fixed fixture acquisition failure")
  const facts = []
  let result
  const run = new AsyncFunction("ownedScratch", "values", "performance", "scale", "makeWorld", "say", "process", "console", "z", benchBody)
  await assert.rejects(run(
    () => ({ path: "/fixture-only", dispose: async () => { calls.push("scratch"); if (cleanup !== null) throw cleanup } }), {},
    { now: () => 0 }, {}, async () => { calls.push("acquire"); throw primary }, message => { if (message.startsWith("bench:host-load failed:")) calls.push("primary"); else facts.push(message) },
    { exit: code => { result = code; throw exit } }, { error: error => { assert.equal(error, primary); calls.push("primary") } }, z,
  ), error => error === exit)
  assert.equal(result, 1)
  assert.deepEqual(calls, ["acquire", "primary", "scratch"], "world acquisition failure reaches the registered cleanup owner")
  assert.ok(facts.every(fact => !fact.includes("PRIVATE")), "cleanup diagnostics never print error messages")
  if (cleanup instanceof Error) assert.match(facts.join("\n"), /\(cleanup, E(?:ACCES|PERM)\)/)
}
// A kill request is not a reap. Execute the bench's actual finalizer with one still-live owned child.
const finalizer = bench.ast.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText() === "finish"))
assert.ok(finalizer)
const finishSource = (await transform(bench.text.slice(acquisition.end, finalizer.end), { loader: "ts", format: "esm" })).code
{
  let disposed = false, result, killed = 0
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, pid: 12345, kill: () => { killed++; return true } })
  const owner = await new AsyncFunction("scratch", "process", "say", "once", `${finishSource}; return { finish, children }`)(
    { path: "/fixture-only", dispose: async () => { disposed = true; if (child.exitCode === null) throw new Error("Scratch process inspection was incomplete.") } },
    { exit: code => { result = code; throw exit } }, () => {}, once,
  )
  owner.children.push(child)
  const attempt = owner.finish(0)
  assert.equal(owner.finish(0), attempt, "cleanup reentry joins the original stop")
  const finished = attempt.catch(error => { assert.equal(error, exit) })
  await new Promise(resolve => setImmediate(resolve))
  try { assert.equal(disposed, false, "scratch stays intact until the owned child is positively reaped") }
  finally { child.exitCode = 0; child.emit("exit", 0, null); await finished }
  assert.equal(killed, 1)
  assert.equal(result, 0)
  assert.equal(disposed, true)
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
    async () => ({ unregisterOutsideHost: () => {} }), async () => { calls.push("prune") }, "/fixture-only/output", { warn: () => {} },
  ), error => cleanupFails ? error instanceof AggregateError && error.errors[0] === undefined && error.errors[1] === cleanup : error === undefined)
  assert.deepEqual(calls, ["builder", "scratch", "prune"])
}
console.log("Scratch callers: actual benchmark acquisition and package builder lifetimes reach cleanup; primary and falsey failures remain observable; no real builders or hosts started")
