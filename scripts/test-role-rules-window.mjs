import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * Settings › Fins' fields for the person's standing rules, the production section on the mock bridge, driven with
 * trusted input: a rule typed and saved on blur, read back from the bridge, each Preview opened with its rough token
 * count, and dark and light captures. `node scripts/test-role-rules-window.mjs [evidence folder]`.
 */
if (!process.versions.electron) {
  const { createServer } = await import("vite")
  const root = testScratch("mako-role-rules-ui-")
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: Number(process.env.MAKO_UI_PORT ?? 0), hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ main: fileURLToPath(import.meta.url) }))
  const evidence = resolve(process.argv[2] ?? join(root, "evidence"))
  const env = { ...process.env, MAKO_ROLE_RULES_URL: server.resolvedUrls.local[0], MAKO_ROLE_RULES_ROOT: root, MAKO_ROLE_RULES_EVIDENCE: evidence }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((done, fail) => {
      child.once("exit", done)
      child.once("error", fail)
    })
  } finally {
    await server.close()
  }
} else {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_ROLE_RULES_ROOT
  const evidence = process.env.MAKO_ROLE_RULES_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  await mkdir(evidence, { recursive: true })
  const window = new BrowserWindow({ show: false, width: 820, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const capture = async (name, selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "start" }); window.scrollBy(0, -24)`)
    // The person's rules close what an agent reads: the captures show the end of an open preview.
    await evaluate(`document.querySelectorAll("[data-role-preview] pre").forEach((pre) => { pre.scrollTop = pre.scrollHeight })`)
    await evaluate("Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})))")
    await evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))")
    await writeFile(join(evidence, name), (await page.capturePage()).toPNG())
  }
  const until = async (code, what = code) => {
    const end = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        const seen = await evaluate(`window.mako.finDefaults().then((reading) => JSON.stringify({ policy: reading.policy, focus: document.activeElement?.closest("[data-role-rules]")?.getAttribute("data-role-rules") ?? document.activeElement?.tagName }))`).catch(() => "unreadable")
        throw new Error(`UI condition timed out: ${what}; the page had ${seen}`)
      }
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  // A press aims where the target was on a painted frame, and only once it held still for two: the fields render
  // before the readings above them land and move them (16 px when those come half a second late), and a press sent
  // before the page's first frame can reach nothing.
  const settle = (selector) => evaluate(`(async () => {
      const found = document.querySelector(${JSON.stringify(selector)})
      found.scrollIntoView({ block: "center" })
      // A frame, or a tenth of a second where the window paints none.
      const frame = () => new Promise((done) => {
        const read = () => { clearTimeout(timer); done(found.getBoundingClientRect()) }
        const timer = setTimeout(read, 100)
        requestAnimationFrame(read)
      })
      let before = await frame()
      for (let frames = 0; frames < 60; frames += 1) {
        const now = await frame()
        if (now.x === before.x && now.y === before.y && now.width === before.width && now.height === before.height) break
        before = now
      }
      return { x: Math.round(before.x + before.width / 2), y: Math.round(before.y + before.height / 2) }
    })()`)
  const press = async (selector) => {
    const point = await settle(selector)
    for (const type of ["mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
    return point
  }
  const field = (role) => `[data-role-rules=${role}] textarea`
  // Typing goes wherever focus is, so a field is typed into only once it has focus. Nothing may cover the field where
  // it's pressed; the field then takes focus from the page itself. CI's Linux runners sometimes never delivered a
  // synthetic press to the page at all (none recorded, focus left on the body), which is the runner's input, not
  // the window's: a native textarea takes focus on a click it receives.
  const focusField = async (role) => {
    const selector = JSON.stringify(field(role))
    const point = await settle(field(role))
    const at = await evaluate(`document.elementFromPoint(${point.x}, ${point.y}) === document.querySelector(${selector}) ? "" : document.elementFromPoint(${point.x}, ${point.y})?.outerHTML.slice(0, 120) ?? "nothing"`)
    if (at) throw new Error(`Something covers the ${role} field at ${JSON.stringify(point)}: ${at}`)
    // As a click below a short rule leaves it: the caret after its last word.
    await evaluate(`(() => { const found = document.querySelector(${selector}); found.focus(); found.setSelectionRange(found.value.length, found.value.length) })()`)
    assert.ok(await evaluate(`document.activeElement === document.querySelector(${selector})`), `the ${role} field takes focus`)
  }
  // Leaving a field is what saves it. Focus leaves it from the page itself, as it does for a click elsewhere: a synthetic
  // press there sometimes never reached the page on CI's Linux runner, and the save it was for never ran.
  const leaveField = async () => {
    await evaluate("document.activeElement?.blur(), true")
    assert.ok(await evaluate("!document.activeElement?.matches('[data-role-rules] textarea')"), "focus left the field")
  }
  const preview = (role) => `[data-role-rules=${role}] button[aria-expanded]`
  const theme = (light) => evaluate(`document.documentElement.classList.toggle("light", ${light})`)
  const saved = () => evaluate("window.mako.finDefaults().then((reading) => reading.policy)")
  const timer = setTimeout(() => {
    console.error("The role rules UI check exceeded its 60-second limit")
    app.exit(1)
  }, 60_000)
  try {
    await window.loadURL(`${process.env.MAKO_ROLE_RULES_URL}scripts/role-rules.html`)
    await until(`document.querySelector(${JSON.stringify(field("forFins"))}) !== null`, "the fields render")
    const labels = await evaluate(`[...document.querySelectorAll("[data-role-rules] label")].map((label) => label.innerText)`)
    assert.deepEqual(labels, ["For every Fin", "For every Apex"])
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(field("forFins"))}).placeholder`), "Run the tests you touch before you report")
    const below = await evaluate(`document.querySelector("[aria-label='Your rules for Fins']").compareDocumentPosition(document.querySelector("[data-role-rules]")) & Node.DOCUMENT_POSITION_FOLLOWING`)
    assert.ok(below, "the fields sit under the model rules")

    /* Typed and saved on blur, as a rule saves. */
    await focusField("forFins")
    await page.debugger.sendCommand("Input.insertText", { text: "Run the tests you touch before you report.\nNever push to main." })
    await focusField("forApexes")
    await page.debugger.sendCommand("Input.insertText", { text: "Ask me before starting more than four Fins." })
    await leaveField()
    await until(`window.mako.finDefaults().then((reading) => reading.policy.forApexes === "Ask me before starting more than four Fins.")`, "both saved")
    assert.equal((await saved()).forFins, "Run the tests you touch before you report.\nNever push to main.")
    assert.deepEqual((await saved()).rules.length, 3, "the model rules are kept")

    /* Escape reverts and saves nothing. */
    await focusField("forApexes")
    await page.debugger.sendCommand("Input.insertText", { text: " Or five." })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await until(`document.activeElement !== document.querySelector(${JSON.stringify(field("forApexes"))})`, "Escape leaves the field")
    await new Promise((done) => setTimeout(done, 200))
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(field("forApexes"))}).value`), "Ask me before starting more than four Fins.", "the field shows the saved words")
    assert.equal((await saved()).forApexes, "Ask me before starting more than four Fins.", "and the host holds them, not the discarded edit")

    /* The fields are the kit's, raised like every Settings field. */
    const tone = (selector) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`)
    assert.equal(await tone(field("forFins")), await evaluate(`(() => { const probe = document.createElement("div"); probe.className = "bg-raised"; document.body.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color })()`), "raised, not sunken")
    assert.deepEqual(await evaluate(`[...document.querySelectorAll("[data-role-rules] button[aria-expanded]")].map((button) => button.innerText.trim())`), ["What every Fin reads", "What every Apex reads"])

    /* Each toggle shows only what the rules add, with a rough count. */
    await press(preview("forFins"))
    await until(`document.querySelector("[data-role-preview=forFins]") !== null`)
    const fin = await evaluate(`document.querySelector("[data-role-preview=forFins]").innerText`)
    assert.equal(fin.replace(/^~\d+(\.\d+)?K? tokens\n/, ""), "The person's rules for every Fin:\nRun the tests you touch before you report.\nNever push to main.", "a rough count, then the rule alone")
    await capture("fins-preview-dark.png", "[data-role-rules=forFins]")
    await press(preview("forFins"))
    await press(preview("forApexes"))
    await until(`document.querySelector("[data-role-preview=forApexes]") !== null`)
    const apex = await evaluate(`document.querySelector("[data-role-preview=forApexes]").innerText`)
    assert.ok(apex.includes("The person's rules for you as an Apex:\nAsk me before starting more than four Fins.\nThe person's rules for picking a Fin's harness and model"), "the Apex rules, then the model rules")
    assert.ok(!apex.includes("agents_*"), "never Mako's own paragraph")
    await capture("apex-preview-dark.png", "[data-role-rules=forFins]")

    /* Light. */
    await theme(true)
    await capture("apex-preview-light.png", "[data-role-rules=forFins]")
    await press(preview("forApexes"))
    await press(preview("forFins"))
    await capture("fins-preview-light.png", "[data-role-rules=forFins]")
    await capture("fields-light.png", "[aria-label='Your rules for Fins']")
    await theme(false)
    await press(preview("forFins"))
    await capture("fields-dark.png", "[aria-label='Your rules for Fins']")

    /* A save that doesn't go keeps the person's words in the field, marked unsaved; leaving the field again saves them. */
    await evaluate(`window.__saveRoleRules = window.mako.saveRoleRules; window.mako.saveRoleRules = () => Promise.reject(new Error("The host refused it.")); true`)
    await focusField("forApexes")
    await page.debugger.sendCommand("Input.insertText", { text: " Or five." })
    await leaveField()
    await until(`document.querySelector("[data-role-unsaved=forApexes]") !== null`, "the field is marked unsaved")
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(field("forApexes"))}).value`), "Ask me before starting more than four Fins. Or five.", "the typed words stay")
    assert.equal((await saved()).forApexes, "Ask me before starting more than four Fins.", "the host still holds what it saved")
    await capture("unsaved-dark.png", "[data-role-rules=forApexes]")
    await evaluate(`window.mako.saveRoleRules = window.__saveRoleRules; true`)
    await focusField("forApexes")
    await leaveField()
    await until(`window.mako.finDefaults().then((reading) => reading.policy.forApexes === "Ask me before starting more than four Fins. Or five.")`, "saved on the next blur")
    await until(`document.querySelector("[data-role-unsaved=forApexes]") === null`, "the mark goes once saved")

    /* The phone: the same two rules, saved to the account they follow (every Mac hears them), with the same toggles. */
    window.setSize(390, 844)
    await window.loadURL(`${process.env.MAKO_ROLE_RULES_URL}scripts/phone-fins.html`)
    const phone = (role) => `textarea[data-role-rules=${role}]`
    await until(`document.querySelector(${JSON.stringify(phone("forFins"))}) !== null`, "the phone's fields render")
    await press(phone("forFins"))
    await page.debugger.sendCommand("Input.insertText", { text: "Run the tests you touch before you report." })
    await press(phone("forApexes"))
    await page.debugger.sendCommand("Input.insertText", { text: "Ask me before starting more than four Fins." })
    await press("header h1")
    await until(`window.accountPreferences()["fins.forFins"] === "Run the tests you touch before you report." && window.accountPreferences()["fins.forApexes"] === "Ask me before starting more than four Fins."`, "the phone saved both to the account")
    assert.equal((await saved()).rules.length, 3, "the model rules are kept")
    const toggles = await evaluate(`[...document.querySelectorAll("button[aria-expanded]")].map((button) => button.innerText.trim())`)
    assert.deepEqual(toggles, ["What every Fin reads", "What every Apex reads"])
    await press(`button[aria-expanded]`)
    await until(`document.querySelector("[data-role-preview=forFins]") !== null`)
    assert.equal((await evaluate(`document.querySelector("[data-role-preview=forFins]").innerText`)).replace(/^~\d+(\.\d+)?K? tokens\n/, ""), "The person's rules for every Fin:\nRun the tests you touch before you report.", "the same preview as the desk")
    await capture("phone-dark.png", phone("forFins"))
    await window.loadURL(`${process.env.MAKO_ROLE_RULES_URL}scripts/phone-fins.html?theme=light`)
    await until(`document.querySelector(${JSON.stringify(phone("forFins"))}) !== null`)
    await press(phone("forFins"))
    await page.debugger.sendCommand("Input.insertText", { text: "Run the tests you touch before you report." })
    await press("header h1")
    await press(`button[aria-expanded]`)
    await until(`document.querySelector("[data-role-preview=forFins]") !== null`)
    await capture("phone-light.png", phone("forFins"))
    console.log("PASS: the kit's fields under the model rules, saved on blur, Escape discards, each toggle with only what the rules add, a save that fails keeps the words marked unsaved; the same on the phone; desk and phone captures in light and dark")
  } finally {
    clearTimeout(timer)
    window.destroy()
    app.quit()
  }
}
