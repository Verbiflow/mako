import assert from "node:assert/strict"
import { runSuite } from "./lib/run-suite.mjs"

// A hung suite says what hung and goes; one that isn't is left alone, whatever it leaves behind.
const node = process.execPath
const say = async (source, options = {}) => {
  let output = ""
  const began = Date.now()
  const code = await runSuite(node, ["-e", source], { limitMs: 60_000, quietMs: 60_000, write: (text) => { output += text }, ...options })
  return { code, output, ms: Date.now() - began }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

const passed = await say('console.log("to stdout"); console.error("to stderr")')
assert.equal(passed.code, 0)
assert.match(passed.output, /to stdout/, "its output comes through")
assert.match(passed.output, /to stderr/)
assert.doesNotMatch(passed.output, /HUNG/)
assert.equal((await say("process.exit(3)")).code, 3, "and its exit code")

// One that can't start says so, and isn't a pass.
let unstarted = ""
assert.equal(await runSuite("/no/such/suite", [], { limitMs: 60_000, quietMs: 60_000, write: (text) => { unstarted += text } }), null)
assert.match(unstarted, /DID NOT START: \/no\/such\/suite: .*ENOENT/, "it says why")

// Silent, with a child of its own: both are named, and both go.
const child = 'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)//the-stuck-script"],{stdio:"ignore"});console.log("CHILD "+c.pid);setInterval(()=>{},1000)'
const silent = await say(child, { quietMs: 1_500 })
assert.equal(silent.code, null, "a stopped suite isn't a pass")
assert.match(silent.output, /HUNG: nothing printed for 2 s/)
assert.match(silent.output, /the-stuck-script/, "what was running is named, down to the child that held it")
const pid = Number(/CHILD (\d+)/.exec(silent.output)?.[1])
await new Promise((resolve) => setTimeout(resolve, 200))
assert.equal(alive(pid), false, "and the whole group goes")

// Printing all the while, past the limit.
const chatty = await say('setInterval(()=>console.log("still here"),100)', { limitMs: 1_000 })
assert.equal(chatty.code, null)
assert.match(chatty.output, /HUNG: past 1 s/, "a limit holds even for a suite that keeps talking")

// A process left in the background holds the output open; the suite has still ended.
const left = 'const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"inherit",detached:true});c.unref();console.log("left",c.pid)'
const ended = await say(left)
assert.equal(ended.code, 0)
const leftPid = Number(/left (\d+)/.exec(ended.output)?.[1])
// Ended while what it left still runs: a suite that waited on it would end only once it had gone.
assert.ok(alive(leftPid), `a background process doesn't hold the suite: ended in ${ended.ms} ms`)
process.kill(leftPid, "SIGKILL")
console.log("Run suite: output and exit code passed through; a silent or overlong suite is named down to its child and ended whole; a process left behind holds nothing")
