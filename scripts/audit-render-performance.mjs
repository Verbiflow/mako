import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

if (process.versions.electron) {
  void auditWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer, build, preview } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-render-performance-"))
  const production = process.argv.includes("--production")
  const fileMode = process.argv.includes("--file")
  assert.ok(!fileMode || production, "File loading requires a production build")
  const baselineMarkdown = process.argv.includes("--baseline-markdown")
  const localMarkdown = process.argv.includes("--local-markdown")
  const experiments = []
  if (localMarkdown)
    experiments.push({
      name: "audit-local-markdown-control",
      enforce: "pre",
      transform(source, id) {
        if (!id.endsWith("/src/components/transcript/markdown.tsx")) return
        const enabled = "Boolean(streaming) && !references"
        assert.ok(
          source.includes(enabled),
          "The local control must match the worker eligibility gate"
        )
        return source.replace(enabled, "false")
      },
    })
  if (baselineMarkdown)
    experiments.push({
      name: "audit-uncached-markdown-control",
      enforce: "pre",
      transform(source, id) {
        if (!id.endsWith("/src/components/transcript/markdown.tsx")) return
        const dependencies =
          "[source, plugins, referenceMap, urlTransform, rehypePlugins]"
        assert.equal(
          source.split(dependencies).length,
          2,
          "The control must match exactly one Markdown memo boundary"
        )
        return source.replace(
          dependencies,
          "[source, plugins, referenceMap, urlTransform, rehypePlugins, text]"
        )
      },
    })
  const config = {
    plugins: experiments,
    cacheDir: join(root, "cache"),
    resolve: {
      alias: {
        "react-markdown": resolve("scripts/performance-markdown-probe.tsx"),
      },
    },
    optimizeDeps: { entries: ["scripts/audit-render-performance.tsx"] },
    build: {
      outDir: join(root, "dist"),
      rolldownOptions: { input: resolve("scripts/performance-audit.html") },
    },
    server: { host: "127.0.0.1", port: 0, watch: null },
    preview: { host: "127.0.0.1", port: 0 },
    logLevel: "warn",
  }
  if (production) await build(config)
  const server = production ? await preview(config) : await createServer(config)
  if (!production) await server.listen()
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-performance-audit",
      main: fileURLToPath(import.meta.url),
    })
  )
  const env = {
    ...process.env,
    MAKO_PERF_ROOT: root,
    MAKO_PERF_URL: fileMode
      ? pathToFileURL(join(root, "dist/scripts/performance-audit.html")).href
      : `${server.resolvedUrls.local[0]}scripts/performance-audit.html`,
    MAKO_PERF_LOAD_MODE: fileMode ? "file" : "http",
    MAKO_PERF_MODE: production ? "production" : "development-profiler",
    MAKO_PERF_PARSE_MODE: localMarkdown
      ? "local-control"
      : "worker-for-large-streams",
    MAKO_PERF_EXPERIMENT: baselineMarkdown
      ? "uncached-markdown-control"
      : "production-memoization",
  }
  delete env.ELECTRON_RUN_AS_NODE
  const { default: electron } = await import("electron")
  try {
    const child = spawn(electron, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    if (production)
      await new Promise((resolve) => server.httpServer.close(resolve))
    else await server.close()
  }
  console.log(`Renderer audit evidence: ${root}`)
}

