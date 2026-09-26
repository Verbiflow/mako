import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * A stopped turn says so once. Native history can place the provider's own
 * "Interrupted" marker above the reply; the turn's footer already says
 * Stopped, so the marker is not shown again. The screenshot stays in the
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
  const root = await mkdtemp(join(tmpdir(), "mako-stopped-turn-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-stopped-turn-check", main: fileURLToPath(import.meta.url) }))
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
    console.error("Stopped turn verification exceeded its 90-second limit")
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
  await window.loadURL(`${base}?mock`)
  await until(`document.querySelector('[aria-label="Thread view"]') !== null`)
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: 'dark'}))`)
  await evaluate(`(async () => {
    const path = '/Users/me/.codex/sessions/stopped.jsonl'
    const ref = { harness: 'codex', nativeId: 'stopped', path, cwd: '/Users/me/flage', title: 'Stopped turn', updatedAt: new Date().toISOString() }
    const openThread = window.mako.openThread
    window.mako.openThread = async (asked) => asked === path ? { ref, entries: [
      { kind: 'user', id: 'u1', text: 'Run sleep 120 in the foreground and tell me the output.' },
      { kind: 'event', id: 'e1', label: 'Interrupted' },
      { kind: 'assistant', id: 'a1', blocks: [
        { type: 'text', text: 'I will run the command in the foreground and report its output when it finishes.' },
        { type: 'tool', id: 't1', name: 'exec', input: '{"command":"sleep 120"}', canceled: true },
      ] },
    ] } : openThread(asked)
    const { threads } = await import('/src/state/threads.ts')
    await threads.view(ref, 'native')
    return true
  })()`)
  await until(`document.querySelector('[data-exchange]') !== null && document.body.innerText.includes('report its output')`, "the stopped turn rendered")
  await settle()
  const turn = await evaluate(`(() => { const text = document.querySelector('[data-exchange]').innerText; return { interrupted: (text.match(/\\bInterrupted\\b/g) ?? []).length, stopped: /\\bStopped\\b/.test(text) } })()`)
  await writeFile(join(root, "stopped-turn.png"), (await page.capturePage()).toPNG())
  console.log(JSON.stringify(turn))
  assert.equal(turn.stopped, true, "the footer says the turn stopped")
  assert.equal(turn.interrupted, 0, "the provider marker does not repeat the footer")
  clearTimeout(watchdog)
  console.log("Stopped turn: the footer says Stopped and the provider marker is not shown twice")
  app.exit(0)
}
