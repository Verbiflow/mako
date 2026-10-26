import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Turns Mako stopped on its own, as the live app draws them (`scripts/live-workflow.html` with its mock bridge), in
// dark and light, written into <out> as <scene>-<theme>.png: one it couldn't save, its failure row closed (`row`) and
// with Details open (`details`); and a goal's turn stopped at its token budget, said in the footer (`budget`).
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
const UNSAVED = `(async () => {
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

/** A Claude Code goal whose turn Mako stopped at the token budget the person set. */
const BUDGET = `(async () => {
  const { acpStore } = await import("/src/state/acp-state.ts")
  const { applyLiveSnapshot } = await import("/src/state/live-recovery.ts")
  const { threadsStore } = await import("/src/state/thread-store.ts")
  threadsStore.set({ composerHarness: "claude" })
  const state = acpStore.get()
  const live = state.conversations[state.activeKey]
  const at = Date.UTC(2026, 9, 26, 18, 4)
  const request = "52222222-2222-4222-8222-222222222222"
  const objective = "Make the failing parser tests pass"
  applyLiveSnapshot({
    session: { ...live.session, harness: "claude", status: "ready", connection: "connected" },
    epoch: "budget-fixture", revision: (live.revision ?? 0) + 1, createdAt: 1, base: null, permissions: [],
    control: live.control,
    goal: { objective, status: "budget-limited", by: "harness", setAt: at, updatedAt: at + 95000, turns: 1, tokensUsed: 50400, tokenBudget: 50000 },
    blocks: [
      { type: "user", id: "u1", requestId: request, at, text: "/goal " + objective },
      { type: "tool", id: "t1", at: at + 4000, name: "Bash", title: "Run npm test -- parser", status: "completed", input: "npm test -- parser", output: "3 failing" },
      { type: "tool", id: "t2", at: at + 30000, name: "Edit", title: "Edit src/parser/tokens.ts", status: "completed", input: "src/parser/tokens.ts", output: "Updated" },
      { type: "text", id: "a1", at: at + 60000, text: "Two of the three parser tests pass now. The last one fails on nested quotes; I'm looking at the tokenizer's escape handling." },
      { type: "tool", id: "t3", at: at + 90000, name: "Bash", title: "Run npm test -- parser", status: "canceled", input: "npm test -- parser", output: "" },
    ],
    requests: [{
      id: request, text: "/goal " + objective, attachments: [], status: "interrupted", goal: { step: "set" },
      createdAt: at, interruption: { reason: "goal-budget", at: at + 95000 },
      nativeDelivery: { attemptId: "62222222-2222-4222-8222-222222222222", bindingId: live.session.id, ownerEpoch: "budget-fixture", evidence: { kind: "accepted", source: "native-response" } },
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
    await evaluate(UNSAVED)
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

    await evaluate(BUDGET)
    await until("Boolean(document.querySelector('[data-turn-stopped=\"goal-budget\"]'))")
    await evaluate("document.querySelector('[data-turn-stopped]').scrollIntoView({ block: 'center' }), true")
    await pause(600)
    await settled()
    console.log(`${theme}: budget footer says ${JSON.stringify(await evaluate("document.querySelector('[data-turn-stopped]').innerText"))}; failure row: ${await evaluate("Boolean(document.querySelector('[data-failure-row]'))")}`)
    await writeFile(join(out, `budget-${theme}.png`), (await page.capturePage()).toPNG())
  }
  app.exit(0)
}
