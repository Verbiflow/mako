import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

// Production rail, search and viewing actions with an isolated bridge/profile.
// Native internal-review metadata, never titles or a worker's selected role,
// decides which sessions are ordinary conversations. No provider is launched.
if (process.versions.electron) {
  void check().catch(async error => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electron } = await import("electron")
  const root = testScratch("mako-internal-review-ui-", { given: process.argv[2] })
  await mkdir(root, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: Number(process.env.MAKO_THREAD_PORT ?? 0), strictPort: true, watch: null, fs: { strict: false } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-internal-review-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_INTERNAL_UI_ROOT: root, MAKO_INTERNAL_UI_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electron, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(electronExit("The internal review UI check", code, signal)))
    })
  } finally { await server.close() }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_INTERNAL_UI_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The internal review UI check", ms: 120_000 })
  const errors = []
  page.on("console-message", details => { if (details.level === "error") errors.push(details.message) })
  const evaluate = code => page.executeJavaScript(code)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const frame = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
  const until = async (code, label = code) => {
    guard.at(label)
    const end = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) throw new Error(`Timed out: ${label}; ${errors.join("; ")}`)
      await pause(25)
    }
  }
  try {
    await window.loadURL(`${process.env.MAKO_INTERNAL_UI_URL}?mock`)
    await until("Boolean(document.querySelector('[data-composer] textarea'))", "the fixture desk")
    await evaluate(`(async () => {
      const t = await import('/src/state/threads.ts');
      const v = await import('/src/state/thread-viewing.ts');
      const tabs = await import('/src/state/thread-tabs.ts');
      const base = {harness:'codex', cwd:'/fixture/project', updatedAt:new Date().toISOString()};
      const internal = {...base, path:'/fixture/internal.jsonl', nativeId:'internal', title:'Guardian review', nativeAgent:{kind:'internal-review', source:'guardian_review', role:'guardian'}};
      const worker = {...base, path:'/fixture/worker.jsonl', nativeId:'worker', title:'Guardian worker conversation', nativeAgent:{kind:'agent', role:'guardian'}};
      const unknown = {...base, path:'/fixture/unknown.jsonl', nativeId:'unknown', title:'Unknown source conversation', nativeAgent:{kind:'unknown', role:'future'}};
      const stale = {...internal}; delete stale.nativeAgent;
      const refs = [internal, worker, unknown];
      const page = ref => ({ref,entries:ref===internal?[]:[{type:'user',id:'u',text:'Ordinary worker prompt'},{type:'text',id:'a',text:'Ordinary worker answer'}],start:0,total:ref===internal?0:2,hasEarlier:false});
      window.mako.resolveOwner = async () => null;
      window.mako.pageThread = async path => page(refs.find(ref=>ref.path===path));
      window.mako.previewThread = async () => null;
      window.mako.threadRun = async () => null;
      window.mako.followThread = async () => {};
      window.mako.unfollowThread = async () => {};
      window.reviewFixture = {t,v,tabs,internal,worker,unknown,stale};
      t.applyThreads(refs);
      return true;
    })()`)
    await frame()
    const only = process.env.MAKO_INTERNAL_UI_CASE
    if (!only || only === "rail") {
      const rows = await evaluate("[...document.querySelectorAll('[data-thread-row]')].map(n=>n.textContent)")
      assert.ok(!rows.some(text => text.includes("Guardian review")), "internal review absent from rendered rail")
      assert.ok(rows.some(text => text.includes("Guardian worker conversation")), "worker named guardian still renders")
      assert.ok(rows.some(text => text.includes("Unknown source conversation")), "new unknown source still renders")
      await evaluate("window.dispatchEvent(new CustomEvent('mako:search-threads')); true")
      await until("Boolean(document.querySelector('input[placeholder=\"Search every thread\"]'))")
      await evaluate("(() => {const n=document.querySelector('input[placeholder=\"Search every thread\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'Guardian');n.dispatchEvent(new Event('input',{bubbles:true}));return true})()")
      await until("document.querySelector('input[placeholder=\"Search every thread\"]').value === 'Guardian'")
      await frame()
      const found = await evaluate("[...document.querySelectorAll('[data-thread-row]')].map(n=>n.textContent)")
      assert.ok(!found.some(text=>text.includes('Guardian review')), "internal review absent from rendered search")
      assert.ok(found.some(text=>text.includes('Guardian worker conversation')), "worker remains searchable")
      console.log("PASS rail/search preserve worker and unknown source")
    }
    if (!only || only === "open") {
      await evaluate("reviewFixture.t.threads.view(reviewFixture.stale,'native').then(()=>true)")
      await frame()
      assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing?.ref.path === reviewFixture.internal.path"), false, "stale direct open cannot keep internal review in the viewer")
      assert.equal(await evaluate("reviewFixture.tabs.threadTabsStore.get().tabs.includes(reviewFixture.internal.path)"), false, "stale internal opened tab retired")
      assert.equal(await evaluate("Boolean(reviewFixture.v.rememberedThread(reviewFixture.internal.path))"), false, "internal transcript not cached as a conversation")
      console.log("PASS stale direct open retired after native metadata arrives")
    }
    if (!only || only === "late") {
      await evaluate(`(() => {const f=reviewFixture;f.v.rememberThread(f.v.viewedThread({ref:f.stale,entries:[]}));f.tabs.openThreadTab(f.stale.path);f.t.threadsStore.set({viewing:f.v.viewedThread({ref:f.stale,entries:[]})});f.t.applyThreadRef(f.internal);return true})()`)
      await frame()
      assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing?.ref.path === reviewFixture.internal.path"), false, "late classification retires historical open view")
      assert.equal(await evaluate("Boolean(reviewFixture.v.rememberedThread(reviewFixture.internal.path))"), false, "historical cached internal entry evicted")
      assert.equal(await evaluate("document.body.textContent.includes('This session has no readable conversation.')"), false, "internal review no longer shown as an empty conversation")
      console.log("PASS historical cached/open view reclassified")
      await evaluate(`(() => {const f=reviewFixture;f.v.rememberThread(f.v.viewedThread({ref:f.stale,entries:[]}));f.tabs.openThreadTab(f.stale.path);f.t.threadsStore.set({viewing:f.v.viewedThread({ref:f.stale,entries:[]})});f.t.applyThreads([f.internal,f.worker,f.unknown]);return true})()`)
      assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing?.ref.path === reviewFixture.internal.path"), false, "rehydration retires a restored internal view too")
    }
    await evaluate("reviewFixture.t.threads.view(reviewFixture.worker,'native').then(()=>true)")
    await until("document.body.textContent.includes('Ordinary worker prompt')", "real worker transcript")
    assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing.ref.nativeAgent.kind"), "agent")
    await evaluate("reviewFixture.t.threads.view(reviewFixture.internal).then(()=>true)")
    assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing.ref.path"), "/fixture/worker.jsonl", "a known internal open cannot displace an unrelated worker")
    await evaluate("reviewFixture.t.applyThreadRef(reviewFixture.internal); true")
    assert.equal(await evaluate("reviewFixture.t.threadsStore.get().viewing.ref.path"), "/fixture/worker.jsonl", "a late internal update cannot close another conversation")
    await writeFile(join(root, "guardian-ui.png"), (await page.capturePage()).toPNG())
    console.log("PASS normal worker opens; internal history remains a host-owned record")
    guard.done()
    window.destroy()
    app.exit(0)
  } catch (error) {
    await writeFile(join(root, "failure.png"), (await page.capturePage()).toPNG())
    throw error
  }
}
