import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.versions.electron) {
  const { app } = await import("electron")
  void checkClipboard().then(() => app.exit(0)).catch(error => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-clipboard-ui-"))
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-clipboard-check", main: fileURLToPath(import.meta.url) }))
  const host = process.argv[2]
  if (host) assert.ok(["127.0.0.1", "localhost"].includes(new URL(host).hostname))
  const env = { ...process.env, MAKO_CLIPBOARD_ROOT: root, MAKO_CLIPBOARD_URL: server.resolvedUrls.local[0] }
  if (host) env.MAKO_CLIPBOARD_HOST = host
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Clipboard UI evidence: ${root}`)
}

async function checkClipboard() {
  const { app, BrowserWindow, clipboard, nativeImage } = await import("electron")
  const root = process.env.MAKO_CLIPBOARD_ROOT
  const base = process.env.MAKO_CLIPBOARD_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const savedClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF() }
  const savedImage = clipboard.readImage()
  if (!savedImage.isEmpty()) savedClipboard.image = savedImage
  const windows = []
  const png = nativeImage.createFromBitmap(Buffer.alloc(80 * 60 * 4, 255), { width: 80, height: 60 }).toPNG()
  await writeFile(join(root, "Screenshot.png"), png)
  const imageUrl = `data:image/png;base64,${png.toString("base64")}`
  const watchdog = setTimeout(() => app.exit(1), 120_000)
  const createPage = async (host) => {
    const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    windows.push(window)
    const page = window.webContents
    page.debugger.attach("1.3")
    await window.loadURL(new URL(`${host ? "" : "scripts/live-workflow.html"}?preview=clipboard-${windows.length}`, host ?? base).href)
    await until(page, "Boolean(document.querySelector('.composer-input:not([readonly])'))")
    if (!host) await page.executeJavaScript(`(() => {
      window.mako.stageFile = async name => ({path:'/clipboard-fixture/'+crypto.randomUUID()+'-'+name,name,size:1});
      window.mako.readFile = async path => ({path,kind:'image',previewUrl:${JSON.stringify(imageUrl)}});
      window.mako.resolveFileUrl = url => url;
      window.mako.copy = text => navigator.clipboard.writeText(text);
    })()`)
    return page
  }
  const until = async (page, code) => {
    const deadline = Date.now() + 10_000
    while (!(await page.executeJavaScript(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${code}`)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  const click = async (page, selector) => {
    const point = await page.executeJavaScript(`(() => {const node=document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center'}); const box=node.getBoundingClientRect(); return {x:box.x+box.width/2,y:box.y+box.height/2};})()`)
    for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", {type,button:"left",clickCount:1,...point})
  }
  const value = page => page.executeJavaScript("document.querySelector('.composer-input').value")
  const select = (page, start = 0, end = null) => page.executeJavaScript(`(() => {const input=document.querySelector('.composer-input'); input.focus(); input.setSelectionRange(${start},${end ?? "input.value.length"});})()`)
  const preview = page => until(page, "(() => {const buttons=[...document.querySelectorAll('[aria-label=\"Attachments\"] [aria-label^=\"Preview \"]')]; return buttons.length > 0 && buttons.every(button => button.querySelector('canvas[data-ready]')?.width > 0)})()")
  const paste = async page => {
    page.paste()
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  try {
    const source = await createPage()
    await select(source)
    await source.debugger.sendCommand("Input.insertText", { text: "Compare @src/index.css @thread:claude:clipboard-test " })
    assert.ok(!nativeImage.createFromBuffer(png).isEmpty(), "Screenshot fixture must decode")
    clipboard.writeImage(nativeImage.createFromBuffer(png))
    await source.executeJavaScript("document.querySelector('.composer-input').addEventListener('paste', event => {window.pastedKinds={types:[...event.clipboardData.types],files:event.clipboardData.files.length}}, {once:true})")
    await paste(source)
    console.log("Native screenshot paste:", clipboard.availableFormats(), await source.executeJavaScript("window.pastedKinds"))
    await preview(source)
    await until(source, "!document.querySelector('[aria-label=\"Attachments\"] [title*=\"Adding\"]')")
    await select(source)
    source.copy()
    await new Promise(resolve => setTimeout(resolve, 100))
    const target = await createPage()
    await select(target)
    await paste(target)
    await preview(target)
    assert.equal(await value(target), await value(source), "Cross-window paste preserves the text and references")
    await writeFile(join(root, "cross-window.png"), (await target.capturePage()).toPNG())
    await select(target)
    target.cut()
    await until(target, "document.querySelector('.composer-input').value === '' && !document.querySelector('[aria-label=\"Attachments\"]')")
    await paste(target)
    await preview(target)
    assert.match(await value(target), /^Compare @src\/index.css @thread:claude:clipboard-test \[image.png \(2\)\]$/, "Cut/paste reserves the undoable reference and restores its preview")
    await select(target, "document.querySelector('.composer-input').value.length")
    await paste(target)
    await until(target, "document.querySelectorAll('[data-attachment-reference]').length === 2")
    await preview(target)
    await select(source, 0, 7)
    await source.executeJavaScript(`(() => {const data=new DataTransfer(); data.setData('text/plain','Mixed text '); data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png.toString("base64"))}), ch=>ch.charCodeAt(0))], 'mixed.png', {type:'image/png'})); document.querySelector('.composer-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`)
    await until(source, "document.querySelectorAll('[data-attachment-reference]').length === 2")
    assert.match(await value(source), /^Mixed text \[mixed.png\] @src\/index.css/, "Mixed paste inserts text and image while replacing only the selection")
    await select(target)
    await source.executeJavaScript("document.querySelector('.composer-input').focus()")
    await select(source, "document.querySelector('.composer-input').value.indexOf('[image.png]')", "document.querySelector('.composer-input').value.indexOf('[image.png]') + '[image.png]'.length")
    source.copy()
    await new Promise(resolve => setTimeout(resolve, 100))
    await paste(source)
    assert.ok(!(await value(source)).includes("\n"), "Replacing a reference must not strand text and append the replacement elsewhere")
    await preview(source)
    source.undo()
    await until(source, "document.querySelector('.composer-input').value.includes('[image.png]')")
    await preview(source)
    source.redo()
    await until(source, "!document.querySelector('.composer-input').value.includes('[image.png]')")
    await preview(source)
    const copiedText = clipboard.readText()
    const copiedHtml = clipboard.readHTML()
    const question = await createPage()
    await question.executeJavaScript(`import('/src/dev/clipboard-check.tsx').then(({mountClipboardQuestion}) => mountClipboardQuestion(${JSON.stringify(`Question @src/index.css $review @thread:claude:clipboard-test\n${copiedText}`)}))`)
    await until(question, "Boolean(document.querySelector('#clipboard-question [aria-label=\"Copy question\"]'))")
    await click(question, '#clipboard-question [aria-label="Copy question"]')
    await until(question, "document.querySelector('#clipboard-question [aria-label=\"Copy question\"]').textContent.includes('Copied question')")
    const fromQuestion = await createPage()
    await select(fromQuestion)
    await paste(fromQuestion)
    await preview(fromQuestion)
    assert.match(await value(fromQuestion), /^Question @src\/index.css \$review @thread:claude:clipboard-test/, "Copy question retains references")
    await question.executeJavaScript("(() => {document.activeElement?.blur(); const node=document.querySelector('#clipboard-question .prompt-prose'); const range=document.createRange(); range.selectNodeContents(node); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);})()")
    question.copy()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.match(clipboard.readText(), /@src\/index.css \$review @thread:claude:clipboard-test/, "Selected transcript chips retain their full reference tokens")
    const selectedQuestion = await createPage()
    await select(selectedQuestion)
    await paste(selectedQuestion)
    await preview(selectedQuestion)
    await writeFile(join(root, "question-selection.png"), (await selectedQuestion.capturePage()).toPNG())
    const plain = await createPage()
    clipboard.writeText(copiedText)
    await select(plain)
    await paste(plain)
    await preview(plain)
    const missing = await createPage()
    await missing.executeJavaScript("window.mako.readFile = async () => {throw new Error('Fixture file was removed')}; void 0")
    clipboard.write({text:copiedText,html:copiedHtml})
    await select(missing)
    await paste(missing)
    await until(missing, "document.querySelector('[aria-label=\"Attachments\"]').textContent.includes('Preview unavailable')")
    console.log("PASS: native screenshots, mixed paste, cross-window clipboard, references, cut/paste, repeated paste, selection replacement, undo/redo, Copy question, transcript selection, plain-text fallback, and unavailable previews")
    const pending = await createPage()
    await pending.executeJavaScript("window.mako.stageFile = name => new Promise(resolve => {window.finishClipboardStage = () => resolve({path:'/clipboard-fixture/pending-'+name,name,size:1})}); void 0")
    await select(pending)
    clipboard.writeImage(nativeImage.createFromBuffer(png))
    await paste(pending)
    await until(pending, "Boolean(window.finishClipboardStage)")
    const pendingText = await value(pending)
    await select(pending)
    pending.cut()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await value(pending), pendingText, "Cut must not remove an attachment that is still staging")
    await pending.executeJavaScript("window.finishClipboardStage()")
    await until(pending, "!document.querySelector('[aria-label=\"Attachments\"] [title*=\"Adding\"]')")
    await source.executeJavaScript("(async () => {const {getMako}=await import('/src/lib/bridge.ts');getMako().livePrompt=async (...args)=>{window.copiedAttachmentSend=args};})()")
    const stagedPaths = await source.executeJavaScript("import('/src/lib/draft-persistence.ts').then(({readAttachmentDrafts}) => Object.values(readAttachmentDrafts()).flat().map(item=>item.stagedPath))")
    await click(source, 'button[aria-label="Send"]')
    await until(source, "Boolean(window.copiedAttachmentSend)")
    const sent = await source.executeJavaScript("JSON.stringify(window.copiedAttachmentSend)")
    assert.ok(stagedPaths.length > 0)
    for (const path of stagedPaths) assert.ok(sent.includes(path), "Every pasted attachment reaches the outgoing provider payload")
    console.log("PASS: pending cut keeps the draft intact and pasted attachments survive the outgoing payload")
    const host = process.env.MAKO_CLIPBOARD_HOST
    if (host) {
      const realSource = await createPage(host)
      await select(realSource)
      await realSource.debugger.sendCommand("Input.insertText", {text:"Screenshot round trip @src/index.css "})
      clipboard.writeImage(nativeImage.createFromBuffer(png))
      await paste(realSource)
      await preview(realSource)
      await until(realSource, "!document.querySelector('[aria-label=\"Attachments\"] [title*=\"Adding\"]')")
      const originalText = await value(realSource)
      await select(realSource)
      realSource.copy()
      await new Promise(resolve => setTimeout(resolve, 100))
      const realTarget = await createPage(host)
      await select(realTarget)
      await paste(realTarget)
      await preview(realTarget)
      assert.equal(await value(realTarget), originalText)
      await click(realTarget, '[aria-label="Attachments"] [aria-label^="Preview "]')
      await until(realTarget, "(() => {const content=document.querySelector('[data-slot=\"popover-content\"]');return content?.getAttribute('data-state') === 'open' && getComputedStyle(content).opacity === '1' && content.querySelector('img')?.naturalWidth > 0})()")
      const pixels = await realTarget.executeJavaScript("(() => {const image=document.querySelector('[data-slot=\"popover-content\"] img'); const canvas=document.createElement('canvas'); canvas.width=image.naturalWidth;canvas.height=image.naturalHeight; const context=canvas.getContext('2d');context.drawImage(image,0,0);return {width:canvas.width,height:canvas.height,pixel:[...context.getImageData(0,0,1,1).data]};})()")
      assert.deepEqual(pixels, {width:80,height:60,pixel:[255,255,255,255]})
      await realTarget.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
      await writeFile(join(root, "real-host-preview.png"), (await realTarget.capturePage()).toPNG())
      await new Promise(resolve => {realTarget.once('did-finish-load', resolve);realTarget.reload()})
      await until(realTarget, "Boolean(document.querySelector('.composer-input:not([readonly])'))")
      await preview(realTarget)
      assert.equal(await value(realTarget), originalText)
      console.log("PASS: real host stages the native screenshot, another window reloads the exact pixels, the enlarged preview opens, and the pasted draft survives reload; no provider prompt sent")
    }
  } catch (error) {
    for (const [index, window] of windows.entries()) await writeFile(join(root, `failure-${index}.png`), (await window.webContents.capturePage()).toPNG())
    throw error
  } finally {
    clearTimeout(watchdog)
    for (const window of windows) window.destroy()
    clipboard.write(savedClipboard)
  }
}
