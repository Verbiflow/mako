import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * Folder counts across window focus, against the production rail and a
 * catalogue larger than the rail's cap (the reported one has 1,500
 * sessions). The catalogue re-announcing old sessions must leave the rows a
 * reload returns, and focusing the window must neither reload the catalogue
 * nor refresh Git more than once. Screenshots of each step stay in the
 * printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-rail-focus-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-rail-focus-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolveExit(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`UI evidence: ${root}`)
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  const watchdog = setTimeout(() => {
    console.error("Rail focus verification exceeded its 90-second limit")
    app.exit(1)
  }, 90_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = async () => {
    await evaluate(`Promise.all([...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].flatMap(node => node.getAnimations()).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
  }
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => true)")
    await settle()
    const rail = await evaluate(`(() => { const r = document.querySelector('.thread-jump-scope').getBoundingClientRect(); return {x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height)} })()`)
    await writeFile(join(root, name), (await page.capturePage(rail)).toPNG())
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  // Each folder's "More" count as the rail shows it.
  const counts = () => evaluate(`Object.fromEntries([...document.querySelectorAll('.thread-jump-scope section')].map(section => [section.querySelector('[data-flip-key^="folder:"]')?.dataset.flipKey, [...section.querySelectorAll('button')].find(button => button.textContent.startsWith('More'))?.querySelector('span')?.textContent ?? null]).filter(([key]) => key))`)
  const calls = () => evaluate("({ ...window.__railCalls })")

  await window.loadURL(`${base}?mock`)
  await until(`document.querySelector('[aria-label="Thread view"]') !== null`)
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark'}))`)
  // The host's side: a 1,500-session catalogue answered with the rail list.
  await evaluate(`Promise.all([import('/electron/contracts/thread-list.ts'), import('/src/state/threads.ts')]).then(async ([{threadList}, {threads}]) => {
    const start = Date.parse('2026-01-01T00:00:00.000Z')
    window.__railCatalog = Array.from({ length: 1500 }, (_, index) => ({
      harness: 'codex',
      nativeId: 'rail-' + index,
      path: '/Users/me/.codex/sessions/rail-' + index + '.jsonl',
      cwd: index % 3 ? '/Users/me/flage' : '/Users/me/other',
      title: 'Session ' + index,
      updatedAt: new Date(start + index * 60_000).toISOString(),
    }))
    window.__railCalls = { threads: 0, git: 0 }
    const gitStatus = window.mako.gitStatus
    window.mako.gitStatus = async (...args) => { window.__railCalls.git++; return gitStatus(...args) }
    window.mako.threads = async () => { window.__railCalls.threads++; return { ready: true, threads: threadList(window.__railCatalog), activity: {} } }
    await threads.load()
    return true
  })`)
  const flage = "folder:/Users/me/flage"
  await until(`document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(flage)}]') !== null`, "the flage folder rendered")
  // Folders gone cold render collapsed; open flage so its count shows.
  await evaluate(`(() => { const node = document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(flage)}]'); (node.matches('button') ? node : node.querySelector('button') ?? node).click(); return true })()`)
  await until(`[...document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(flage)}]').closest('section').querySelectorAll('[data-thread-row]')].some(row => row.getBoundingClientRect().height > 0)`, "the flage folder opened")
  await settle()
  const loaded = await counts()
  assert.ok(Number(loaded[flage]) > 0, `the flage folder has more rows than it shows, received ${JSON.stringify(loaded)}`)
  await capture("1-loaded.png")

  // The catalogue re-announces 200 of the oldest sessions, as a provider rescan does.
  await evaluate(`import('/src/state/threads.ts').then(({applyThreadRef}) => { for (const ref of window.__railCatalog.slice(0, 200)) applyThreadRef(ref); return true })`)
  await settle()
  const pushed = await counts()
  await capture("2-after-pushes.png")

  const focused = []
  const before = await calls()
  for (let index = 0; index < 3; index++) {
    await evaluate("window.dispatchEvent(new Event('focus')); true")
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
    await settle()
    focused.push(await counts())
  }
  const after = await calls()
  await capture("3-after-focus.png")
  const report = { loaded: loaded[flage], pushed: pushed[flage], focused: focused.map((entry) => entry[flage]), calls: { threads: after.threads - before.threads, git: after.git - before.git } }
  console.log(JSON.stringify(report))
  assert.deepEqual(pushed, loaded, "pushes of old sessions leave every folder's count")
  for (const entry of focused) assert.deepEqual(entry, loaded, "focus leaves every folder's count")
  assert.equal(report.calls.threads, 0, "focus does not reload the catalogue")
  assert.equal(report.calls.git, 3, "each focus refreshes Git once")

  clearTimeout(watchdog)
  console.log("Rail focus checks clean: folder counts hold across re-announced sessions and focus; focus refreshes Git once and never reloads the catalogue")
  app.exit(0)
}
