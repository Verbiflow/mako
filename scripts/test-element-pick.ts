/** The element picker, end to end, in a real headless Chromium driven
 * through BrowserService with trusted CDP input (the pure stack and
 * source-map reading is packages/control/test/element-pick.mjs). A React 19 page served by Vite's dev server is picked
 * the way a person picks it (hover, click, Shift-click, type, Enter) and the
 * pick is checked field by field, including the component and its source
 * file; Esc, a navigation and Mako's own cancel must each leave the page as
 * it was. `--screenshots <dir>` keeps the overlay's frames.
 * Run: tsx scripts/test-element-pick.ts */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { installElementPicker, pageFunctionSource } from "@mako/control/browser"
import { BrowserService, startElementPick, type BorrowedTab, type ElementPickSession } from "@mako/control-runtime/browser"
import { BrowserCommandSchema, type ElementPickOutcome } from "@mako/control-runtime/contracts"

const here = dirname(fileURLToPath(import.meta.url))
const shots = process.argv.includes("--screenshots") ? resolve(process.argv[process.argv.indexOf("--screenshots") + 1] ?? "") : undefined

/* ---------- the browser ---------- */

const executable =
  process.env.CHROMIUM_EXECUTABLE ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium")
if (!existsSync(executable)) {
  console.log(`Element pick browser checks skipped: no Chromium at ${executable}; set CHROMIUM_EXECUTABLE`)
  process.exit(0)
}

const root = await mkdtemp(join(tmpdir(), "mako-element-pick-"))
const { createServer } = await import("vite")
const { default: react } = await import("@vitejs/plugin-react")
const vite = await createServer({
  configFile: false,
  root: join(here, "fixtures/element-pick"),
  cacheDir: join(root, "vite"),
  plugins: [react()],
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } },
})
await vite.listen()
const address = vite.httpServer?.address()
const origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(address).port}`

const chromium = spawn(
  executable,
  ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(root, "profile")}`, "--no-first-run", "--no-default-browser-check", "--window-size=1200,820", "--hide-scrollbars", "--force-device-scale-factor=2", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] }
)
const endpoint = await new Promise<string>((done, fail) => {
  let stderr = ""
  const timeout = setTimeout(() => fail(new Error("Chromium startup timed out")), 15_000)
  chromium.once("error", fail)
  chromium.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_384)
    const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
    if (match) {
      clearTimeout(timeout)
      done(match[1]!)
    }
  })
})
const service = new BrowserService([{ id: "live", name: "Live Chromium", endpoint: async () => endpoint, requiresApproval: false }], { focusPolicy: "off" })
const signal = () => AbortSignal.timeout(20_000)
const valueOf = z.object({ result: z.object({ value: z.json().optional() }) })
const agent = (command: z.input<typeof BrowserCommandSchema>) => service.execute("agent", BrowserCommandSchema.parse(command), signal())

