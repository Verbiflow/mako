import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { KEPT, testScratch } from "./lib/test-scratch.mjs"

/**
 * A Fin placed on another device, as every form draws it (decision D6), through production components on the mock
 * bridge's Apex with `&placed=` (`src/dev/mock-apex-thread.ts`): on the desk, under its Apex in the rail and the crew
 * card, never as a row of its own, opening its own conversation on its device (Loft) when Loft lists it, and drawn as
 * not openable, opening nothing, when it doesn't; on the phone and in a laptop's browser, under its Apex and, waiting
 * on an approval, a row of its own under Needs you that opens on Loft; with Loft quiet; and with the Apex's own device
 * off, the Fin's row still saying what it asks. Screenshots of each, dark and light, land in the printed directory
 * (`MAKO_PLACED_UI_SHOTS`; without it they go with the run's scratch folder once it passes). Pass a dev server's URL
 * to use it; with none it serves its own.
 *
 * The desk's rail shots keep the right sidebar open; before the crew card and the opened Fin, the sidebar is closed
 * by the person's own command (Toggle the right sidebar), since a display narrower than the window asked for (a
 * runner's) clamps the window, and the stage then covers the workbench with the sidebar, as it's designed to in a
 * narrow window. The window's real size and the screen's are printed for every desk scene; `MAKO_PLACED_UI_WIDTH`
 * asks for a narrower desk window, to see a clamped runner's case here.
 */
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  // Gone when the run ends however it ends; with `MAKO_PLACED_UI_SHOTS` the shots land outside it and stay.
  const root = testScratch("mako-placed-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-placed-ui", main: fileURLToPath(import.meta.url) }))
  const given = process.argv.slice(2).find((arg) => /^https?:/.test(arg))
  let server
  if (!given) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const env = { ...process.env, MAKO_PLACED_UI_ROOT: root, MAKO_PLACED_UI_URL: given ?? server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server?.close()
  }
  console.log(`Placed Fin UI evidence: ${process.env.MAKO_PLACED_UI_SHOTS ?? `the run's scratch, kept under ${KEPT} when it fails`}`)
}

