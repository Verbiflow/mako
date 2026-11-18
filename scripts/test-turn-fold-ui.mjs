import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

// A settled turn's fold is drawn once: while a later turn streams eight calls and settles, no fold above it
// renders again. Counted on the production components (`scripts/tool-rows.html`, twelve settled turns) through
// React's own commit hook: a component rendered in a commit when its fiber was made again and did work.
// Also held here: a read's row has nothing to open, and an edit's opens.
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-turn-fold-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-turn-fold-ui", main: fileURLToPath(import.meta.url) }))
  await writeFile(join(root, "preload.cjs"), `(${countRenders.toString()})()`)
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  const env = { ...process.env, MAKO_FOLD_UI_ROOT: root, MAKO_FOLD_UI_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
}

/** Runs in the page before React loads: counts, per component name, the renders of instances already mounted. */
function countRenders() {
  const WATCHED = new Set(["TurnFoldRow", "FoldLine", "TurnExchange", "WaitingLine", "ActivityPill"])
  const renders = (window.__renders = { counting: false, by: {} })
  const current = new WeakMap()
  const visit = (fiber) => {
    for (let node = fiber; node; node = node.sibling) {
      // A function component names itself; a memo wraps the one that does. A host element's type is a string, with neither.
      const name = node.type?.name ?? node.type?.type?.name
      if (name && WATCHED.has(name)) {
        const before = current.get(node) ?? (node.alternate ? current.get(node.alternate) : undefined)
        // Made again since the last commit, by a render that ran its function: an update, not a mount or a bailout.
        if (renders.counting && before && before !== node && node.flags & 1) renders.by[name] = (renders.by[name] ?? 0) + 1
        current.set(node, node)
        if (node.alternate) current.set(node.alternate, node)
      }
      if (node.child) visit(node.child)
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    onCommitFiberRoot: (_id, root) => visit(root.current),
  }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_FOLD_UI_ROOT
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: false, sandbox: false, preload: join(root, "preload.cjs") } })
  const page = window.webContents
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, what = code) => {
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  await window.loadURL(`${new URL("scripts/tool-rows.html", process.env.MAKO_FOLD_UI_URL).href}?surface=desk&turns=12&theme=dark`)
  await until("Boolean(window.toolRows && document.querySelector('[data-transcript-viewport] [data-exchange]'))", "the transcript")
  const folds = await evaluate("document.querySelectorAll('[data-turn-fold]').length")
  assert.ok(folds >= 3, `settled turns stand folded above the stream (${folds})`)
  const words = await evaluate("[...document.querySelectorAll('[data-turn-fold] [data-fold-title]')].at(-1).innerText")
  assert.match(words, /^(Worked for|Made|Read|Ran)/, `a settled turn's line is worded from its parts: ${words}`)

  // A read's row has nothing to open; an edit's opens onto its diff.
  await evaluate("[...document.querySelectorAll('[data-turn-fold=\"closed\"] > button')].at(-1).click(), true")
  await until("document.querySelectorAll('[data-turn-fold=\"open\"] [data-transcript-tool]').length > 0", "the opened fold's rows")
  const rows = await evaluate("[...document.querySelectorAll('[data-turn-fold=\"open\"] [data-transcript-tool]')].map((row) => ({ words: row.innerText.replace(/\\s+/g, ' ').trim(), opens: Boolean(row.querySelector('button[aria-expanded]')), heights: Math.round(row.getBoundingClientRect().height) }))")
  console.log("ROWS", JSON.stringify(rows))
  assert.ok(rows.some((row) => !row.opens) && rows.some((row) => row.opens), "rows that only repeat themselves don't open, rows with a body do")
  assert.ok(rows.every((row) => row.heights === 28), "and every row is the one line of fixed height")
  await evaluate("[...document.querySelectorAll('[data-turn-fold=\"open\"] > button')].at(-1).click(), true")
  await new Promise((done) => setTimeout(done, 400))

  // Stream a turn of eight calls and let it settle: the folds that were there render nothing again.
  await evaluate("window.__renders.counting = true, window.__renders.by = {}, true")
  await evaluate("window.toolRows.stream(8, 60)")
  await until("!window.toolRows.streaming", "the stream's end")
  await new Promise((done) => setTimeout(done, 600))
  const counted = await evaluate("window.__renders.by")
  console.log("RENDERS while a later turn streamed", JSON.stringify(counted))
  assert.equal(counted.TurnFoldRow ?? 0, 0, "no settled turn's fold rendered again while a later turn streamed")
  assert.equal(counted.FoldLine ?? 0, 0, "nor its line")
  assert.ok((counted.TurnExchange ?? 0) > 0, "the count is live: the streaming turn itself rendered")
  console.log("PASS: a settled turn's fold is drawn once, a streamed turn renders only itself, and rows open only onto a body")
  app.exit(0)
}
