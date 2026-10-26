import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// A turn Mako stopped because it couldn't save the conversation, as the live app draws it (`scripts/live-workflow.html`
// with its mock bridge): the turn's work, its failure row, then the row with Details open, in dark and light, written
// into <out> as <scene>-<theme>.png.
//
//   node scripts/unsaved-turn-screenshots.mjs <out> [--port 20024]
if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const out = resolve(args.find((arg, at) => !arg.startsWith("--") && !args[at - 1]?.startsWith("--")) ?? "unsaved-turn-screenshots")
  const port = Number(option("--port")) || 20024
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  await mkdir(join(out, "electron"), { recursive: true })
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true, hmr: false, watch: null } })
  await server.listen()
  await writeFile(join(out, "electron", "package.json"), JSON.stringify({ name: "mako-unsaved-turn-screenshots", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UNSAVED_SHOTS: out, MAKO_UNSAVED_URL: `http://127.0.0.1:${port}/scripts/live-workflow.html` }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [join(out, "electron")], { env, stdio: "inherit" })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Unsaved turn screenshots: ${out}`)
}

/** The live conversation, its last turn stopped by Mako because the journal couldn't be written. */
const SEED = `(async () => {
  const { acpStore } = await import("/src/state/acp-state.ts")
  const { applyLiveSnapshot } = await import("/src/state/live-recovery.ts")
  const { threadsStore } = await import("/src/state/thread-store.ts")
  threadsStore.set({ composerHarness: "codex" })
  const state = acpStore.get()
  const live = state.conversations[state.activeKey]
  const at = Date.UTC(2026, 9, 26, 18, 4)
  const request = "51111111-1111-4111-8111-111111111111"
  applyLiveSnapshot({
    session: { ...live.session, harness: "codex", status: "ready", connection: "connected" },
    epoch: "unsaved-fixture", revision: (live.revision ?? 0) + 1, createdAt: 1, base: null, permissions: [],
    control: live.control,
    blocks: [
      { type: "user", id: "u1", requestId: request, at, text: "Add a footer to the pricing page with the support links" },
      { type: "tool", id: "t1", at: at + 4000, name: "shell", title: "Read src/pages/pricing.tsx", status: "completed", input: "sed -n 1,120p src/pages/pricing.tsx", output: "export function Pricing() {" },
      { type: "tool", id: "t2", at: at + 9000, name: "apply_patch", title: "Edit src/pages/pricing.tsx", status: "completed", input: "*** Update File: src/pages/pricing.tsx", output: "Success" },
      { type: "text", id: "a1", at: at + 12000, text: "I added the footer component and wired it into the pricing page. Next I'm updating the support links." },
      { type: "tool", id: "t3", at: at + 15000, name: "shell", title: "Run npm test -- pricing", status: "canceled", input: "npm test -- pricing", output: "" },
    ],
    requests: [{
      id: request, text: "Add a footer to the pricing page with the support links", attachments: [], status: "interrupted",
      createdAt: at, interruption: { reason: "not-saved", at: at + 16000 }, error: "database or disk is full",
      nativeDelivery: { attemptId: "61111111-1111-4111-8111-111111111111", bindingId: live.session.id, ownerEpoch: "unsaved-fixture", evidence: { kind: "accepted", source: "native-response" } },
    }],
  })
  return true
})()`

async function shoot() {
  const { app, BrowserWindow, nativeTheme } = await import("electron")
  const out = process.env.MAKO_UNSAVED_SHOTS
  app.setPath("userData", join(out, "electron", "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code) => {
    const end = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${code}`)
      await pause(50)
    }
  }
  const settled = () => evaluate("Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))).then(() => true)")
  for (const theme of ["dark", "light"]) {
    nativeTheme.themeSource = theme
    await window.loadURL(process.env.MAKO_UNSAVED_URL)
    await until("Boolean(document.querySelector('.composer-input'))")
    // The app's own choice, painted as `bindTheme` paints it: this fixture page doesn't bind it.
    await evaluate(`import("/src/state/prefs.ts").then(({ setPref, bindTheme }) => (setPref("theme", ${JSON.stringify(theme)}), bindTheme(), true))`)
    await evaluate(SEED)
    await until("Boolean(document.querySelector('[data-failure-row]'))")
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate("document.querySelector('[data-failure-row]').scrollIntoView({ block: 'center' }), true")
    await pause(600)
    await settled()
    const words = await evaluate("document.querySelector('[data-failure-row]').innerText")
    const footer = await evaluate("Boolean(document.querySelector('[data-turn-stopped]'))")
    console.log(`${theme}: row says ${JSON.stringify(words)}; footer marker: ${footer}`)
    await writeFile(join(out, `row-${theme}.png`), (await page.capturePage()).toPNG())
    await evaluate("[...document.querySelectorAll('[data-failure-row] button')].find((b) => b.textContent.trim() === 'Details').click(), true")
    await pause(500)
    await settled()
    await writeFile(join(out, `details-${theme}.png`), (await page.capturePage()).toPNG())
  }
  app.exit(0)
}