const APEX_THREAD = "1ead1ead-0000-4000-8000-000000001ead"
const APEX_CONVERSATION = "1ead1ead-2000-4000-8000-000000001ead"
const FIN_THREAD = "1ead1ead-3000-4000-8000-000000000013"
const FIN_CONVERSATION = "1ead1ead-5000-4000-8000-000000000013"
const FIN_TITLE = "Docs sweep"
/** What the desk shows when a wait runs out: the open conversation and the rail's rows; and the crew card's rows. */
const ACTIVE = "import('/src/state/acp.ts').then(({ acpStore }) => ({ active: acpStore.get().activeKey, rows: [...document.querySelectorAll('.thread-jump-scope [data-thread-row]')].map((node) => [node.dataset.conversationId, node.dataset.apexRow ?? '', node.innerText.split('\\n')[0]]) }))"
/** The transcript's state and every crew card on the page, each with its box and the ancestors that could hide it. */
const TRANSCRIPT = `${ACTIVE}.then((shown) => { const rect = (node) => node ? { top: Math.round(node.getBoundingClientRect().top), height: Math.round(node.getBoundingClientRect().height) } : null; const viewport = document.querySelector('[data-transcript-viewport]'); const cards = [...document.querySelectorAll('[data-crew]')].map((card) => { const ancestors = []; for (let node = card; node; node = node.parentElement) { const style = getComputedStyle(node); const why = [node.hidden && 'hidden', style.display === 'none' && 'display:none', style.visibility !== 'visible' && style.visibility, style.contentVisibility && style.contentVisibility !== 'visible' && style.contentVisibility].filter(Boolean); if (why.length || node === card || node.hasAttribute('data-transcript-viewport')) ancestors.push([node.tagName.toLowerCase(), [...node.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name + (a.value ? '=' + a.value.slice(0, 24) : '')).join(' '), why.join(','), why.length ? (node.className || '').toString().slice(0, 80) : '']) } return { inTranscript: viewport?.contains(card) ?? false, card: rect(card), scroller: rect(card.querySelector('[data-crew-scroller]')), rows: card.querySelectorAll('[data-crew-row]').length, ancestors } }); return import('/src/state/viewer.ts').then(({ viewerStore }) => ({ ...shown, transcript: { viewport: rect(viewport), virtualized: viewport?.hasAttribute('data-virtualized') ?? null, skeleton: document.querySelector('.skeleton-transcript') !== null, composer: document.querySelector('[data-composer-input], textarea') !== null, blocks: viewport?.querySelectorAll('[data-flip-key], [data-request], [data-transcript-tool]').length ?? null }, panes: viewerStore.get().panes.map((pane) => ({ id: pane.id, activeId: pane.activeId, tabIds: pane.tabIds, session: pane.session?.key ?? pane.session ?? null })), documents: Object.values(viewerStore.get().documents ?? {}).map((doc) => ({ id: doc.id, kind: doc.kind, title: doc.title, path: doc.path ?? doc.transcript?.path ?? null })), cards })) })`

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_PLACED_UI_ROOT
  const shots = process.env.MAKO_PLACED_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  await app.whenReady()
  const base = process.env.MAKO_PLACED_UI_URL.replace(/\/$/, "")
  const watchdog = setTimeout(() => {
    console.error("The placed Fin UI check hung")
    app.exit(1)
  }, 240_000)

  /** A window on one page, with what every scene needs of it. */
  const open = async (url, { width, height, phone = false }) => {
    const window = new BrowserWindow({ width, height, show: false, webPreferences: { backgroundThrottling: false, ...(phone && { contextIsolation: true, nodeIntegration: false }) } })
    const page = window.webContents
    const errors = []
    page.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message)
    })
    const evaluate = (code) => page.executeJavaScript(code)
    // `seen` is read when the wait runs out, so the failure says what the page showed instead.
    const until = async (code, what = code, ms = 20_000, seen) => {
      const deadline = Date.now() + ms
      while (!(await evaluate(code))) {
        if (Date.now() > deadline) {
          const shown = seen ? `; the page showed ${JSON.stringify(await evaluate(seen))}` : ""
          throw new Error(`Timed out waiting for ${what}${shown}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
        }
        await new Promise((done) => setTimeout(done, 40))
      }
    }
    const settle = () => evaluate("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))")
    const capture = async (name) => {
      await settle()
      await writeFile(join(shots, `${name}.png`), (await page.capturePage()).toPNG())
    }
    const theme = (light) => evaluate(`document.documentElement.classList.toggle('light', ${light}); document.documentElement.style.colorScheme = '${light ? "light" : "dark"}'; true`)
    const both = async (name) => {
      await theme(false)
      await capture(`${name}-dark`)
      await theme(true)
      await capture(`${name}-light`)
      await theme(false)
    }
    // Selectors here are this script's own literals: none comes from outside it.
    const click = (selector) => evaluate(`(() => { const node = document.querySelector('${selector}'); if (!node) return false; (node.closest('button') ?? node).click(); return true })()`)
    const activeKey = () => evaluate("import('/src/state/acp.ts').then(({ acpStore }) => acpStore.get().activeKey)")
    const activeIs = (key, what, ms) => until(`import('/src/state/acp.ts').then(({ acpStore }) => acpStore.get().activeKey === '${key}')`, what, ms, ACTIVE)
    await window.loadURL(url)
    return { window, evaluate, until, capture, both, click, activeKey, activeIs, errors, close: () => window.close() }
  }

  try {
    // The desk, the Apex's own device: the Fin under the Apex in the rail, opening Loft's conversation of it.
    for (const scene of ["studio", "quiet", "unlisted"]) {
      const desk = await open(`${base}?mock&app=apex&placed=${scene}`, { width: Number(process.env.MAKO_PLACED_UI_WIDTH ?? 1440), height: 900 })
      await desk.until(`Boolean(document.querySelector('.thread-jump-scope [data-asking-fin="${FIN_THREAD}"]'))`, "the placed Fin under its Apex in the rail")
      const rows = await desk.evaluate("[...document.querySelectorAll('.thread-jump-scope [data-thread-row]')].map((node) => node.innerText)")
      assert.ok(!rows.some((text) => text.includes(FIN_TITLE)), `the placed Fin is no row of its own in the rail (${scene}): ${JSON.stringify(rows)}`)
      const openable = await desk.evaluate(`document.querySelector('.thread-jump-scope [data-asking-fin="${FIN_THREAD}"]').dataset.openable`)
      assert.equal(openable, scene === "unlisted" ? "false" : "true", `the row says whether it opens (${scene})`)
      await desk.both(`desk-rail-${scene}`)
      // The crew card, in the Apex's Thread: the same row, the same word on whether it opens. The Apex's row is found
      // by its conversation, never by its place in the rail, and the card is waited for only once its conversation is
      // the open one. A cold runner's first transcript takes a while to come up.
      assert.ok(await desk.click(`.thread-jump-scope [data-conversation-id="${APEX_CONVERSATION}"]`), `the Apex's row in the rail (${scene})`)
      await desk.activeIs(APEX_CONVERSATION, "the Apex's conversation open in place")
      // The window as the display allowed it, printed every run: a runner's display clamps a window wider than itself.
      const sizes = await desk.evaluate("({ inner: [window.innerWidth, window.innerHeight], screen: [screen.width, screen.height] })")
      console.log(`desk, ${scene}: window ${sizes.inner.join("×")} on a ${sizes.screen.join("×")} screen`)
      // The right sidebar, closed as the person closes it: in a window too narrow for both, the stage covers the
      // workbench with it, and the transcript, mounted, has no box. The scene must not depend on the display's width.
      await desk.evaluate("Promise.all([import('/src/state/stage.ts'), import('/src/extend/commands.ts')]).then(([{ stageStore }, { runCommand }]) => { if (Object.values(stageStore.get().byTab).some((tab) => tab.companion)) runCommand('view.toggle-companion'); return true })")
      // The Apex's transcript first: its viewport, with its skeleton gone and a box of its own. A cold runner's first
      // transcript takes a while; one that never comes up is this check's failure to say, never something to pass around.
      await desk.until("Boolean(document.querySelector('[data-transcript-viewport]')) && !document.querySelector('.skeleton-transcript')", "the Apex's transcript", 90_000, TRANSCRIPT)
      await desk.until("document.querySelector('[data-transcript-viewport]').getBoundingClientRect().height > 0", "the Apex's transcript with a box", 20_000, TRANSCRIPT)
      // Then the crew card in that transcript (a compact card can stand elsewhere on the page, under a hidden surface).
      // The card draws its rows through a virtualizer, which draws none while the card's scroller measures no
      // height: below the fold on a runner it did, and the wait ran out with the card mounted and empty. On screen,
      // as a reader scrolls to it, it measures and draws; here it's brought on screen first, which the screenshots
      // need too. On a timeout, every card on the page is printed with its box and the ancestors that could hide it.
      const CARD = "[data-transcript-viewport] [data-crew]"
      await desk.until(`Boolean(document.querySelector('${CARD}'))`, "the crew card in the Apex's transcript", 60_000, TRANSCRIPT)
      await desk.evaluate(`document.querySelector('${CARD}').scrollIntoView({ block: 'start' }); true`)
      await desk.until(`Boolean(document.querySelector('${CARD} [data-crew-row="${FIN_THREAD}"]'))`, "the Fin in the Apex's crew card", 30_000, TRANSCRIPT)
      // Drawn, not only mounted: the card and its row have a box.
      const drawn = await desk.evaluate(TRANSCRIPT)
      const card = drawn.cards.find((each) => each.inTranscript)
      assert.ok(card && card.card.height > 0 && card.rows > 0, `the crew card is drawn in the transcript (${scene}): ${JSON.stringify(drawn)}`)
      assert.ok(await desk.evaluate(`document.querySelector('${CARD} [data-crew-row="${FIN_THREAD}"]').getBoundingClientRect().height > 0`), `the Fin's row has a box (${scene})`)
      // The card fades in; its screenshot is taken once that's done. Only the card's own animation: rows hold marks
      // that pulse for as long as a Fin works.
      await desk.evaluate(`Promise.all(document.querySelector('${CARD}').getAnimations().filter((animation) => animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished)).then(() => true)`)
      // The crew card's row for a Fin that needs the person opens from its title; every other row is the button itself.
      assert.equal(await desk.evaluate(`document.querySelector('${CARD} [data-crew-row="${FIN_THREAD}"][data-openable], ${CARD} [data-crew-row="${FIN_THREAD}"] [data-openable]').dataset.openable`), scene === "unlisted" ? "false" : "true")
      await desk.both(`desk-crew-${scene}`)
      const before = await desk.activeKey()
      await desk.click(`.thread-jump-scope [data-asking-fin="${FIN_THREAD}"]`)
      if (scene === "unlisted") {
        await new Promise((done) => setTimeout(done, 300))
        assert.equal(await desk.activeKey(), before, "a row with nothing behind it opens nothing")
        assert.equal(await desk.evaluate("import('/src/state/apex-fins.ts').then(({ apexViewStore }) => apexViewStore.get().open)"), null, "and sets no Fin view")
      } else {
        await desk.activeIs(FIN_CONVERSATION, "Loft's conversation of the Fin open in place")
        await desk.until("Boolean(document.querySelector('[data-apex-breadcrumb], [data-fin-of-apex], [data-child-of]')) || true")
        await desk.both(`desk-open-${scene}`)
      }
      assert.deepEqual(desk.errors, [], `the page threw nothing (${scene})`)
      desk.close()
      console.log(`desk, ${scene}: the Fin under its Apex in the rail and the crew card, ${scene === "unlisted" ? "drawn as not openable and opening nothing" : "opening Loft's conversation of it"}`)
    }

    // A laptop's browser: the desk's rail from the account's list, the Fin under its Apex, a row of its own under Needs you.
    for (const scene of ["loft", "off"]) {
      for (const theme of ["dark", "light"]) {
        const laptop = await open(`${base}/scripts/web-desk.html?placed=${scene}&theme=${theme}`, { width: 1280, height: 800, phone: true })
        await laptop.until("document.querySelectorAll('[data-thread-row]').length > 0", "the rail's rows")
        await laptop.until(`Boolean(document.querySelector('[data-asking-fin="${FIN_THREAD}"]'))`, "the placed Fin under its Apex in the laptop's rail")
        const rows = await laptop.evaluate("[...document.querySelectorAll('[data-thread-row]')].map((node) => node.innerText)")
        assert.ok(!rows.some((text) => text.includes(FIN_TITLE)), `no row of its own in the laptop's rail (${scene}): ${JSON.stringify(rows)}`)
        await laptop.capture(`laptop-rail-${scene}-${theme}`)
        await laptop.click(`[data-asking-fin="${FIN_THREAD}"]`)
        await laptop.activeIs(FIN_CONVERSATION, "Loft's conversation open in the laptop's browser")
        await laptop.capture(`laptop-open-${scene}-${theme}`)
        laptop.close()
      }
      console.log(`laptop, ${scene}: the Fin under its Apex in the rail, opening Loft's conversation of it`)
    }

    // The phone: under Needs you, the Fin's own row, under its Apex, opening on Loft; with the Apex's device off too.
    for (const scene of ["loft", "off"]) {
      for (const theme of ["dark", "light"]) {
        const phone = await open(`${base}/scripts/phone-apex.html?app=apex&placed=${scene}&theme=${theme}`, { width: 390, height: 844, phone: true })
        await phone.until(`Boolean(document.querySelector('[data-list-section="needs"] [data-thread="${FIN_THREAD}"][data-under="${APEX_THREAD}"]'))`, "the placed Fin's row under Needs you, under its Apex")
        const others = await phone.evaluate(`[...document.querySelectorAll('[data-thread="${FIN_THREAD}"]')].filter((node) => !node.dataset.under).length`)
        assert.equal(others, 0, `no Thread row of its own (${scene})`)
        assert.equal(await phone.evaluate(`document.querySelectorAll('[data-list-section="needs"] [data-thread="${APEX_THREAD}"]').length`), 0, `its Apex's row doesn't stand in for it (${scene})`)
        assert.equal(await phone.evaluate(`document.querySelectorAll('[data-fin-row="${FIN_THREAD}"]').length`), 0, `listed once under Needs you (${scene})`)
        await phone.capture(`phone-list-${scene}-${theme}`)
        await phone.click(`[data-list-section="needs"] [data-thread="${FIN_THREAD}"]`)
        await phone.until(`Boolean(document.querySelector('[data-thread-screen="${FIN_THREAD}"]'))`, "the Fin's own screen, on Loft")
        await phone.until("Boolean(document.querySelector('[data-permission-card]'))", "its approval")
        await phone.capture(`phone-open-${scene}-${theme}`)
        assert.equal(await phone.evaluate(`document.querySelectorAll('[data-fin-row="${FIN_THREAD}"]').length`), 0, "listed once: its own row, not an ask row of its Apex's too")
        phone.close()
      }
      console.log(`phone, ${scene}: the Fin's row under Needs you, under its Apex, opening on Loft with its approval`)
    }
    console.log("placed Fin UI: ok")
    clearTimeout(watchdog)
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(watchdog)
    app.exit(1)
  }
}