try {
  await service.connect("live")
  const opened = z.object({ tab: z.string() }).parse(
    await agent({ action: "open", browser: "live", url: `${origin}/`, background: false })
  )
  const tab = opened.tab
  // The page is the agent's: the picker must ride its binding, not claim the tab again.
  const agentTarget = z.object({ browser: z.string(), tab: z.string(), generation: z.string(), lease: z.string() }).parse(
    await agent({ action: "select", browser: "live", tab })
  )
  const borrowed = () => service.borrow("pick", "live", tab, signal())
  let probe: BorrowedTab = await borrowed()
  assert.equal(probe.shared, true, "a tab an agent holds is borrowed on its binding")
  const page = async (expression: string) =>
    valueOf.parse(await probe.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, signal())).result.value
  const waitFor = async (expression: string, what: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await page(expression)) return
      await new Promise((settle) => setTimeout(settle, 50))
    }
    throw new Error(`Timed out waiting for ${what}`)
  }
  await waitFor("document.querySelectorAll('article').length === 2", "the React fixture to render")
  const centre = async (selector: string) =>
    z.object({ x: z.number(), y: z.number() }).parse(
      await page(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    )
  const mouse = async (type: "mouseMoved" | "mousePressed" | "mouseReleased", point: { x: number; y: number }, modifiers = 0) =>
    probe.send("Input.dispatchMouseEvent", { type, ...point, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1, modifiers }, signal())
  const click = async (selector: string, modifiers = 0) => {
    const point = await centre(selector)
    await mouse("mouseMoved", point, modifiers)
    await mouse("mousePressed", point, modifiers)
    await mouse("mouseReleased", point, modifiers)
  }
  const key = async (name: string, code: string, keyCode: number, text?: string, modifiers = 0) => {
    const down = { key: name, code, windowsVirtualKeyCode: keyCode, modifiers }
    await probe.send("Input.dispatchKeyEvent", text ? { ...down, type: "keyDown", text, unmodifiedText: text } : { ...down, type: "rawKeyDown" }, signal())
    await probe.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: keyCode, modifiers }, signal())
  }
  const type = async (text: string) => {
    for (const character of text) {
      const upper = character.toUpperCase()
      await key(character, /[a-z]/i.test(character) ? `Key${upper}` : character === " " ? "Space" : "", upper.charCodeAt(0), character)
    }
  }
  const shot = async (name: string) => {
    if (!shots) return
    const image = z.object({ data: z.string() }).parse(await probe.send("Page.captureScreenshot", { format: "png" }, signal()))
    await mkdir(shots, { recursive: true })
    await writeFile(join(shots, name), Buffer.from(image.data, "base64"))
  }
  const clicks = async () => Number(z.string().parse(await page("document.getElementById('clicks').textContent")).replace(/\D/g, ""))
  const clean = async () =>
    z.object({ overlay: z.number(), worlds: z.boolean() }).parse(
      await page("({ overlay: document.querySelectorAll('[data-mako-pick]').length, worlds: Object.keys(window).some((name) => name.includes('mako')) })")
    )
  const settled = (session: ElementPickSession) =>
    Promise.race([session.outcome, new Promise<never>((_, fail) => setTimeout(() => fail(new Error("The pick never settled")), 20_000))])
  const start = async () => {
    const session = await startElementPick(probe, { limit: 10, platform: "mac" })
    await waitFor("document.querySelectorAll('[data-mako-pick]').length === 1", "the overlay")
    return session
  }

  /* A pick of one element, with a comment, on the agent's tab. */
  const before = await clicks()
  let session = await start()
  await shot("01-armed.png")
  // An agent's input waits while the person points; its reads do not.
  await assert.rejects(
    agent({ action: "click", target: agentTarget, at: { x: 10, y: 10 } }),
    /pointing at an element/,
    "an agent's click is refused while the person picks in its tab"
  )
  const hoverPoint = await centre("article[aria-label='Team plan'] button")
  await mouse("mouseMoved", hoverPoint)
  await new Promise((settle) => setTimeout(settle, 150))
  await shot("02-hover.png")
  await click("article[aria-label='Team plan'] button")
  await new Promise((settle) => setTimeout(settle, 150))
  await shot("03-selected.png")
  await type("Make this the primary colour")
  await new Promise((settle) => setTimeout(settle, 100))
  await shot("04-comment.png")
  assert.equal(await clicks(), before, "the page received none of the pick's clicks")
  await key("Enter", "Enter", 13, "\r")
  let outcome: ElementPickOutcome = await settled(session)
  assert.equal(outcome.status, "picked", JSON.stringify(outcome))
  if (outcome.status !== "picked") throw new Error("unreachable")
  const { pick } = outcome
  assert.equal(pick.url, `${origin}/`)
  assert.equal(pick.title, "Element pick fixture")
  assert.equal(pick.comment, "Make this the primary colour")
  assert.equal(pick.send, false)
  assert.equal(pick.elements.length, 1)
  const [button] = pick.elements
  assert.ok(button)
  assert.equal(button.tag, "button")
  assert.equal(button.role, "button", "the role comes from the accessibility tree")
  assert.equal(button.name, "Start a trial", "and so does the accessible name")
  assert.equal(button.component, "PlanCard", "the component is the element's owner")
  assert.equal(button.label, "PlanCard")
  assert.equal(button.source?.file, "src/PlanCard.tsx", JSON.stringify(button.source))
  assert.equal(button.source?.line, 13, "the line of the button's JSX in the TSX, through Vite's source map")
  assert.equal(button.source?.column, 7)
  assert.ok(button.selector, "a selector was found")
  assert.equal(await page(`document.querySelectorAll(${JSON.stringify(button.selector)}).length`), 1, `${button.selector} matches exactly one element`)
  assert.equal(await page(`document.querySelector(${JSON.stringify(button.selector)}).textContent.trim()`), "Start a trial", "and it is the picked one")
  assert.match(button.html, /^<button type="button" class="cta">\n {2}Start a trial\n<\/button>$/, button.html)
  assert.match(button.styles, /^display: inline-block$|background-color: rgb\(36, 33, 30\)/m, button.styles)
  assert.match(button.styles, /border-radius: 8px/)
  assert.doesNotMatch(button.styles, /^-webkit-|^width:|inline-size|^border-(start|end)-/m, "logical duplicates, sizes and prefixed properties are left out")
  assert.ok(button.styles.length <= 4096 && button.html.length <= 4096)
  assert.ok(button.box.width > 40 && button.box.height > 20, JSON.stringify(button.box))
  assert.equal(button.image?.mimeType, "image/png")
  const crop = Buffer.from(button.image!.data, "base64")
  assert.equal(crop.subarray(1, 4).toString(), "PNG")
  const { imageSize } = await import("image-size")
  const size = imageSize(crop)
  // The runtime's screenshot path returns CSS pixels whatever the device scale.
  assert.ok(Math.abs(size.width - (button.box.width + 16)) <= 2, `the crop is the element and 8 px around it: ${size.width} for ${button.box.width}`)
  if (shots) {
    await writeFile(join(shots, "05-crop.png"), crop)
    const shown = { ...pick, elements: pick.elements.map((element) => ({ ...element, image: element.image && { mimeType: element.image.mimeType, bytes: Buffer.from(element.image.data, "base64").length } })) }
    await writeFile(join(shots, "payload.json"), `${JSON.stringify(shown, null, 2)}\n`)
  }
  assert.deepEqual(await clean(), { overlay: 0, worlds: false }, "the overlay left nothing in the page")
  await click("h1")
  assert.equal(await clicks(), before + 1, "after the pick the page's clicks are its own again")
  await agent({ action: "click", target: agentTarget, at: { x: 5, y: 5 } })
  assert.equal(await clicks(), before + 1, "and the agent's input goes through once the person is done")
  console.log(`Element pick: one element picked on an agent's tab (${button.selector}, ${button.source?.file}:${button.source?.line}:${button.source?.column})`)

  /* Two elements with Shift-click, sent with ⌘↩. */
  probe = await borrowed()
  session = await start()
  await click("[data-testid=headline]")
  await click("article[aria-label='Starter plan'] .price", 8)
  await new Promise((settle) => setTimeout(settle, 150))
  await shot("06-multiple.png")
  await type("Tighten these")
  await key("Enter", "Enter", 13, "\r", 4)
  outcome = await settled(session)
  assert.equal(outcome.status, "picked", JSON.stringify(outcome))
  if (outcome.status !== "picked") throw new Error("unreachable")
  assert.equal(outcome.pick.send, true, "⌘↩ asks to send")
  assert.deepEqual(outcome.pick.elements.map((element) => element.selector), ["[data-testid=\"headline\"]", outcome.pick.elements[1]!.selector])
  assert.deepEqual(outcome.pick.elements.map((element) => element.component), ["App", "PlanCard"])
  assert.equal(outcome.pick.elements[1]?.source?.file, "src/PlanCard.tsx")
  assert.equal(outcome.pick.elements[1]?.source?.line, 12, "the price paragraph's JSX line")
  assert.equal(await clicks(), before + 1)
  console.log("Element pick: Shift-click adds a second element and ⌘↩ marks the pick to send")

  /* Esc leaves no trace. */
  probe = await borrowed()
  session = await start()
  await mouse("mouseMoved", hoverPoint)
  await key("Escape", "Escape", 27)
  outcome = await settled(session)
  assert.deepEqual(outcome, { status: "cancelled", by: "person", reason: "Cancelled in the page." })
  assert.deepEqual(await clean(), { overlay: 0, worlds: false })

  /* Mako cancels. */
  probe = await borrowed()
  session = await start()
  session.cancel("Cancelled in Mako.")
  outcome = await settled(session)
  assert.deepEqual(outcome, { status: "cancelled", by: "mako", reason: "Cancelled in Mako." })
  assert.deepEqual(await clean(), { overlay: 0, worlds: false })

  /* The page navigates away mid-pick. */
  probe = await borrowed()
  session = await start()
  await page("setTimeout(() => location.reload(), 10)")
  outcome = await settled(session)
  assert.equal(outcome.status, "cancelled")
  if (outcome.status === "cancelled") assert.equal(outcome.by, "page", outcome.reason)
  probe = await borrowed()
  await waitFor("document.querySelectorAll('article').length === 2", "the reloaded page")
  assert.deepEqual(await clean(), { overlay: 0, worlds: false })
  await probe.release()
  console.log("Element pick: Esc, Mako's cancel and a navigation each end the pick and leave nothing behind")

  /* A host that stops asking (quit, crashed) can't end the pick; the overlay leaves on its own. */
  {
    const tree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) }).parse(await probe.send("Page.getFrameTree", {}, signal()))
    const world = z.object({ executionContextId: z.number() }).parse(
      await probe.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "orphan" }, signal())
    )
    await probe.send("Runtime.evaluate", { contextId: world.executionContextId, expression: pageFunctionSource(installElementPicker.toString(), { token: "orphan", limit: 10, platform: "mac", abandonMs: 600 }) }, signal())
    assert.equal((await clean()).overlay, 1)
    const counted = await clicks()
    await new Promise((settle) => setTimeout(settle, 1_200))
    assert.deepEqual(await clean(), { overlay: 0, worlds: false }, "an overlay nobody polls removes itself")
    await click("h1")
    assert.equal(await clicks(), counted + 1, "and the page has its clicks back")
    console.log("Element pick: an overlay its host stopped polling removes itself and gives the page its clicks back")
  }

  /* A tab nobody holds is claimed for the pick and released after it. */
  await agent({ action: "release", target: agentTarget })
  probe = await borrowed()
  assert.equal(probe.shared, false, "a tab nobody holds is claimed for the pick")
  session = await start()
  await click("article[aria-label='Starter plan'] button")
  await key("Enter", "Enter", 13, "\r")
  outcome = await settled(session)
  assert.equal(outcome.status, "picked")
  if (outcome.status === "picked") assert.equal(outcome.pick.comment, "")
  const after = z.object({ browser: z.string(), tab: z.string(), generation: z.string(), lease: z.string() }).parse(
    await agent({ action: "select", browser: "live", tab })
  )
  assert.equal(after.tab, tab, "the pick's claim was released, so an agent can take the tab")
  console.log("Element pick: an unheld tab is claimed for the pick and released afterwards")

  /* Selectors, HTML and styles at their edges: siblings alike, generated
   * names, an open shadow root, an embedded frame, a long list. */
  await agent({ action: "navigate", target: after, url: `${origin}/edge.html` })
  probe = await borrowed()
  await waitFor("document.querySelectorAll('#long li').length === 40 && !!document.querySelector('my-card').shadowRoot", "the edge page")
  const at = async (expression: string) =>
    z.object({ x: z.number(), y: z.number() }).parse(
      await page(`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    )
  const press = async (point: { x: number; y: number }, modifiers = 0) => {
    await mouse("mouseMoved", point, modifiers)
    await mouse("mousePressed", point, modifiers)
    await mouse("mouseReleased", point, modifiers)
  }
  session = await start()
  await press(await at("document.querySelectorAll('.item')[1]"))
  await press(await at("document.querySelector('button')"), 8)
  await press(await at("document.querySelector('my-card').shadowRoot.querySelector('.inner')"), 8)
  const framePoint = await at("document.getElementById('embed')")
  await mouse("mouseMoved", framePoint)
  await new Promise((settle) => setTimeout(settle, 150))
  await shot("07-frame-hover.png")
  await press(framePoint, 8)
  // The list's own padding, left of its markers, is the list and not an entry.
  const list = z.object({ x: z.number(), y: z.number() }).parse(await page("(() => { const r = document.getElementById('long').getBoundingClientRect(); return { x: r.x + 6, y: r.y + r.height / 2 } })()"))
  await press(list, 8)
  await press(await at("document.querySelector('.styled')"), 8)
  await new Promise((settle) => setTimeout(settle, 150))
  await shot("08-edge-selection.png")
  await key("Enter", "Enter", 13, "\r")
  outcome = await settled(session)
  assert.equal(outcome.status, "picked", JSON.stringify(outcome))
  if (outcome.status !== "picked") throw new Error("unreachable")
  const [item, generated, inner, embed, long, styled] = outcome.pick.elements
  assert.ok(item && generated && inner && embed && long && styled, `six elements: ${outcome.pick.elements.map((element) => element.tag).join(", ")}`)
  assert.equal(await page(`document.querySelector(${JSON.stringify(item.selector)}).textContent`), "Two", `${item.selector} names the second of three alike siblings`)
  assert.equal(await page(`document.querySelectorAll(${JSON.stringify(item.selector)}).length`), 1)
  assert.ok(generated.selector && !generated.selector.includes("r5") && !generated.selector.includes("css-"), `a generated id or class is never the selector: ${generated.selector}`)
  assert.equal(inner.tag, "button")
  assert.match(inner.selector ?? "", /^my-card >>> /, `an open shadow root is pierced: ${inner.selector}`)
  const [hostPart, innerPart] = (inner.selector ?? "").split(" >>> ")
  assert.equal(await page(`document.querySelector(${JSON.stringify(hostPart)}).shadowRoot.querySelectorAll(${JSON.stringify(innerPart)}).length`), 1, "each part of a piercing selector matches one element in its own root")
  assert.equal(embed.tag, "iframe")
  assert.equal(embed.frame, true, "an embedded frame is picked whole, through its shield")
  assert.equal(embed.selector, "#embed")
  assert.match(long.html, /^<ul id="long">\n {2}<li>Entry 1<\/li>/, long.html)
  assert.match(long.html, /<!-- 16 more -->\n<\/ul>$/, "children past 24 are counted, not listed")
  assert.ok(long.html.length <= 4096)
  assert.match(styled.html, /^<p class="styled">\n {2}Styled\n {2}<b>bold<\/b>\n {2}text\n<\/p>$/, styled.html)
  for (const line of ["margin: 4px 8px", "padding: 12px", "border-radius: 6px", "color: rgb(10, 20, 30)", "background-color: rgb(250, 240, 230)"])
    assert.ok(styled.styles.split("\n").includes(line), `${line} in:\n${styled.styles}`)
  assert.ok(!styled.styles.includes("display:"), "a paragraph's default display is not named")
  assert.equal(await page("document.getElementById('embed').style.pointerEvents"), "", "the frame's own style was never touched")
  assert.deepEqual(await clean(), { overlay: 0, worlds: false })
  console.log(`Element pick: edge selectors ${[item, generated, inner, embed].map((element) => element.selector).join(" | ")}`)

  /* The host's methods over the same service: the tab list, a pick by id,
   * its wait (repeatable after it ends) and a cancel. */
  const { ElementPicks } = await import("@mako/host/control/element-picks")
  const { ControlPreviews } = await import("@mako/host/control/previews")
  const picks = new ElementPicks(service, new ControlPreviews(service, async () => null, () => {}), "mac")
  const listed = await picks.targets()
  assert.deepEqual(listed.browsers.map((browser) => [browser.id, browser.status]), [["live", "connected"]])
  const listedTab = listed.tabs.find((entry) => entry.tab === tab)
  assert.deepEqual(listedTab && { title: listedTab.title, url: listedTab.url, inUse: listedTab.inUse }, { title: "Edge cases", url: `${origin}/edge.html`, inUse: true }, "the agent's tab is listed as in use")
  const started = await picks.start({ id: "pick-1", target: { browser: "live", tab } })
  assert.deepEqual(started, { status: "picking", title: "Edge cases", url: `${origin}/edge.html` })
  assert.deepEqual(await picks.start({ id: "pick-1", target: { browser: "live", tab } }), started, "a repeated start answers with the same pick")
  assert.deepEqual(await picks.wait("pick-1", 50), started, "a wait with nothing new says it is still picking")
  await press(await at("document.querySelector('.styled b')"))
  await type("Bolder")
  await key("Enter", "Enter", 13, "\r")
  const picked = await picks.wait("pick-1", 20_000)
  assert.equal(picked.status, "picked", JSON.stringify(picked))
  if (picked.status === "picked") {
    assert.equal(picked.pick.comment, "Bolder")
    assert.equal(picked.pick.elements[0]?.selector, "b", "the only <b> on the page needs nothing more")
  }
  assert.deepEqual(await picks.wait("pick-1", 50), picked, "the outcome reads the same again after a dropped connection")
  await picks.start({ id: "pick-2", target: { browser: "live", tab } })
  assert.equal((await picks.cancel("pick-2"))?.status, "picking")
  assert.deepEqual(await picks.wait("pick-2", 5_000), { status: "cancelled", by: "mako", reason: "Cancelled in Mako." })
  assert.deepEqual(await picks.wait("never", 50), { status: "cancelled", by: "mako", reason: "Mako no longer has this pick; start another." })
  picks.close()
  assert.deepEqual(await clean(), { overlay: 0, worlds: false })
  console.log("Element pick: the host's targets, start, wait and cancel over a live tab")
} finally {
  service.close()
  const exited = new Promise((settle) => chromium.once("exit", settle))
  chromium.kill()
  await exited
  await vite.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
}
