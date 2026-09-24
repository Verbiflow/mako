import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startCocoaFixture } from "./lib/cocoa-fixture.mjs"
import { sampleFrontmost } from "./lib/control-fixture.mjs"

// Real packaged host, socket worker, MCP HTTP transport, installed browser
// extension and native driver. Only disposable fixture targets are mutated.
const worker = process.argv[2] === "--worker"
const argument = process.argv[worker ? 3 : 2]
assert.ok(argument, "Use test-packaged-control-mcp.mjs <Mako.app>")
const app = await realpath(resolve(argument))
const executable = join(app, "Contents/MacOS/Mako")
if (!worker) {
  const result = await promisify(execFile)(executable,
    [fileURLToPath(import.meta.url), "--worker", app], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 120_000, maxBuffer: 1024 * 1024,
    })
  process.stdout.write(result.stdout)
} else {
  assert.equal(await realpath(process.execPath), executable)
  const archive = join(app, "Contents/Resources/app.asar")
  const from = path => import(pathToFileURL(join(archive, path)).href)
  const { BrowserService } = await from("node_modules/@mako/control-runtime/dist/browser-service.js")
  const { extensionBrowsers } = await from("node_modules/@mako/control-runtime/dist/browser-extension-registration.js")
  const { startControlService } = await from("dist-electron/control-service.js")
  const { ControlSessions } = await from("dist-electron/control-sessions.js")
  const { startConversationMcp } = await from("dist-electron/conversation-mcp.js")
  const { ensureCuaEmbedded, stopCuaEmbedded } = await from("dist-electron/cua-embedded.js")
  const { resolveExecutable } = await from("dist-electron/executable.js")
  const manifest = JSON.parse(await readFile(join(archive, "package.json"), "utf8"))
  const root = await mkdtemp(join(tmpdir(), "mako-packaged-mcp-"))
  const evidence = { build: manifest.makoBuild, app, status: "running", root, calls: [] }
  const saves = []
  const page = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/save") {
      let body = ""
      for await (const bytes of request) {
        body += bytes
        if (body.length > 8192) { response.writeHead(413).end(); return }
      }
      saves.push(JSON.parse(body))
      response.end("Saved successfully")
      return
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(`<!doctype html><title>Mako packaged MCP fixture</title>
      <form aria-label="Shipping"><label>Recipient <input aria-label="Recipient" value="Old shipping"></label><button>Save</button><output aria-label="Result"></output></form>
      <form aria-label="Billing"><label>Recipient <input aria-label="Recipient" value="Keep billing unchanged"></label><button>Save</button></form>
      <script>document.forms[0].onsubmit=async e=>{e.preventDefault();if(!confirm('Save this Shipping recipient?'))return;const response=await fetch('/save',{method:'POST',body:JSON.stringify({value:document.forms[0].querySelector('input').value,trusted:e.isTrusted})});document.querySelector('output').textContent=await response.text()};document.forms[1].onsubmit=e=>e.preventDefault()</script>`)
  })
  await new Promise(done => page.listen(0, "127.0.0.1", done))
  const browsers = new BrowserService(await extensionBrowsers(), { preferencePath: join(root, "preferences.json") })
  const service = await startControlService(browsers, () => {})
  const sessions = new ControlSessions(async () => {
    const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.packaged-mcp")
    assert.ok(socket, "Installed native driver is required")
    return { socket, driver: resolveExecutable("cua-driver") }
  })
  const grants = await startConversationMcp({
    authorizeAgent: (conversation, binding) => {
      assert.equal(conversation, "packaged-mcp")
      assert.equal(binding, "fixture")
    },
    availableProviders: () => [], delegate: async () => {}, childTasks: () => [], cancelChild: () => {},
  }, (binding, operation, signal) => sessions.request(binding, operation, signal))
  const client = new Client({ name: "packaged-acceptance", version: "1" })
  let fixture, sampler
  const js = async (code, failed = false) => {
    const started = performance.now()
    const result = await client.callTool({ name: "js", arguments: { code, timeout_ms: 20000 } })
    evidence.calls.push({ elapsedMs: Math.round(performance.now() - started), error: result.isError === true })
    assert.equal(result.isError === true, failed, JSON.stringify(result))
    return result
  }
  const last = result => JSON.parse(result.content.filter(block => block.type === "text").at(-1).text)
  try {
    await sessions.start("fixture", service.mint("packaged-mcp", "fixture"), async () => { await service.revoke("packaged-mcp", "fixture") })
    const grant = grants.mint("fixture", "packaged-mcp")
    await client.connect(new StreamableHTTPClientTransport(new URL(grant.controlUrl), {
      requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
    }))
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["js", "js_reset"])
    const inventory = last(await js("await control.browsers()"))
    const aside = inventory.browsers.filter(browser => browser.product === "Aside")
    assert.equal(aside.length, 1, "Acceptance needs one exact installed Aside profile")
    const value = "  Zoë 東京 🧪 00123  "
    await js(`await control.connectBrowser(${JSON.stringify(aside[0].id)}); let tab=await control.openTab({browser:${JSON.stringify(aside[0].id)},url:${JSON.stringify(`http://127.0.0.1:${page.address().port}`)},background:true}); await tab.observe()`)
    await js(`await tab.locator({role:'form',name:'Shipping'}).locator({role:'textbox',name:'Recipient'}).setValue(${JSON.stringify(value)})`)
    const interrupted = await js("await tab.locator({role:'form',name:'Shipping'}).locator({role:'button',name:'Save'}).click()", true)
    assert.match(JSON.stringify(interrupted), /dialog-open/)
    await js("let dialog=await tab.dialog({}); if(dialog.pending?.type!=='confirm')throw Error('Missing fixture confirmation'); await tab.dialog({respond:'accept'}); await tab.observe()")
    await js(`await tab.expect({within:[{role:'form',name:'Shipping'}],role:'textbox',name:'Recipient',value:${JSON.stringify(value)}}); await tab.expect({within:[{role:'form',name:'Billing'}],role:'textbox',name:'Recipient',value:'Keep billing unchanged'}); await tab.observe()`)
    assert.deepEqual(saves, [{ value, trusted: true }])
    const target = last(await js("tab.target"))
    const reset = await client.callTool({ name: "js_reset", arguments: {} })
    assert.ok(!reset.isError)
    assert.equal(last(await js("typeof tab")), "undefined")
    const image = await js(`let tab=control.tab(${JSON.stringify(target)}); emitImage(await tab.locator({role:'form',name:'Shipping'}).screenshot())`)
    assert.ok(image.content.some(block => block.type === "image"))
    await js('setTimeout(()=>{throw Error("late packaged fixture callback")},100); "scheduled"')
    await new Promise(done => setTimeout(done, 300))
    assert.equal(last(await js("typeof tab")), "undefined")
    await js(`let tab=control.tab(${JSON.stringify(target)}); await tab.observe()`)
    await js("await tab.close()")
    evidence.browser = { transport: "installed Aside extension", exactSaveCount: saves.length, resetPreservedTarget: true, idleWorkerFaultPreservedTarget: true, screenshot: true }
    fixture = await startCocoaFixture({ root, title: "Mako packaged MCP native proof" })
    const { pid } = await fixture.started()
    sampler = sampleFrontmost()
    const windows = last(await js(`await control.windows(${pid})`))
    const selected = windows.windows.filter(window => window.title === "Mako packaged MCP native proof")
    assert.equal(selected.length, 1)
    const nativeValue = "  Renée é 🧪 00123  "
    await js(`let win=control.window({pid:${pid},window_id:${selected[0].window_id}}); await win.observe(); await win.locator({role:'TextField',name:'Proof'}).setValue(${JSON.stringify(nativeValue)}); await win.observe(); await win.locator({role:'Button',name:'Verify proof'}).click(); await win.expect({role:'StaticText',name:'Result',value:${JSON.stringify(nativeValue)}})`)
    const nativeImage = await js("emitImage(await win.screenshot())")
    assert.ok(nativeImage.content.some(block => block.type === "image"))
    const state = await fixture.state()
    assert.equal(state.input, nativeValue)
    assert.equal(state.value, nativeValue)
    const seen = await sampler.stop()
    sampler = undefined
    assert.ok(!seen.has(pid), "Native fixture took the foreground")
    evidence.native = { exactValue: true, targetFronted: false, screenshot: true }
    evidence.status = "passed"
  } catch (error) {
    evidence.status = "failed"
    evidence.error = error.message
    throw error
  } finally {
    await sampler?.stop()
    await client.close()
    grants.close()
    await sessions.close()
    service.close()
    fixture?.stop()
    await stopCuaEmbedded()
    await new Promise(done => page.close(done))
    await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence))
  }
}
