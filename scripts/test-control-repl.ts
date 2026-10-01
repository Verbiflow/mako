import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { createControlRuntime } from "@mako/control-runtime"
import { createControlMcpServer } from "@mako/control-runtime/mcp"
import {
  readControlSession,
  invokeControlSession,
  serveControlSession,
} from "@mako/control-runtime/session"
import { ControlFault, controlFaultData } from "@mako/control/control"
import {
  ControlProgramRuntime,
  ControlProgramError,
  programErrorText,
} from "@mako/control/program"
import { browserFixture } from "./browser-control-fixture.js"

const fixture = await browserFixture()
const artifacts = await mkdtemp(join(tmpdir(), "mako-repl-test-"))
const runtime = createControlRuntime({
  artifacts,
  browsers: [fixture.definition],
})
const owner = await serveControlSession(runtime)
const descriptor = await readControlSession(owner.file)
const signal = new AbortController().signal
const request = (
  operation: Parameters<typeof invokeControlSession>[1],
  active = signal
) => invokeControlSession(descriptor, operation, active)
const server = createControlMcpServer(request)
const client = new Client({ name: "test-agent", version: "1" })
const [agentTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)
await client.connect(agentTransport)
const output = z.object({
  isError: z.boolean().optional(),
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        data: z.string(),
        mimeType: z.string(),
      }),
    ])
  ),
})
const js = async (code: string, timeout_ms = 5000) =>
  output.parse(
    await client.callTool({ name: "js", arguments: { code, timeout_ms } })
  )