async function auditWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_PERF_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1440,
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
  const watchdog = setTimeout(() => {
    console.error("Renderer audit exceeded its bounded workload")
    app.exit(1)
  }, 240_000)
  const errors = []
  let stage = "load"
  page.on("console-message", ({ level, message }) => {
    if (level === "error") errors.push({ stage, message })
  })
  const until = async (expression) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(expression))) {
      if (Date.now() >= deadline) {
        await writeFile(
          join(root, "failure.png"),
          (await page.capturePage()).toPNG()
        )
        const state = await evaluate(
          `({focus:document.activeElement?.outerHTML.slice(0,500),turns:[...document.querySelectorAll('[data-exchange]')].map(node=>node.getAttribute('data-exchange')),scroll:[...document.querySelectorAll('.scroll-fade-scroller')].map(node=>({top:node.scrollTop,height:node.scrollHeight}))})`
        )
        assert.fail(
          `Condition timed out: ${expression}; ${JSON.stringify(state)}; ${JSON.stringify(errors)}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  const click = async (selector) => {
    const point = await evaluate(
      `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node) throw new Error('Missing target'); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`
    )
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point,
    })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    })
  }
  const cases = []
  try {
    await window.loadURL(process.env.MAKO_PERF_URL)
    await until(
      "Boolean(window.performanceAudit && document.querySelector('.composer-input'))"
    )
    for (const turns of [10, 1000, 5000]) {
      stage = `thread-${turns}`
      const began = performance.now()
      const initial = await evaluate(`window.performanceAudit.setup(${turns})`)
      cases.push({
        kind: "open",
        turns,
        elapsedMs: performance.now() - began,
        ...initial,
      })
      assert.ok(
        initial.mountedTurns > 0 && initial.mountedTurns <= Math.min(turns, 30)
      )
      assert.ok(
        initial.navigatorButtons <= 100,
        "Navigator mounting stays bounded"
      )
      await evaluate(
        "window.performanceAudit.done=false; void window.performanceAudit.stream(30).then(result=>{window.performanceAudit.result=result;window.performanceAudit.done=true})"
      )
      await evaluate("document.querySelector('.composer-input').focus()")
      const input = performance.now()
      await page.debugger.sendCommand("Input.insertText", {
        text: "Typing remains responsive",
      })
      const inputMs = performance.now() - input
      await until("window.performanceAudit.done")
      await until(
        "(() => {const node=document.querySelector('[data-exchange]')?.closest('.scroll-fade-scroller'); return node && node.scrollHeight-node.scrollTop-node.clientHeight < 3})()"
      )
      cases.push({
        kind: "stream",
        inputCommandMs: inputMs,
        ...(await evaluate("window.performanceAudit.result")),
      })
      assert.equal(
        await evaluate(
          "document.querySelector('.composer-input').value.includes('Typing remains responsive')"
        ),
        true
      )
      await writeFile(
        join(root, `thread-${turns}.png`),
        (await page.capturePage()).toPNG()
      )
      const rssKb = app
        .getAppMetrics()
        .reduce((total, process) => total + process.memory.workingSetSize, 0)
      assert.ok(
        rssKb < 2 * 1024 * 1024,
        "Audit stopped at its 2 GiB working-set limit"
      )
    }
    stage = "inactive-stream"
    await evaluate("window.performanceAudit.setup(5000)")
    cases.push({
      kind: "inactive-stream",
      ...(await evaluate("window.performanceAudit.stream(30,true)")),
    })
    stage = "jump-oldest"
    await evaluate("window.performanceAudit.setup(300)")
    const beforeJump = await evaluate("window.performanceAudit.metrics()")
    const jumpAt = performance.now()
    await click('nav[aria-label="Previous prompts"] button')
    await until(
      "Boolean(document.querySelector('[data-exchange=\"acp-request-00000000-0000-4000-8000-000000000001\"]'))"
    )
    assert.ok(
      await evaluate(
        "document.querySelectorAll('[data-exchange]').length <= 30"
      ),
      "Jumping to old history must not mount the entire suffix"
    )
    cases.push({
      kind: "jump-to-oldest",
      elapsedMs: performance.now() - jumpAt,
      before: beforeJump,
      after: await evaluate("window.performanceAudit.metrics()"),
    })
    await writeFile(
      join(root, "jump-oldest.png"),
      (await page.capturePage()).toPNG()
    )
    const anchorSelector =
      '[data-exchange="acp-request-00000000-0000-4000-8000-000000000001"]'
    const anchorBefore = await evaluate(
      `document.querySelector(${JSON.stringify(anchorSelector)}).getBoundingClientRect().top`
    )
    await evaluate("window.performanceAudit.stream(10)")
    const anchorAfter = await evaluate(
      `document.querySelector(${JSON.stringify(anchorSelector)}).getBoundingClientRect().top`
    )
    assert.ok(
      Math.abs(anchorBefore - anchorAfter) < 2,
      "Background tail growth must preserve the reader's history position"
    )
    await page.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "End",
      code: "End",
      windowsVirtualKeyCode: 35,
    })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "End",
      code: "End",
      windowsVirtualKeyCode: 35,
    })
    await until(
      "document.activeElement?.closest('[data-navigator-index]')?.getAttribute('data-navigator-index') === '299'"
    )
    await page.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    })
    await until(
      "Boolean(document.querySelector('[data-exchange=\"acp-request-00000000-0000-4000-8000-00000000012c\"]'))"
    )
    cases.push({
      kind: "virtual-history-correctness",
      anchorDriftPx: Math.abs(anchorBefore - anchorAfter),
      keyboardEndReached: true,
    })
    await evaluate("window.performanceAudit.setupEarlier()")
    await click('nav[aria-label="Previous prompts"] button')
    await page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 900,
      y: 300,
      deltaX: 0,
      deltaY: -2000,
    })
    // Nearing the top asks for earlier history by itself; the fixture holds
    // the answer until released so the position is measured mid-request.
    await until(
      "document.querySelector('[data-earlier=\"loading\"]')?.getBoundingClientRect().top >= 0"
    )
    const beforePrepend = await evaluate(
      `document.querySelector(${JSON.stringify(anchorSelector)}).getBoundingClientRect().top`
    )
    await evaluate("window.performanceAudit.releaseEarlier()")
    await until("Boolean(document.querySelector('[data-earlier=\"start\"]'))")
    await evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))"
    )
    const afterPrepend = await evaluate(
      `document.querySelector(${JSON.stringify(anchorSelector)}).getBoundingClientRect().top`
    )
    assert.ok(
      Math.abs(beforePrepend - afterPrepend) < 2,
      `Prepending history moved the anchor by ${afterPrepend - beforePrepend}px`
    )
    cases.push({
      kind: "virtual-prepend",
      anchorDriftPx: Math.abs(beforePrepend - afterPrepend),
      ...(await evaluate("window.performanceAudit.metrics()")),
    })
    for (const chars of [4096, 32768, 65536]) {
      stage = `markdown-${chars}`
      cases.push({
        kind: "streaming-markdown",
        ...(await evaluate(`window.performanceAudit.markdown(${chars})`)),
      })
    }
    await writeFile(
      join(root, "result.json"),
      JSON.stringify(
        {
          mode: process.env.MAKO_PERF_MODE,
          loading: process.env.MAKO_PERF_LOAD_MODE,
          parsing: process.env.MAKO_PERF_PARSE_MODE,
          experiment: process.env.MAKO_PERF_EXPERIMENT,
          electron: process.versions.electron,
          cases,
          errors,
        },
        null,
        2
      )
    )
    if (process.env.MAKO_PERF_EXPERIMENT === "production-memoization") {
      for (const item of cases.filter(
        (entry) => entry.kind === "streaming-markdown"
      )) {
        assert.ok(
          item.parses.calls <= item.parses.uniqueLengths + 1,
          "Unchanged displayed Markdown must not be reparsed beyond one worker handoff"
        )
        if (
          item.chars >= 16384 &&
          process.env.MAKO_PERF_PARSE_MODE === "worker-for-large-streams"
        )
          assert.equal(
            item.usedWorker,
            true,
            "Large streaming prose must use the parser worker"
          )
      }
    }
    assert.deepEqual(
      errors.filter(
        (entry) =>
          entry.message !==
          "ResizeObserver loop completed with undelivered notifications."
      ),
      []
    )
    console.log(
      `Recorded ${errors.length} ResizeObserver delivery warnings in the audit report`
    )
    for (const result of cases)
      console.log(
        JSON.stringify({
          kind: result.kind,
          turns: result.turns,
          chars: result.chars,
          apply: result.apply,
          frames: result.frameGaps,
          parseCalls: result.parses?.calls,
          uniqueTextLengths: result.parses?.uniqueLengths,
          elapsedMs: result.elapsedMs,
          inputMs: result.inputCommandMs,
        })
      )
  } finally {
    clearTimeout(watchdog)
    window.destroy()
    app.quit()
  }
}
