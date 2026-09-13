import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createServer } from "node:http"
import { once } from "node:events"

if (process.versions.electron) {
  void check()
    .then(async () => (await import("electron")).app.exit(0))
    .catch(async (error) => {
      console.error(error)
      ;(await import("electron")).app.exit(1)
    })
} else {
  const url = process.argv[2]
  assert.ok(
    url,
    "Pass the dev URL of a host started with a temporary MAKO_DATA_ROOT. A MAKO_PROFILE host shares the user's model connections; this check requires none."
  )
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  const root = await mkdtemp(join(tmpdir(), "mako-commit-ui-"))
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-commit-check",
      main: fileURLToPath(import.meta.url),
    })
  )
  const env = {
    ...process.env,
    MAKO_COMMIT_CHECK_ROOT: root,
    MAKO_COMMIT_CHECK_URL: url,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], {
    stdio: "inherit",
    env,
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
  console.log(`Commit UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_COMMIT_CHECK_ROOT
  const base = process.env.MAKO_COMMIT_CHECK_URL
  app.setPath("userData", join(root, "browser-profile"))
  await app.whenReady()
  const repository = join(root, "repository")
  await mkdir(repository)
  await promisify(execFile)("git", ["init", "-q"], { cwd: repository })
  await writeFile(
    join(repository, "feature.ts"),
    "export const change = 'Preserve drafts'\n"
  )
  await writeFile(
    join(repository, ".env"),
    "SYNTHETIC_SECRET=not-for-the-model\n"
  )
  await mkdir(join(repository, "nested"))
  await writeFile(join(repository, "nested", "a.ts"), "export const a = 1\n")
  await writeFile(join(repository, "nested", "b.ts"), "export const b = 2\n")
  let requests = 0
  let catalogRequests = 0
  let delay = 0
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const content = Buffer.concat(chunks).toString("utf8")
    assert.ok(!content.includes("not-for-the-model"))
    const listing = request.method === "GET" && request.url === "/v1/models"
    if (listing) catalogRequests += 1
    else requests += 1
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    response.setHeader("Content-Type", "application/json")
    if (request.headers.authorization !== "Bearer synthetic-ui-test") {
      response.statusCode = 401
      response.end(
        JSON.stringify({ error: { message: "Invalid synthetic credential" } })
      )
      return
    }
    if (listing) {
      response.end(
        JSON.stringify({
          data: [
            {
              id: "local-check",
              name: "My local model",
              context_length: 32_000,
            },
            ...Array.from({ length: 160 }, (_, index) => ({
              id: `local-${index}`,
              name: `Local model ${index}`,
            })),
          ],
        })
      )
      return
    }
    response.end(
      JSON.stringify({
        id: "check",
        object: "chat.completion",
        created: 1,
        model: "local-check",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({ action: "finish", result: { message: "fix: preserve commit drafts" }, requests: [], notes: "" }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && Object(address) === address)
  const window = new BrowserWindow({
    width: 1280,
    height: 960,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (source) => page.executeJavaScript(source)
  const capture = async (name) => {
    await evaluate(
      "document.fonts.ready.then(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))"
    )
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const until = async (source) => {
    const end = Date.now() + 30_000
    while (!(await evaluate(source))) {
      if (Date.now() > end) {
        await capture("failure.png")
        throw new Error(`Timed out: ${source}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  const click = async (selector, text = "", exact = false) => {
    await evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))"
    )
    const point = await evaluate(
      `(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => ${exact} ? node.textContent.trim() === ${JSON.stringify(text)} : node.textContent.startsWith(${JSON.stringify(text)})); if (!node) throw new Error('Missing click target'); node.scrollIntoView({block:'center'}); const r = node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
    )
    for (const type of ["mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        ...point,
      })
  }
  const fill = async (selector, text) => {
    await click(selector)
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).select()`
    )
    await page.debugger.sendCommand("Input.insertText", { text })
  }
  const escape = async () => {
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      })
  }
  const setTheme = async (theme) => {
    await click('[aria-label="Settings"]')
    await until(
      "[...document.querySelectorAll('[role=dialog] button')].some(node => node.textContent.trim() === 'Appearance')"
    )
    await click('[role="dialog"] button', "Appearance", true)
    await evaluate(
      "window.themeDiffNodes = [...document.querySelectorAll('diffs-container')]; void 0"
    )
    await click(
      '[role="dialog"] button',
      theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark",
      true
    )
    if (theme !== "system")
      await until(`document.documentElement.style.colorScheme === '${theme}'`)
    assert.ok(
      await evaluate("window.themeDiffNodes.every(node => node.isConnected)"),
      "Changing theme must not remount a diff"
    )
    for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, x: 8, y: 8 })
    await until("!document.querySelector('[role=dialog]')")
  }
  const watchdog = setTimeout(() => app.exit(1), 150_000)
  let connected = false
  try {
    await window.loadURL(base)
    await until("Boolean(document.querySelector('.composer-input'))")
    assert.equal(
      await evaluate(
        "import('/src/state/model-runtime.ts').then(async ({utilityModels}) => (await utilityModels.settings()).connections.length)"
      ),
      0,
      "Use a host started with a temporary MAKO_DATA_ROOT and no connected models"
    )
    await evaluate(
      `import('/src/state/session.ts').then(({actions}) => actions.openWorkspace(${JSON.stringify(repository)}))`
    )
    if (
      await evaluate(
        "Boolean(document.querySelector('[aria-label=\"Show the right sidebar\"]'))"
      )
    )
      await click('[aria-label="Show the right sidebar"]')
    await click('[data-surface-id="changes"]')
    await until(
      "Boolean(document.querySelector('[aria-label=\"Commit message\"]'))"
    )
    const stageTarget =
      '[role="checkbox"][aria-label="Stage feature.ts"], [role="checkbox"][title="Stage feature.ts"]'
    await until(
      `Boolean(document.querySelector(${JSON.stringify(stageTarget)}))`
    )
    const checkbox = await evaluate(
      `(() => { const node = document.querySelector(${JSON.stringify(stageTarget)}); window.stagingBox = node; const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`
    )
    assert.ok(
      checkbox.width >= 24 && checkbox.height >= 24,
      "Staging needs a stable 24px hit target, not a 14px glyph"
    )
    for (const x of [1, checkbox.width / 2, checkbox.width - 1])
      for (const y of [1, checkbox.height / 2, checkbox.height - 1]) {
        await page.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: checkbox.x + x,
          y: checkbox.y + y,
        })
        const hit = await evaluate(
          `(() => { const node = document.elementFromPoint(${checkbox.x + x}, ${checkbox.y + y}); return {same:node?.closest('[role=checkbox]') === window.stagingBox,cursor:getComputedStyle(node).cursor}; })()`
        )
        assert.equal(
          hit.same,
          true,
          `Checkbox hit target missing at ${x}, ${y}`
        )
        assert.equal(
          hit.cursor,
          "pointer",
          `Checkbox cursor changed at ${x}, ${y}`
        )
      }
    const edge = { x: checkbox.x + 1, y: checkbox.y + 1 }
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...edge,
    })
    await new Promise((resolve) => setTimeout(resolve, 160))
    const held = await evaluate(
      "(() => { const r = window.stagingBox.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()"
    )
    assert.deepEqual(
      held,
      checkbox,
      "Press feedback must not shrink or move the hit target"
    )
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...edge,
    })
    await until(
      "window.stagingBox.isConnected && window.stagingBox.getAttribute('aria-checked') === 'true' && window.stagingBox.getAttribute('aria-busy') !== 'true'"
    )
    assert.ok(
      (
        await promisify(execFile)("git", ["diff", "--cached", "--name-only"], {
          cwd: repository,
        })
      ).stdout.includes("feature.ts")
    )
    for (const type of ["mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        ...edge,
      })
    await until(
      "window.stagingBox.getAttribute('aria-checked') === 'false' && window.stagingBox.getAttribute('aria-busy') !== 'true'"
    )
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
      })
    await until(
      "window.stagingBox.getAttribute('aria-checked') === 'true' && window.stagingBox.getAttribute('aria-busy') !== 'true'"
    )
    await click('[role="checkbox"][aria-label="Unstage feature.ts"]')
    await until(
      "window.stagingBox.getAttribute('aria-checked') === 'false' && window.stagingBox.getAttribute('aria-busy') !== 'true'"
    )
    await click('[role="checkbox"][aria-label="Stage a.ts"]')
    await until(
      "document.querySelector('[role=checkbox][aria-label=\"Stage all of nested\"]')?.getAttribute('aria-checked') === 'mixed'"
    )
    await click('[role="checkbox"][aria-label="Stage all of nested"]')
    await until(
      "document.querySelector('[role=checkbox][aria-label=\"Unstage nested\"]')?.getAttribute('aria-checked') === 'true' && document.querySelector('[role=checkbox][aria-label=\"Unstage nested\"]')?.getAttribute('aria-busy') !== 'true'"
    )
    await click('[role="checkbox"][aria-label="Unstage nested"]')
    await until(
      "document.querySelector('[role=checkbox][aria-label=\"Stage all of nested\"]')?.getAttribute('aria-checked') === 'false' && document.querySelector('[role=checkbox][aria-label=\"Stage all of nested\"]')?.getAttribute('aria-busy') !== 'true'"
    )
    for (let clickIndex = 0; clickIndex < 3; clickIndex += 1) {
      for (const type of ["mousePressed", "mouseReleased"])
        await page.debugger.sendCommand("Input.dispatchMouseEvent", {
          type,
          button: "left",
          clickCount: 1,
          ...edge,
        })
    }
    await until(
      "window.stagingBox.getAttribute('aria-checked') === 'true' && window.stagingBox.getAttribute('aria-busy') !== 'true'"
    )
    await click('[role="checkbox"][aria-label="Unstage feature.ts"]')
    await until(
      "window.stagingBox.getAttribute('aria-checked') === 'false' && window.stagingBox.getAttribute('aria-busy') !== 'true'"
    )
    await capture("staging-hit-targets.png")
    await setTheme("dark")
    await click('button[title="feature.ts"]')
    await until("Boolean(document.querySelector('[aria-label=\"Show the diff\"]'))")
    if (
      await evaluate(
        "Boolean(document.querySelector('[aria-label=\"Show the diff\"]'))"
      )
    )
      await click('[aria-label="Show the diff"]')
    await until(
      "[...document.querySelectorAll('diffs-container')].some(node => node.shadowRoot?.querySelector('pre')?.getBoundingClientRect().height > 0)"
    )
    await capture("commit-and-diff-dark.png")
    const assertPalette = async (scheme) => {
      const colors = await evaluate(`(() => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--surface)'; document.body.appendChild(probe);
        const expected = getComputedStyle(probe).backgroundColor; probe.remove();
        return [...document.querySelectorAll('diffs-container')].filter(node => node.shadowRoot?.querySelector('pre')?.getBoundingClientRect().height > 0).map(node => ({
          expected, host: getComputedStyle(node).backgroundColor,
          code: getComputedStyle(node.shadowRoot.querySelector('pre')).backgroundColor,
          scheme: getComputedStyle(node).colorScheme,
        }));
      })()`)
      assert.ok(colors.length > 0)
      for (const color of colors) {
        assert.equal(
          color.host,
          color.expected,
          "Diff background must use Mako's surface token"
        )
        assert.equal(
          color.code,
          color.expected,
          "Code background must use Mako's surface token"
        )
        assert.equal(
          color.scheme,
          scheme,
          "Diff color scheme must follow the resolved app theme"
        )
      }
    }
    await assertPalette("dark")
    await click('button[title="feature.ts"]')
    await until(
      "Boolean(document.querySelector('[aria-label=\"Show the diff\"]'))"
    )
    await click('[aria-label="Show the diff"]')
    await until(
      "[...document.querySelectorAll('diffs-container')].filter(node => node.shadowRoot?.querySelector('pre')?.getBoundingClientRect().height > 0).length >= 2"
    )
    for (const scheme of ["light", "dark"]) {
      await setTheme(scheme)
      await until(
        "[...document.querySelectorAll('diffs-container')].filter(node => node.shadowRoot?.querySelector('pre')?.getBoundingClientRect().height > 0).length >= 2"
      )
      await until(`document.documentElement.style.colorScheme === '${scheme}'`)
      await assertPalette(scheme)
      await capture(`diff-${scheme}.png`)
    }
    await setTheme("system")
    for (const scheme of ["light", "dark"]) {
      await page.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: scheme }],
      })
      await until(`document.documentElement.style.colorScheme === '${scheme}'`)
      await assertPalette(scheme)
    }
    await click('[data-surface-id="files"]')
    await until(
      "Boolean(document.querySelector('input[placeholder=\"Find a file\"]'))"
    )
    await fill('input[placeholder="Find a file"]', "feature.ts")
    await until(
      "Boolean(document.querySelector('button[title=\"feature.ts\"]'))"
    )
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      })
    await until(
      "[...document.querySelectorAll('diffs-container')].some(node => node.shadowRoot?.querySelector('[data-file]'))"
    )
    await click('[data-surface-id="changes"]')
    await assertPalette("dark")
    await setTheme("light")
    await until("document.documentElement.style.colorScheme === 'light'")
    await assertPalette("light")
    await capture("file-light.png")
    await setTheme("dark")
    const layout = await evaluate(`(() => {
      const field = document.querySelector('[aria-label="Commit message"]');
      const button = [...field.parentElement.querySelectorAll('button')].find(button => /Connect.*model/.test(button.textContent));
      return { inputBottom: field.getBoundingClientRect().bottom, controlTop: button?.getBoundingClientRect().top ?? 0 };
    })()`)
    assert.ok(
      layout.controlTop >= layout.inputBottom,
      "Model setup belongs in the input footer, not in a banner above it"
    )
    await fill(
      '[aria-label="Commit message"]',
      "A handwritten message without any model"
    )
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('[data-commit-box] button')].find(button => button.textContent.startsWith('Commit all')).disabled"
      ),
      false,
      "Manual commits must not require a model connection"
    )
    await fill('[aria-label="Commit message"]', "")
    window.setSize(900, 960)
    await capture("commit-narrow.png")
    assert.equal(
      await evaluate(
        "(() => { const box = document.querySelector('[data-commit-box]'); return box.scrollWidth <= box.clientWidth; })()"
      ),
      true,
      "The commit controls must not overflow"
    )
    window.setSize(1280, 960)
    await click('[aria-label="Connect commit model"]')
    await until(
      "Boolean(document.querySelector('[aria-label=\"Connect Google\"]'))"
    )
    await capture("model-connections.png")
    await click('[aria-label="Connect Google"]')
    await until("Boolean(document.querySelector('input[type=password]'))")
    assert.equal(
      await evaluate("document.querySelector('input[type=password]').value"),
      ""
    )
    await capture("connect-google.png")
    assert.equal(
      await evaluate(
        `(() => { const input = document.querySelector('input[type=password]'); const r = input.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === input; })()`
      ),
      true,
      "The connection dialog must be above settings"
    )
    await until("document.body.textContent.includes('models.dev catalog')")
    assert.equal(
      await evaluate(
        "document.querySelectorAll('datalist, input[list]').length"
      ),
      0
    )
    await click('[aria-label="Choose commit model"]')
    await until(
      "[...document.querySelectorAll('[role=option]')].some(node => node.textContent.includes('Gemini 3.8 Flash'))"
    )
    await capture("google-model-picker.png")
    assert.ok(
      await evaluate(
        "getComputedStyle(document.querySelector('[role=listbox]')).fontFamily.includes('Geist')"
      )
    )
    await fill(
      '[aria-label="Search models or enter an ID"]',
      "gemini-3.8-flash"
    )
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      })
    await until(
      "!document.querySelector('[role=listbox]') && document.querySelector('[aria-label=\"Choose commit model\"]').textContent.includes('Gemini 3.8 Flash')"
    )
    assert.equal(
      await evaluate(
        "Number(document.querySelector('input[type=number]').value)"
      ),
      1_048_576
    )
    assert.equal(
      await evaluate("document.querySelectorAll('[role=alert]').length"),
      0,
      "Choosing a model must not submit the connection form"
    )
    assert.equal(requests, 0)
    await click('[aria-label="Refresh model catalog"]')
    await until("document.body.textContent.includes('models.dev catalog')")
    assert.ok(
      await evaluate(
        "document.querySelector('[aria-label=\"Choose commit model\"]').textContent.includes('Gemini 3.8 Flash')"
      )
    )
    await click('[aria-label="Close connection"]')
    for (const provider of [
      { name: "OpenAI", id: "gpt-6-astra", model: "GPT-6 Astra" },
      { name: "Anthropic", id: "claude-fable-5-1", model: "Claude Fable 5.1" },
    ]) {
      await click(`[aria-label="Connect ${provider.name}"]`)
      await until("document.body.textContent.includes('models.dev catalog')")
      await click('[aria-label="Choose commit model"]')
      await fill('[aria-label="Search models or enter an ID"]', provider.id)
      await until(
        `[...document.querySelectorAll('[role=option]')].some(node => node.textContent.includes(${JSON.stringify(provider.model)}))`
      )
      assert.equal(
        await evaluate("document.querySelectorAll('[role=option]').length"),
        1,
        "An exact model ID must not match unrelated names or context limits"
      )
      await capture(`${provider.name.toLowerCase()}-model-picker.png`)
      await click("[role=option]", provider.model)
      await click('[aria-label="Close connection"]')
    }
    await click('[aria-label="Connect OpenAI-compatible"]')
    await until("Boolean(document.querySelector('input[type=url]'))")
    await fill("input[type=password]", "wrong-synthetic-key")
    await fill("input[type=url]", `http://127.0.0.1:${address.port}/v1`)
    await click('[aria-label="Choose commit model"]')
    await fill('[aria-label="Search models or enter an ID"]', "local-check")
    await click("[role=option]", "local-check")
    assert.equal(requests, 0, "Custom model selection must not generate text")
    await click("button[type=submit]")
    await until("document.body.textContent.includes('rejected this API key')")
    await capture("connection-error.png")
    await fill("input[type=password]", "synthetic-ui-test")
    delay = 800
    await click("button", "Fetch models")
    await fill("input[type=password]", "changed-while-fetching")
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.equal(
      await evaluate(
        "document.body.textContent.includes('returned by your provider')"
      ),
      false,
      "A response for an old key must not replace the model catalog"
    )
    delay = 0
    await fill("input[type=password]", "synthetic-ui-test")
    await click("button", "Fetch models")
    await until(
      "document.body.textContent.includes('returned by your provider')"
    )
    assert.equal(
      requests,
      1,
      "Fetching models must not make a generation request"
    )
    assert.ok(catalogRequests >= 1)
    await click('[aria-label="Choose commit model"]')
    assert.ok(
      await evaluate("document.querySelectorAll('[role=option]').length <= 100")
    )
    for (let index = 0; index < 12; index += 1) {
      for (const type of ["keyDown", "keyUp"])
        await page.debugger.sendCommand("Input.dispatchKeyEvent", {
          type,
          key: "ArrowDown",
          code: "ArrowDown",
          windowsVirtualKeyCode: 40,
        })
    }
    await until(
      "(() => { const list = document.querySelector('[role=listbox]'); const row = list.querySelector('[data-highlighted=true]'); const a = row.getBoundingClientRect(); const b = list.getBoundingClientRect(); return a.top >= b.top && a.bottom <= b.bottom; })()"
    )
    await fill('[aria-label="Search models or enter an ID"]', "local-check")
    await click("[role=option]", "My local model")
    assert.equal(
      await evaluate("document.querySelectorAll('[role=option]').length"),
      0,
      "A selected menu must immediately stop intercepting clicks"
    )
    assert.equal(
      await evaluate(
        "Number(document.querySelector('input[type=number]').value)"
      ),
      32_000
    )
    await click("button[type=submit]")
    await until(
      "!document.querySelector('input[type=password]') && document.body.textContent.includes('Used for commits')"
    )
    connected = true
    const snapshot = await evaluate(
      "import('/src/state/model-runtime.ts').then(({utilityModels}) => utilityModels.settings())"
    )
    assert.ok(!JSON.stringify(snapshot).includes("synthetic-ui-test"))
    await capture("connected-model.png")
    await escape()
    await until("!document.querySelector('[role=dialog]')")
    await click('[aria-label="Hide the right sidebar"]')
    await until("!document.querySelector('[aria-label=\"Commit message\"]')")
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: "G",
        code: "KeyG",
        windowsVirtualKeyCode: 71,
        modifiers: 12,
      })
    await until(
      "document.querySelector('[aria-label=\"Commit message\"]')?.value === 'fix: preserve commit drafts'"
    )
    assert.ok(
      await evaluate(
        "document.body.textContent.includes('Sensitive file contents excluded')"
      )
    )
    await capture("generated-commit.png")
    assert.equal(await evaluate(`document.querySelector('[aria-label="Commit analysis mode"] button[aria-pressed="true"]')?.textContent.trim()`), "Fast")
    await click('[aria-label="Commit analysis mode"] button', "Deep")
    assert.equal(await evaluate(`document.querySelector('[aria-label="Commit analysis mode"] button[aria-pressed="true"]')?.textContent.trim()`), "Deep")
    delay = 1_000
    await click('[aria-label="Draft a message from the diff"]')
    await fill('[aria-label="Commit message"]', "My handwritten message")
    await until("document.body.textContent.includes('Use generated draft')")
    assert.equal(
      await evaluate(
        "document.querySelector('[aria-label=\"Commit message\"]').value"
      ),
      "My handwritten message"
    )
    await capture("draft-preserved.png")
    await click("button", "Keep mine")
    await click('[aria-label="Draft a message from the diff"]')
    await until("document.body.textContent.includes('Drafting...')")
    await click("button", "Cancel")
    await until("!document.body.textContent.includes('Drafting...')")
    assert.equal(
      await evaluate(
        "document.querySelector('[aria-label=\"Commit message\"]').value"
      ),
      "My handwritten message"
    )
    await evaluate(
      `import('/src/state/session.ts').then(({actions}) => actions.openWorkspace(${JSON.stringify(root)}))`
    )
    await evaluate(
      `import('/src/state/session.ts').then(({actions}) => actions.openWorkspace(${JSON.stringify(repository)}))`
    )
    await until(
      "document.querySelector('[aria-label=\"Commit message\"]')?.value === 'My handwritten message'"
    )
    assert.equal(
      (
        await promisify(execFile)("git", ["diff", "--cached"], {
          cwd: repository,
        })
      ).stdout,
      ""
    )
    assert.ok(requests >= 4)
    console.log(
      "PASS: dark/light/system diff and file palettes, live theme changes without remounts, compact commit footer, manual commits without a model, narrow layout, real-host connections, generation, draft preservation, cancellation, workspace switching; no commits or agent prompts"
    )
  } finally {
    if (connected)
      await evaluate(
        "import('/src/state/model-runtime.ts').then(({utilityModels}) => utilityModels.disconnect('openai-compatible'))"
      )
    server.closeAllConnections()
    server.close()
    clearTimeout(watchdog)
    window.destroy()
  }
}