const text = (value: z.infer<typeof output>) =>
  value.content
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("\n")
const summary: Record<string, number | boolean> = {}
try {
  const tools = await client.listTools()
  assert.deepEqual(
    tools.tools.map((t) => t.name),
    ["js", "js_reset"]
  )
  assert.match(tools.tools[0].description ?? "", /first call prints the SDK documentation once/i)
  assert.ok(!JSON.stringify(tools).includes('"cell"'))
  const first = await js("await control.browsers()")
  assert.equal(first.isError, undefined, text(first))
  assert.match(text(first), /^Mako browser and computer use/, "documentation is plain text, not a JSON string")
  assert.doesNotMatch(text(first).split("\n\n")[0]!, /\\n/)
  assert.match(text(first), /^fixture "Fixture Chrome" disconnected → await control\.connectBrowser\("fixture"\)$/m, "a browser prints as one line, its ID first")
  assert.equal(fixture.calls.length, 0, "discovery does not connect")
  summary.firstCallBytes = Buffer.byteLength(JSON.stringify(first))
  const imported = await js(
    'let {basename}=await import("node:path"); basename("/tmp/control-proof")'
  )
  assert.equal(imported.isError, undefined, text(imported))
  assert.match(text(imported), /control-proof/)
  assert.match(
    text(await js('basename("/tmp/retained-import")')),
    /retained-import/
  )
  const status = await js("await control.status()")
  assert.equal(status.isError, undefined, text(status))
  assert.match(text(status), /native/)
  const examples = await js('await control.help({topic:"examples"})')
  assert.doesNotMatch(text(examples), /return await/)
  const second = await js("await control.browsers()")
  assert.doesNotMatch(text(second), /Mako browser and computer use/)
  summary.repeatDiscoveryBytes = Buffer.byteLength(JSON.stringify(second))
  const latency: number[] = []
  for (let i = 0; i < 30; i++) {
    const started = performance.now()
    const result = await js("await control.browsers()")
    assert.equal(result.isError, undefined)
    latency.push(performance.now() - started)
  }
  latency.sort((a, b) => a - b)
  summary.warmDiscoveryP50Ms = Math.round(latency[15] * 100) / 100
  summary.warmDiscoveryP95Ms = Math.round(latency[28] * 100) / 100
  await js('checkpoint({remember:{purpose:"fixture"}})')
  assert.match(text(await js("recall()")), /fixture/)
  const open = await js(
    'await control.connectBrowser("fixture"); let tab=await control.openTab({browser:"fixture"}); state.tab=tab; await tab.observe()'
  )
  assert.equal(open.isError, undefined, text(open))
  assert.match(text(open), /^page "[^"]*" \S+/m, "an observation prints its page first")
  assert.match(text(open), /^ *e\d+ textbox "Proof"/m, "an observation prints as an outline with short refs")
  assert.doesNotMatch(text(open), /"nodes"|\{"ref"/, "an observation prints as text, not JSON")
  assert.doesNotMatch(text(open), /Mako browser and computer use|Observation has nodes/, "action results carry no guides")
  assert.equal(fixture.targets.size, 1)
  const named = await js(
    'let [prefix, contains, pattern] = [tab.locator({role:"textbox",name:{prefix:"pro"}}), tab.locator({role:"textbox",name:{contains:"ROO"}}), tab.locator({role:"textbox",name:/^Pr/})]; [(await prefix.read()).coverage.complete, (await tab.observe({match:{role:"textbox",name:/^Pr/}})).nodes.length, (await tab.observe({match:{role:"textbox",name:{contains:"ROO"}}})).nodes.length]'
  )
  assert.equal(named.isError, undefined, text(named))
  assert.deepEqual(JSON.parse(text(named)), [true, 1, 1])
  const missed = await js('await tab.locator({role:"textbox",name:"Proo"}).setValue("x")')
  assert.equal(missed.isError, true)
  assert.match(text(missed), /^Error target-not-found \(nothing dispatched\): No textbox is named "Proo"\. Observed textbox names: \[\{"ref":"e\d+","name":"Proof"\}\]/)
  assert.doesNotMatch(text(missed), /Before failing/, "a cell that changed nothing names no effects")
  const guessed = await js('await tab.fill("e1", "x")')
  assert.equal(guessed.isError, true)
  assert.match(text(guessed), /^Error: tab\.fill is not a function\. Use setValue\(ref, text\)/)
  const own = await js('[{id:"a",n:1},{id:"b",n:2}]')
  assert.equal(text(own), '[{"id":"a","n":1},{"id":"b","n":2}]', "a program's own values print as compact JSON, as built")
  const logged = await js('console.log("plain", {a:1}, (await control.tabs("fixture")).pages.length)')
  assert.equal(text(logged), 'plain {"a":1} 1')
  const listedTabs = text(await js('await control.tabs("fixture")'))
  assert.match(listedTabs, /^tabs in fixture: control\.claimTab\(\{browser:"fixture",tab\}\) controls one\n\S+ "[^"]*" \S+ claimed$/)
  const redeclared = await js("const marker = 1; marker")
  assert.equal(redeclared.isError, undefined, text(redeclared))
  assert.equal(JSON.parse(text(await js("const marker = 2; marker"))), 2, "const redeclares across cells")
  assert.equal(JSON.parse(text(await js("const local = 5\nreturn local * 2"))), 10, "a cell may return")
  const docless = await js(
    'let view=await tab.observe(); let field=view.get({role:"textbox",name:"Proof"}); console.log(field.ref); view'
  )
  assert.equal(docless.isError, undefined, text(docless))
  assert.doesNotMatch(text(docless), /Mako browser and computer use/)
  assert.ok(!fixture.calls.some((c) => c.method === "Page.captureScreenshot"))
  // The basic CLI's exec operation uses the same socket/engine. Its reads keep
  // the MCP-held ref; its action expires it. No second owner or cache is created.
  await request({ method: "exec", source: "return await state.tab.observe({interactive:true})" })
  const kept = await js("await tab.inspect(field.ref)")
  assert.equal(kept.isError, undefined, `a ref outlives later reads of the same document: ${text(kept)}`)
  await request({ method: "exec", source: 'await state.tab.observe(); await state.tab.pressKey("Escape"); return 1' })
  const dispatched = fixture.calls.filter((c) =>
    c.method.startsWith("Input.")
  ).length
  const stale = await js("await tab.click(field.ref)")
  assert.equal(stale.isError, true)
  assert.match(text(stale), /not from a read of this tab since its last action/)
  assert.equal(
    fixture.calls.filter((c) => c.method.startsWith("Input.")).length,
    dispatched
  )
  const ordinary = await js(
    'console.log("evidence-before-error"); throw new Error("ordinary failure")'
  )
  assert.equal(ordinary.isError, true)
  assert.match(text(ordinary), /evidence-before-error/)
  assert.match(text(await js("await tab.observe()")), /Proof/)
  const exact = "  日本語 🧪 é\n\t  "
  await js(`let exact=${JSON.stringify(exact)}; state.exact=exact`)
  assert.equal(text(await js("exact")), exact, "a string value prints as itself")
  const cross = z
    .array(z.object({ type: z.string(), text: z.string() }))
    .parse(await request({ method: "exec", source: "return state.exact" }))
  assert.equal(JSON.parse(cross[0].text), exact)
  const shot = await js("emitImage(await tab.screenshot())")
  assert.equal(shot.isError, undefined, text(shot))
  assert.ok(
    shot.content.some(
      (c) => c.type === "image" && c.mimeType.startsWith("image/")
    ),
    text(shot)
  )
  const docs = await js("await control.rewriteDocumentation()")
  assert.match(text(docs), /Mako browser and computer use/)
  assert.match(text(docs), /observations/)
  assert.match(
    text(await js('await control.help({topic:"recording"})')),
    /record/
  )
  const timeout = await js("while(true) {}", 100)
  assert.equal(timeout.isError, true)
  assert.match(text(timeout), /timed-out/)
  const fresh = await js("typeof tab")
  assert.match(text(fresh), /Program state was reset/)
  assert.doesNotMatch(text(fresh), /Mako browser and computer use/, "a timeout does not reprint the documentation")
  assert.equal(fresh.content.filter((c) => c.type === "text").at(-1)!.text, "undefined")
  assert.equal(
    fixture.targets.size,
    1,
    "timeout resets bindings, not task ownership"
  )
  await js("let resetMarker=1; state.resetMarker=1")
  await client.callTool({ name: "js_reset", arguments: {} })
  const afterReset = text(await js("typeof resetMarker"))
  assert.match(afterReset, /undefined/)
  assert.match(afterReset, /Mako browser and computer use/, "an explicit reset reintroduces the documentation")
  assert.equal(fixture.targets.size, 1)
  const retained = await request({
    method: "exec",
    source: "return typeof state.resetMarker",
  })
  assert.match(JSON.stringify(retained), /undefined/)
  const invalid = output.parse(
    await client.callTool({
      name: "js",
      arguments: {
        code: "throw new Error('should not execute')",
        timeout_ms: "100",
      },
    })
  )
  assert.equal(invalid.isError, true)
  assert.doesNotMatch(text(invalid), /should not execute/)
  const broken = await js("let unclosed = (1")
  assert.equal(broken.isError, true)
  assert.match(text(broken), /^Error syntax-error \(nothing dispatched\): The program did not run: .*fix the source and run it again\.$/)
  await client.close()
  assert.equal(
    fixture.targets.size,
    1,
    "adapter close must not close the shared task"
  )
  await request({ method: "exec", source: "return 42" })
  summary.sharedSession = true
  await assert.rejects(
    request({ method: "exec", source: "return (1" }),
    (error) => controlFaultData(error)?.outcome === "not-dispatched"
  )
} finally {
  await client.close()
  await server.close()
  await owner.close()
  await runtime.close()
  assert.equal(fixture.targets.size, 0, "task owner cleans up targets")
  await fixture.close()
  await rm(artifacts, { recursive: true, force: true })
}

// Real program worker, fake native transport: cross-cell handles, structured
// errors, late callbacks, cancellation and serial queue ownership.
const calls: string[] = []
const nativeArtifacts = await mkdtemp(join(tmpdir(), "mako-repl-images-"))
const native = new ControlProgramRuntime({
  namespace: "control",
  actions: ["events"],
  artifacts: nativeArtifacts,
  call: async (command) => {
    calls.push(String(command.action))
    if (command.action === "native")
      throw new ControlFault(
        "fixture-refusal",
        "Exact refusal",
        "not-dispatched"
      )
    return { events: [] }
  },
  image: (value) => [
    z
      .object({
        type: z.literal("image"),
        data: z.string(),
        mimeType: z.string(),
      })
      .parse(value),
  ],
  effect: (command) => (command.action === "dispatch" ? "set-text e1" : undefined),
  fault: (d) => new ControlFault(d.code, d.message, d.outcome),
})
const evaluate = (code: string, active = signal) =>
  native.run(code, active, { mode: "repl", yield: false })
try {
  await evaluate(
    "let win=control.window({pid:42,window_id:7}); await win.events()"
  )
  await evaluate("await win.events()")
  await assert.rejects(
    evaluate('await control.native("refuse")'),
    (e) =>
      e instanceof ControlProgramError &&
      e.cause instanceof ControlFault &&
      e.cause.code === "fixture-refusal"
  )
  // A program that fails to compile never ran: nothing was dispatched. A
  // SyntaxError thrown while running keeps its unknown outcome.
  const fault = async (run: Promise<unknown>) => {
    try {
      await run
    } catch (error) {
      assert.ok(error instanceof ControlProgramError, String(error))
      return { code: error.code, outcome: error.outcome, message: error.message }
    }
    assert.fail("The program should have failed")
  }
  const script = (code: string) => native.run(code, signal, { mode: "script", yield: false })
  const compiled = calls.length
  for (const [run, where] of [
    [evaluate("let broken = (1"), /Unexpected end of input \(line 1\)/],
    [evaluate("var switched = 1").then(() => evaluate("let switched = 2")), /An earlier cell declared it with var, function or class/],
    [script("return (1"), /ends before every bracket, string or statement is closed/],
    [script("const a = 1\nlet c = ;"), /Unexpected token ';' \(line 2\)/],
  ] as const) {
    const failed = await fault(run)
    assert.deepEqual([failed.code, failed.outcome], ["syntax-error", "not-dispatched"], failed.message)
    assert.match(failed.message, where)
    assert.match(failed.message, /did not run/)
  }
  assert.equal(calls.length, compiled, "a program that does not compile calls nothing")
  for (const run of [
    evaluate("await win.events(); JSON.parse('{')"),
    evaluate("eval('(')"),
    script("await control.window({pid:42,window_id:7}).events(); JSON.parse('{')"),
  ]) {
    const failed = await fault(run)
    assert.notEqual(failed.code, "syntax-error", failed.message)
    assert.equal(failed.outcome, undefined, "a runtime SyntaxError keeps an unknown outcome")
  }
  assert.equal(await evaluate("typeof win").then((value) => JSON.stringify(value).includes("object")), true, "a syntax error keeps REPL state")
  summary.syntaxErrorsNotDispatched = true
  // The fixture answers dispatch with a non-receipt: the call ran, then the cell failed.
  try {
    await evaluate('await win.events(); await win.setValue("e1", "x")')
    assert.fail("a malformed receipt fails the cell")
  } catch (error) {
    assert.ok(error instanceof ControlProgramError, String(error))
    assert.deepEqual(error.effects, ["set-text e1"], "reads are not named; the dispatched call is")
    assert.match(programErrorText(error), /\nBefore failing, this cell ran: set-text e1\. Observe before acting again; do not rerun the cell\.$/)
  }
  await evaluate('void setTimeout(() => { throw new Error("late boom") }, 20)')
  await delay(80)
  const reported = await evaluate("typeof win")
  assert.match(JSON.stringify(reported), /its callbacks threw; bindings and state were kept: late boom/)
  assert.match(JSON.stringify(reported), /object/, "a late throw keeps REPL bindings")
  await assert.rejects(
    evaluate('setTimeout(() => { throw new Error("during") }, 5); await new Promise(r => setTimeout(r, 60))'),
    /A callback threw outside the awaited program: during/
  )
  assert.match(JSON.stringify(await evaluate("typeof win")), /object/)
  summary.lateFailuresKeepState = true
  await evaluate(
    "void setTimeout(async()=>{try{await win.events()}catch(e){state.late=e.message}},30)"
  )
  const before = calls.length
  await evaluate("await new Promise(r=>setTimeout(r,70)); state.late")
  assert.equal(
    calls.length,
    before,
    "old async callbacks cannot borrow the new cell"
  )
  const abort = new AbortController()
  const running = evaluate(
    "await new Promise(r=>setTimeout(r,10000)); await win.events()",
    abort.signal
  )
  await delay(50)
  abort.abort()
  await assert.rejects(running, /cancelled/)
  assert.match(JSON.stringify(await evaluate("typeof win")), /undefined/)
  assert.equal(calls.length, before)
  const simultaneous = await Promise.all([
    evaluate(
      "let sequence=1; await new Promise(r=>setTimeout(r,10)); sequence"
    ),
    evaluate("sequence+=1"),
  ])
  assert.match(JSON.stringify(simultaneous[1]), /2/)
  const images = await evaluate(
    'for (let i=0;i<4;i++) emitImage({type:"image",data:"A".repeat(9*1024*1024),mimeType:"image/png"})'
  )
  assert.equal(images.filter((b) => b.type === "image").length, 2)
  assert.ok(Buffer.byteLength(JSON.stringify(images)) < 32 * 1024 * 1024)
  for (const block of images)
    if (block.type === "text") {
      const receipt = z
        .object({ path: z.string(), bytes: z.number() })
        .parse(JSON.parse(block.text))
      const bytes = await readFile(receipt.path)
      assert.equal(bytes.length, ((9 * 1024 * 1024) / 4) * 3)
      assert.ok(bytes.equals(Buffer.alloc(bytes.length)))
    }
  summary.losslessImageBudget = true
  summary.nativeWorker = true
} finally {
  await native.close()
  await rm(nativeArtifacts, { recursive: true, force: true })
}
console.log(JSON.stringify(summary))
console.log(
  "Unified MCP: persistent JS, focused docs, explicit images, lossless values, shared CLI refs/state, error evidence, reset/cancel/timeout, late-call refusal and owner cleanup passed"
)
