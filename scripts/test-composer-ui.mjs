import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.versions.electron) {
  void checkComposer().then(async () => {
    const { app } = await import("electron")
    app.exit(0)
  }).catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const url = process.argv[2]
  assert.ok(url, "Pass the URL printed by npm run dev")
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  const root = await mkdtemp(join(tmpdir(), "mako-composer-ui-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-composer-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_COMPOSER_CHECK_ROOT: root, MAKO_COMPOSER_CHECK_URL: url }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
  console.log(`Composer UI evidence: ${root}`)
}

async function checkComposer() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_COMPOSER_CHECK_ROOT
  const base = process.env.MAKO_COMPOSER_CHECK_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))")
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const until = async (code) => {
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}`)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  const click = async (selector, text = "") => {
    const point = await evaluate(`(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.startsWith(${JSON.stringify(text)})); if (!node) throw new Error('Missing target'); const r = node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
    for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, modifiers })
  }
  const inputValue = () => evaluate("document.querySelector('.composer-input').value")
  const fixtureFiles = ["notes.txt", "report [notes.txt]"]
  for (const name of fixtureFiles) await writeFile(join(root, name), `Fixture ${name}`)
  const attach = async (name) => {
    const { root: document } = await page.debugger.sendCommand("DOM.getDocument")
    const { nodeId } = await page.debugger.sendCommand("DOM.querySelector", { nodeId: document.nodeId, selector: 'input[type="file"]' })
    await page.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: [join(root, name)] })
    await until(`document.querySelector('[aria-label="Remove ${name}"]') !== null`)
  }
  const watchdog = setTimeout(() => app.exit(1), 240_000)
  try {
    await window.loadURL(new URL("scripts/live-workflow.html", base).href)
    await until("Boolean(document.querySelector('.composer-input'))")
    await click(".composer-input")
    await page.debugger.sendCommand("Input.insertText", { text: "Compare " })
    await attach("notes.txt")
    await attach("report [notes.txt]")
    await capture("attachments.png")
    assert.equal(await evaluate("document.querySelectorAll('[data-attachment-reference]').length"), 2)
    await click('[aria-label="Remove notes.txt"]')
    assert.equal(await inputValue(), "Compare  [report [notes.txt]] ")
    await click(".composer-input")
    await page.debugger.sendCommand("Input.insertText", { text: "x" })
    assert.equal(await evaluate("document.querySelectorAll('[aria-label^=\"Remove \" ]').length"), 1)
    await evaluate("(() => { const input = document.querySelector('.composer-input'); input.setSelectionRange(input.value.indexOf('[report'), input.value.indexOf('[report')); })()")
    await key("Delete", "Delete", 46)
    await until("document.querySelectorAll('[data-attachment-reference]').length === 0")
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 4, commands: ["undo"] })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 4 })
    await until("document.querySelectorAll('[data-attachment-reference]').length === 1")
    assert.ok((await inputValue()).includes("[report [notes.txt]]"))
    await evaluate("(() => { const input = document.querySelector('.composer-input'); const at = input.value.indexOf(']]') + 2; input.setSelectionRange(at, at); })()")
    await key("Backspace", "Backspace", 8)
    await until("document.querySelectorAll('[data-attachment-reference]').length === 0")
    await evaluate("window.mako.stageFile = name => new Promise(resolve => {window.finishAttachmentStaging = () => resolve({path:'/retained/'+name,name,size:0})}); void 0")
    await attach("notes.txt")
    assert.ok((await inputValue()).includes("[notes.txt (3)]"), "A newly attached file must not reuse an undoable file's reference")
    await until("Boolean(window.finishAttachmentStaging)")
    await evaluate("window.dispatchEvent(new CustomEvent('mako:compose',{detail:{text:'Reuse [reused.txt]',attachments:[{id:'reused',index:3,reference:'[reused.txt]',name:'reused.txt',mimeType:'text/plain',kind:'text',size:1,stagedPath:'/retained/reused.txt'}]}}))")
    await until("document.querySelectorAll('[data-attachment-reference]').length === 2")
    await click('[aria-label="Remove reused.txt"]')
    await evaluate("window.finishAttachmentStaging()")
    await page.debugger.sendCommand("Input.insertText", { text: " next" })
    assert.equal(await evaluate("document.querySelectorAll('[data-attachment-reference]').length"), 1)
    await evaluate("(async () => { const {getMako} = await import('/src/lib/bridge.ts'); getMako().livePrompt = async (...args) => {window.sentAttachmentPrompt = args}; })()")
    await click('button[aria-label="Send"]')
    await until("Boolean(window.sentAttachmentPrompt)")
    const sent = await evaluate("window.sentAttachmentPrompt")
    assert.ok(JSON.stringify(sent).includes("[Attachment 4]"), "Late staging must retain the index assigned during reuse")
    assert.ok(!JSON.stringify(sent).includes("reused.txt"))
    assert.ok(!JSON.stringify(sent).includes("report [notes.txt]"))
    console.log("PASS: real file input, nested filenames, remove button, Delete, Backspace, undo, reattachment, and outgoing payload")

    await window.loadURL(base)
    await until("Boolean(document.querySelector('.composer-input')) && document.querySelectorAll('[data-thread-row]').length > 0")
    const cwd = await evaluate("window.mako.boot().then(boot => (boot.tabs.find(tab => tab.id === boot.activeTabId) ?? boot.tabs[0]).session.meta.cwd)")
    const profiles = await evaluate("window.mako.harnessProfiles()")
    assert.ok(profiles.length > 0)
    const results = []
    for (const { id, label } of profiles) {
      const result = await evaluate(`(async () => { const profile = await window.mako.harnessTuning(${JSON.stringify(id)}, ${JSON.stringify(cwd)}, true); const {resolveComposerSettingsInput} = await import('/src/state/composer-settings.ts'); const view = resolveComposerSettingsInput({target:{kind:'new',harness:profile.id,cwd:${JSON.stringify(cwd)}},profile}); const {settingValueLabel} = await import('/src/components/composer/settings-source.ts'); const controls = view.options.filter(option => option.role).map(option => {const current = view.resolved.options[option.id]; if(current?.kind !== 'known') return null; const value = settingValueLabel(option,current.value); return option.role === 'reasoning' ? value+' reasoning' : value}); return {id:profile.id,available:profile.available,error:profile.error ?? profile.configurationError,modelLabel:view.model?.label,resolved:view.resolved,expectedControls:controls}; })()`)
      results.push(result)
      if (!result.available || !result.modelLabel) {
        console.error(`UNVERIFIED: ${id}: ${result.error ?? "no effective model reported"}`)
        continue
      }
      await click('[data-composer] [data-model-picker]')
      await until(`Boolean([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(node => node.textContent.startsWith(${JSON.stringify(label)})))`)
      await click('[role="menu"] [role="menuitem"]', label)
      await key("Escape", "Escape", 27)
      await until(`Boolean(document.querySelector(${JSON.stringify(`[data-composer] [data-model-picker][data-harness="${id}"][aria-label="Model: ${result.modelLabel}"]`)}))`)
      await until("!document.querySelector('[role=\"menu\"]')")
      // Reasoning and speed ride in the one picker: its face names the effort, and a zap marks Fast.
      for (const expected of result.expectedControls.filter(Boolean)) await until(`(() => { const picker = document.querySelector('[data-composer] [data-model-picker]'); const expected = ${JSON.stringify(expected)}; return expected.endsWith(' reasoning') ? picker.textContent.includes(expected.slice(0, -' reasoning'.length)) : expected !== 'Fast' || Boolean(picker.querySelector('[aria-label="Fast"]')) })()`)
      result.controls = await evaluate("[...document.querySelectorAll('[data-composer] button[aria-label]')].map(node => node.getAttribute('aria-label'))")
      assert.ok(!result.controls.some((label) => /Provider default|: unknown/.test(label)))
      assert.equal(await inputValue(), "")
      await capture(`defaults-${id}.png`)
      console.log(`Provider ${id}: ${JSON.stringify(result.resolved.settings)}`)
    }
    await writeFile(join(root, "provider-defaults.json"), JSON.stringify(results, null, 2))
    assert.ok(results.every(result => result.available && result.modelLabel && !result.error && result.expectedControls.every(Boolean)), "Some providers did not report complete defaults; see provider-defaults.json")
    console.log("PASS: real host provider model controls match fresh discovery without sending a provider prompt")
  } catch (error) {
    await capture("failure.png")
    throw error
  } finally {
    clearTimeout(watchdog)
    window.destroy()
  }
}
