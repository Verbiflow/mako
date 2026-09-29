// Measures the real viewer's composited pixels, not IPC callbacks or <img> load events.
// Offscreen Electron composition is not a physical display or installed-host claim.
import assert from "node:assert/strict"
import { spawn, fork } from "node:child_process"
import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir, availableParallelism, loadavg } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { frontmostPid, sampleFrontmost } from "./lib/control-fixture.mjs"
import { recordedMarkers } from "./lib/control-video-markers.mjs"
import { processResources, summarizeProcessResources } from "./lib/control-process-resources.mjs"

if (process.versions.electron) {
  const { app } = await import("electron")
  void audit().then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )
} else {
  const { build, preview } = await import("vite")
  const baseline = process.argv.includes("--baseline")
  const seconds = Number(
    process.argv.find((value) => value.startsWith("--seconds="))?.slice(10) ?? 4
  )
  assert.ok(
    Number.isInteger(seconds) && seconds >= 1 && seconds <= 120,
    "--seconds must be an integer from 1 to 120"
  )
  const appArgument = process.argv.find(value => value.startsWith("--runtime-app="))?.slice(14)
  const runtimeApp = appArgument ? resolve(appArgument) : undefined
  const cpuProfile = process.argv.includes("--cpu-profile")
  assert.ok(!cpuProfile || (process.argv.includes("--shared-host") && !runtimeApp &&
    !process.argv.some(value => value.startsWith("--installed-session="))),
    "--cpu-profile is limited to the owned source-host fixture")
  assert.ok(!runtimeApp || (process.argv.includes("--shared-host") && !process.argv.some(value => value.startsWith("--installed-session="))),
    "--runtime-app measures an isolated packaged host; do not combine it with an installed task session")
  if (runtimeApp) {
    const { verifyLocalSignature, resolveLocalIdentity } = await import("./mac-local-signing.mjs")
    await verifyLocalSignature(runtimeApp, await resolveLocalIdentity(undefined, runtimeApp))
  }
  const root = await mkdtemp(join(tmpdir(), "mako-preview-latency-"))
  const identityPaths = [
    ...(runtimeApp ? [join(runtimeApp, "Contents/Resources/app.asar"),
      ...["ffmpeg", "ffprobe"].map(name => join(runtimeApp, "Contents/Resources/control-media/darwin-arm64", name))] : []),
    ...["control-media", "control-recording", "recording-render", "recording-encoder", "recording-encoder-worker", "recording-encoder-process", "recording-video-input"].flatMap(name => [
      `packages/control-runtime/src/${name}.ts`, `packages/control-runtime/dist/${name}.js`,
    ]),
    ...(process.env.MAKO_CONTROL_MEDIA_ROOT ? [join(process.env.MAKO_CONTROL_MEDIA_ROOT, "ffmpeg"), join(process.env.MAKO_CONTROL_MEDIA_ROOT, "ffprobe")] : []),
    "src/components/inspector/control-preview-image.tsx",
    "src/lib/control-preview-painter.ts", "src/lib/control-preview-decoder.ts",
    "dist-electron/control-previews.js", "dist-electron/runtime-connection.js",
  ]
  const identity = async () => Object.fromEntries(await Promise.all(identityPaths.map(async path =>
    [path, createHash("sha256").update(await readFile(path)).digest("hex")]
  )))
  const before = await identity()
  await writeFile(join(root, "identity-before.json"), JSON.stringify(before, null, 2))
  const config = {
    plugins: baseline
      ? [
          {
            name: "original-preview-image",
            enforce: "pre",
            transform(source, id) {
              if (
                !id.endsWith(
                  "/src/components/inspector/control-preview-image.tsx"
                )
              )
                return
              assert.ok(source.includes("createControlPreviewPainter"))
              return `import {useEffect,useState} from "react"; export function ControlPreviewImage({frame,label,className}) { const [url,setUrl]=useState(); useEffect(()=>{const value=URL.createObjectURL(new Blob([frame.image.bytes],{type:frame.image.mimeType}));setUrl(value);return ()=>URL.revokeObjectURL(value)},[frame]); return <img src={url} alt={label} className={className} decoding="async" /> }`
            },
          },
        ]
      : [],
    cacheDir: join(root, "cache"),
    build: {
      outDir: join(root, "dist"),
      rolldownOptions: {
        input: resolve("scripts/control-preview-performance.html"),
      },
    },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
    logLevel: "warn",
  }
  await build(config)
  const server = await preview(config)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-preview-audit",
      main: fileURLToPath(import.meta.url),
    })
  )
  const viewers = process.argv.includes("--two-viewers") ? 2 : 1
  const loadWorkers = Number(process.argv.find((value) => value.startsWith("--load-workers="))?.split("=")[1] ?? 0)
  const browserPid = Number(process.argv.find((value) => value.startsWith("--browser-pid="))?.split("=")[1] ?? 0)
  assert.ok(Number.isInteger(loadWorkers) && loadWorkers >= 0 && loadWorkers <= 4, "--load-workers must be 0–4")
  assert.ok(Number.isInteger(browserPid) && browserPid >= 0, "--browser-pid must be a process id")
  const env = {
    ...process.env,
    MAKO_PREVIEW_AUDIT_ROOT: root,
    MAKO_PREVIEW_BASELINE: baseline ? "1" : "0",
    MAKO_PREVIEW_RECORDING: process.argv.includes("--recording") ? "1" : "0",
    MAKO_PREVIEW_SHARED: process.argv.includes("--shared-host") ? "1" : "0",
    MAKO_PREVIEW_INSTALLED_SESSION: process.argv.find(value => value.startsWith("--installed-session="))?.split("=")[1] ?? "",
    MAKO_PREVIEW_CONVERSATION: process.argv.find(value => value.startsWith("--conversation="))?.split("=")[1] ?? "",
    MAKO_PREVIEW_EXTENSION:
      process.argv
        .find((value) => value.startsWith("--extension="))
        ?.slice("--extension=".length) ?? "",
    MAKO_PREVIEW_NODE: process.execPath,
    MAKO_PREVIEW_RUNTIME_APP: runtimeApp ?? "",
    MAKO_PREVIEW_CPU_PROFILE: cpuProfile ? "1" : "0",
    MAKO_PREVIEW_SECONDS: String(seconds),
    MAKO_PREVIEW_LOAD_WORKERS: String(loadWorkers),
    MAKO_PREVIEW_BROWSER_PID: String(browserPid),
    MAKO_PREVIEW_WINDOW: process.argv.includes("--background-window")
      ? "1"
      : "0",
    MAKO_PREVIEW_LEASE_FOCUS: process.argv.includes("--lease-focus")
      ? "1"
      : "0",
    MAKO_PREVIEW_IDENTITY: process.argv.includes("--identity") ? "1" : "0",
    MAKO_PREVIEW_CAPTURE: process.argv.includes("--png") ? "png" : "jpeg",
    MAKO_PREVIEW_AUDIT_URL: `${server.resolvedUrls.local[0]}scripts/control-preview-performance.html?viewers=${viewers}`,
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
    await new Promise((resolve) => server.httpServer.close(resolve))
    const after = await identity()
    await writeFile(join(root, "identity-after.json"), JSON.stringify(after, null, 2))
    assert.deepEqual(after, before, "Media implementation changed during measurement")
  }
  console.log(`Preview measurement artifacts: ${root}`)
}

async function audit() {
  const machine = { logicalCpus: availableParallelism(), loadAverageAtStart: loadavg(),
    cpuProfiled: process.env.MAKO_PREVIEW_CPU_PROFILE === "1" }
  const { app, BrowserWindow, ipcMain, powerSaveBlocker } = await import("electron")
  const { DeskBrowser } = await import("../dist-electron/desk-browser.js")
  const { deskPageForWindow } =
    await import("../dist-electron/desk-browser-window.js")
  const { BrowserService } = await import("@mako/control-runtime/browser")
  const { ControlPreviews } =
    await import("../dist-electron/control-previews.js")
  const { BrowserCommandSchema } =
    await import("@mako/control-runtime/contracts")
  const { invokeRuntime, invokeRuntimePreview, runtimeInfo, subscribeRuntime } =
    await import("../dist-electron/runtime-connection.js")
  let sizing
  const installedSession = process.env.MAKO_PREVIEW_INSTALLED_SESSION
  const installed = installedSession
    ? await (await import("./lib/installed-control-audit.mjs")).installedControlAudit(installedSession)
    : undefined
  const shared = !!installed || process.env.MAKO_PREVIEW_SHARED === "1"
  const extension = process.env.MAKO_PREVIEW_EXTENSION
  assert.ok(!extension || shared, "Extension acceptance requires --shared-host")
  assert.ok(!installed || (extension && process.env.MAKO_PREVIEW_CONVERSATION), "Installed acceptance requires exact browser and conversation IDs")
  const root = process.env.MAKO_PREVIEW_AUDIT_ROOT
  assert.ok(root)
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  if (process.platform === "darwin") app.setActivationPolicy("prohibited")
  // A windowless app is an App Nap candidate: macOS coalesces its timers and
  // lowers its priority, which reads as viewer freezes. A visible Mako window is not napped.
  const appNap = process.env.MAKO_PREVIEW_APP_NAP === "1" ? undefined : powerSaveBlocker.start("prevent-app-suspension")
  const durationMs = Number(process.env.MAKO_PREVIEW_SECONDS ?? 4) * 1000
  const watchdog = setTimeout(() => app.exit(2), durationMs + 90_000)
  const viewer = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      preload: resolve("dist-electron/preload.cjs"),
    },
  })
  viewer.webContents.setFrameRate(60)
  let source,
    captureStarts = 0,
    captureStops = 0
  const desk = new DeskBrowser({
    allowsUrl: (url) => url === "about:blank",
    createPage: async () => {
      source = new BrowserWindow({
        show: false,
        width: 1920,
        height: 1080,
        enableLargerThanScreen: true,
        webPreferences: { backgroundThrottling: false },
      })
      source.setContentSize(1920, 1080)
      await source.loadURL(
        `data:text/html,${encodeURIComponent(fixtureHTML())}`
      )
      const page = deskPageForWindow(source)
      return {
        ...page,
        send(method, params) {
          if (method === "Page.startScreencast") captureStarts++
          if (method === "Page.stopScreencast") captureStops++
          if (
            method === "Page.startScreencast" &&
            process.env.MAKO_PREVIEW_CAPTURE === "png"
          )
            return page.send(method, { ...params, format: "png" })
          return page.send(method, params)
        },
      }
    },
  })
  const browser = shared
    ? undefined
    : new BrowserService(() => [desk.definition])
  const socket = installed?.socket ?? join(root, "preview.sock"),
    client = installed?.client ?? randomUUID()
  // Same wall clock as the viewer page's stage trace (see previewAudit.trace).
  const wall = () => performance.timeOrigin + performance.now()
  const mainStages = { notified: [], reads: [], painted: [], lagged: [], served: [] }
  let lagTick = performance.now()
  const lagTimer = setInterval(() => {
    const now = performance.now()
    if (now - lagTick > 60) mainStages.lagged.push({ at: wall(), ms: now - lagTick - 20 })
    lagTick = now
  }, 20)
  let worker,
    unsubscribe = () => {},
    fixtureServer,
    focusSamples
  let previews
  const loadProcesses = []
  let notifications = 0,
    reads = 0,
    bytes = 0
  try {
    let wireBytes = 0,
      decodedBytes = 0
    if (shared) {
      if (!installed) {
        const workerEnv = { ...process.env }
        if (process.env.MAKO_PREVIEW_RUNTIME_APP) workerEnv.ELECTRON_RUN_AS_NODE = "1"
        worker = fork(
          fileURLToPath(
            new URL("./lib/control-preview-audit-host.mjs", import.meta.url)
          ),
          [],
          {
            execPath: process.env.MAKO_PREVIEW_RUNTIME_APP
              ? join(process.env.MAKO_PREVIEW_RUNTIME_APP, "Contents/MacOS/Mako") : process.env.MAKO_PREVIEW_NODE,
            execArgv: process.env.MAKO_PREVIEW_CPU_PROFILE === "1"
              ? ["--cpu-prof", `--cpu-prof-dir=${root}`] : process.execArgv,
            env: workerEnv,
            stdio: ["ignore", "inherit", "inherit", "ipc"],
          }
        )
        const ready = new Promise((resolve, reject) => {
          worker.once("message", (message) =>
            message.ready
              ? resolve()
              : reject(new Error("Unexpected host startup response"))
          )
          worker.once("exit", (code) =>
            reject(new Error(`Fixture host exited before readiness: ${code}`))
          )
          worker.once("error", reject)
        })
        worker.send({
          socket,
          extension,
          preferencePath: join(root, "preferences.json"),
          focusPolicy:
            process.env.MAKO_PREVIEW_LEASE_FOCUS === "1" ? "lease" : "action",
          definition: extension
            ? undefined
            : { ...desk.definition, endpoint: await desk.definition.endpoint() },
        })
        await ready
      } else await writeFile(join(root, "installed-identity.json"), JSON.stringify(installed.identity, null, 2))
      await new Promise((resolve) => {
        unsubscribe = subscribeRuntime(
          socket,
          client,
          (packet) => {
            if (packet.channel === "ready") resolve()
            if (
              packet.channel === "event" &&
              packet.payload.type === "control-activity"
            ) {
              notifications++
              if (!installed || packet.payload.activity.conversationId === process.env.MAKO_PREVIEW_CONVERSATION) {
                mainStages.notified.push(wall())
                viewer.webContents.send("mako:event", installed ? { ...packet.payload, activity: { ...packet.payload.activity, conversationId: "preview-audit" } } : packet.payload)
              }
            }
          },
          () => {},
          { observer: true }
        )
      })
      if (extension) {
        fixtureServer = createServer((_request, response) => {
          response.setHeader("content-type", "text/html; charset=utf-8")
          response.end(fixtureHTML())
        })
        await new Promise((resolve) =>
          fixtureServer.listen(0, "127.0.0.1", resolve)
        )
      }
    }
    const run = (command) =>
      installed ? installed.run(command) : shared
        ? invokeRuntime(socket, client, "mako:audit-browser", [command])
        : browser.execute(
            "preview-audit",
            BrowserCommandSchema.parse(command),
            AbortSignal.timeout(10_000)
          )
    previews = shared
      ? undefined
      : new ControlPreviews(
          browser,
          (image) => image,
          (activity) => {
            notifications++
            mainStages.notified.push(wall())
            viewer.webContents.send("mako:event", {
              type: "control-activity",
              activity,
            })
          }
        )
    ipcMain.handle(
      "mako:control-preview",
      async (_event, id, watching, watcher, box) => {
        const countTransfer = (transfer) => {
          wireBytes += transfer.wireBytes
          decodedBytes += transfer.decodedBytes
        }
        const readStarted = wall()
        // The same capability rule as the desktop client: older installed
        // hosts refuse a fourth argument.
        sizing ??= installed
          ? runtimeInfo(socket).then((info) => info?.previewSizing === true)
          : Promise.resolve(true)
        const sized = box && process.env.MAKO_PREVIEW_FULL_FRAMES !== "1" && (await sizing)
        const args = [installed ? process.env.MAKO_PREVIEW_CONVERSATION : id, watching, watcher, ...(sized ? [box] : [])]
        let value
        if (!shared) {
          value = previews.read(id, watching, watcher)
          if (value && sized) value = await previews.sized(value, box)
        } else if (process.env.MAKO_PREVIEW_IDENTITY === "1")
          value = await invokeRuntime(socket, client, "mako:audit-preview", [id, watching, watcher, ...args.slice(3)], 1, { onTransfer: countTransfer })
        else value = await invokeRuntimePreview(socket, client, args, countTransfer)
        if (value?.frame?.image.data) {
          value.frame.image = { mimeType: value.frame.image.mimeType, bytes: Buffer.from(value.frame.image.data, "base64") }
        }
        if (!watching) return null
        mainStages.reads.push({ started: readStarted, ended: wall(), id: value?.frame?.id,
          capturedAt: value?.frame?.capturedAt, publishedAt: value?.frame?.publishedAt,
          bytes: value?.frame?.image.bytes.byteLength ?? 0, box: sized ? box : undefined })
        reads++
        bytes += (value?.frame?.image.bytes.byteLength ?? 0) + JSON.stringify({ ...value, frame: value?.frame ? { ...value.frame, image: { mimeType: value.frame.image.mimeType } } : null }).length
        return value
      }
    )
    const samples = [],
      latencies = { click: [], type: [], scroll: [] }
    let rectangle,
      lastSequence,
      lastAck = 0,
      pendingInput,
      paints = 0,
      invalid = 0,
      observing = true
    viewer.webContents.on("paint", (_event, _dirty, image) => {
      const now = performance.now() // Same process/clock as input dispatch below.
      if (!rectangle || !observing) return
      paints++
      const pixels = image.toBitmap(),
        { width, height } = image.getSize()
      assert.equal(pixels.length, width * height * 4)
      const scale = width / 640
      const y = Math.floor(
        (rectangle.y + (rectangle.width * 450) / 1920) * scale
      )
      const words = []
      for (let byte = 0; byte < 6; byte++) {
        let value = 0
        for (let bit = 0; bit < 8; bit++) {
          const x = Math.floor(
            (rectangle.x + rectangle.width * ((byte * 8 + bit + 0.5) / 48)) *
              scale
          )
          const offset = (y * width + x) * 4
          value = (value << 1) | (pixels[offset] > 127 ? 1 : 0)
        }
        words.push(value)
      }
      if (
        words[4] !== 165 ||
        words[5] !== (words[0] ^ words[1] ^ words[2] ^ words[3] ^ 165)
      ) {
        if (!invalid++) {
          console.error("First invalid paint:", { width, height, rectangle, words })
          void writeFile(join(root, "invalid-paint.png"), image.toPNG())
        }
        return
      }
      const sequence = words[0] * 256 + words[1],
        ack = words[2] * 256 + words[3]
      if (sequence !== lastSequence) {
        mainStages.painted.push(performance.timeOrigin + now)
        samples.push({ sequence, at: now })
        lastSequence = sequence
      }
      lastAck = ack
      if (pendingInput && ack === pendingInput.ack) {
        latencies[pendingInput.kind].push(now - pendingInput.at)
        pendingInput = undefined
      }
    })
    const until = async (check, label, timeoutMs = 10_000) => {
      const deadline = performance.now() + timeoutMs
      while (!(await check())) {
        if (performance.now() >= deadline) {
          await writeFile(
            join(root, "failure.png"),
            (await viewer.webContents.capturePage()).toPNG()
          )
          console.error({
            rectangle,
            paints,
            invalid,
            notifications,
            reads,
            samples: samples.slice(-3),
          })
          assert.fail(`Timed out: ${label}`)
        }
        await delay(10)
      }
    }
    const frontmostBefore = extension ? await frontmostPid() : undefined
    if (extension) focusSamples = sampleFrontmost(120)
    await viewer.loadURL(process.env.MAKO_PREVIEW_AUDIT_URL)
    await run({ action: "connect", browser: extension || "mako" })
    const openCommand = { action: "open", browser: extension || "mako" }
    if (extension)
      openCommand.url = `http://127.0.0.1:${fixtureServer.address().port}`
    if (process.env.MAKO_PREVIEW_WINDOW === "1")
      openCommand.disposition = "window"
    const opened = await run(openCommand)
    const target = {
      browser: opened.browser,
      tab: opened.tab,
      generation: opened.generation,
      lease: opened.lease,
    }
    if (extension) {
      await run({
        action: "cdp",
        target,
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          width: 1920,
          height: 1080,
          deviceScaleFactor: 1,
          mobile: false,
        },
      })
      source = {
        webContents: {
          executeJavaScript: async (expression) => {
            const result = await run({
              action: "cdp",
              target,
              method: "Runtime.evaluate",
              params: { expression, returnByValue: true },
            })
            assert.ok(
              !result.exceptionDetails,
              "Fixture evaluation must succeed"
            )
            return result.result.value
          },
          capturePage: async () => {
            const result = await run({
              action: "cdp",
              target,
              method: "Page.captureScreenshot",
              params: { format: "png" },
            })
            return { toPNG: () => Buffer.from(result.data, "base64") }
          },
        },
      }
    }
    const initialPage = extension
      ? await source.webContents.executeJavaScript(
          "({ready:document.readyState,visibility:document.visibilityState,focus:document.hasFocus(),width:innerWidth,height:innerHeight,canvas:!!document.querySelector('canvas')})"
        )
      : undefined
    if (initialPage) console.error("Fixture document:", initialPage)
    // Keep setup captures out of the sustained source measurement: Chromium's
    // screenshot surface can differ from this fixture's emulated viewport.
    // Exact screenshot interference has its own test; source.png is saved below.
    previews?.observe({
      conversationId: "preview-audit",
      kind: "browser",
      operation: "observe",
      target: "fixture",
      status: "observed",
    })
    previews?.browserTarget("preview-audit", target, () => {})
    await until(async () => {
      rectangle = await viewer.webContents.executeJavaScript(
        // The painter sets the source aspect ratio on its first paint; canvas pixels now follow the displayed box.
        // The card arrives with a scale/opacity animation; its box is final only once that has finished.
        `(()=>{const image=document.querySelector('canvas, img');if(!image || !(image.style.aspectRatio || image.naturalWidth))return null;const card=image.closest('.control-preview-card');if(card?.getAnimations().some(a=>a.playState!=='finished'))return null;const r=image.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,pixels:image.width ? [image.width,image.height] : undefined}})()`
      )
      return rectangle
    }, "production preview image")
    // Startup is not what is measured; under load it may take longer than the
    // steady state it precedes.
    const startupAt = performance.now()
    await delay(2000)
    while (samples.length <= 10 && performance.now() - startupAt < 15_000) await delay(100)
    const startupMs = Math.round(performance.now() - startupAt)
    if (process.env.MAKO_PREVIEW_BASELINE !== "1" && samples.length <= 10) {
      const page = await viewer.webContents.executeJavaScript(
        "(()=>{const t=previewAudit.trace();return {demand:previewAudit.demand(),canvases:[...document.querySelectorAll('canvas')].map(c=>[c.width,c.height,c.clientWidth,c.clientHeight]),visibility:document.visibilityState,notified:t.notified.length,stored:t.stored.length,decoded:t.decoded.length,drawn:t.drawn.length,lagged:t.lagged.length}})()"
      )
      await writeFile(join(root, "failure.png"), (await viewer.webContents.capturePage()).toPNG())
      const served = shared && !installed ? (await invokeRuntime(socket, client, "mako:audit-cpu", [])).served : []
      const origin = mainStages.reads[0]?.started ?? 0
      console.error("Reads (start ms, duration ms, KB, box, host answered at ms):", mainStages.reads.slice(-20).map((read) =>
        [Math.round(read.started - origin), Math.round(read.ended - read.started), Math.round(read.bytes / 1024),
          read.box ? `${read.box.width}x${read.box.height}` : "full",
          ...served.filter((at) => at >= read.started && at <= read.ended).map((at) => Math.round(at - origin))]))
      console.error("Host answered (ms):", served.map((at) => Math.round(at - origin)))
      console.error("Audit main-process stalls (at ms, stalled ms):", mainStages.lagged.map((lag) => [Math.round(lag.at - origin), Math.round(lag.ms)]))
      assert.fail(`Valid composited pixel sequence: ${samples.length} distinct, ${paints} paints, ${invalid} invalid, ${reads} reads, ${notifications} notifications, viewer ${JSON.stringify(page)}`)
    }
    let recording =
      process.env.MAKO_PREVIEW_RECORDING === "1"
        ? await run({
            action: "recording",
            target,
            operation: "start",
            options: {
              directory: join(root, "recording"),
              fps: 60,
              maxSide: 1920,
              maxDurationMs: durationMs + 30_000,
            },
          })
        : undefined
    samples.length = 0
    paints = 0
    invalid = 0
    reads = 0
    bytes = 0
    notifications = 0
    wireBytes = 0
    decodedBytes = 0
    const hostCpuBefore = shared && !installed
      ? await invokeRuntime(socket, client, "mako:audit-cpu", [])
      : undefined
    const cpuBefore = new Map(
      app
        .getAppMetrics()
        .map((value) => [value.pid, value.cpu.cumulativeCPUUsage ?? 0])
    )
    const started = performance.now()
    const memory = []
    const resourceSamples = []
    const resourceRoots = { fixtureIncludingHost: process.pid }
    if (worker) resourceRoots.hostAndEncoder = worker.pid
    if (installed) {
      resourceRoots.installedHostTree = installed.hostPid
      resourceRoots.taskSessionTree = installed.sessionPid
    }
    if (Number(process.env.MAKO_PREVIEW_BROWSER_PID)) resourceRoots.wholeBrowser = Number(process.env.MAKO_PREVIEW_BROWSER_PID)
    const sampleMemory = async () => {
      const host = shared && !installed
        ? await invokeRuntime(socket, client, "mako:audit-cpu", [])
        : undefined
      if (host?.served) mainStages.served.push(...host.served)
      memory.push({
        loadAverage: loadavg(),
        atMs: performance.now() - started,
        electronWorkingSetBytes: app
          .getAppMetrics()
          .reduce(
            (sum, metric) => sum + metric.memory.workingSetSize * 1024,
            0
          ),
        hostRssBytes: host?.memory?.rss,
        hostHeapBytes: host?.memory?.heapUsed,
        hostEventLoopMs: host?.eventLoopMs,
      })
      const resources = await processResources(resourceRoots)
      resources.encoder = (resources.installedHostTree ?? resources.hostAndEncoder ?? resources.fixtureIncludingHost).filter((row) => row.executable.endsWith("/ffmpeg"))
      if (installed) resources.installedHostAndEncoder = resources.installedHostTree.filter(row => row.pid === installed.hostPid || row.executable.endsWith("/ffmpeg"))
      resourceSamples.push(resources)
    }
    await sampleMemory()
    for (let i = 0; i < Number(process.env.MAKO_PREVIEW_LOAD_WORKERS); i++) {
      const child = spawn(process.env.MAKO_PREVIEW_NODE, ["-e", `
        const {createHash}=require('node:crypto'); const bytes=Buffer.alloc(65536,17);
        let running=true; process.stdin.on('end',()=>{running=false}); process.stdin.resume();
        setTimeout(()=>{process.exit(0)},180000).unref();
        function work(){const end=performance.now()+20;while(performance.now()<end)createHash('sha256').update(bytes).digest();if(running)setImmediate(work)}work();
      `], { stdio: ["pipe", "ignore", "inherit"] })
      loadProcesses.push(child)
    }
    // Exercise input while both recording and synthetic load are active.
    // The old audit waited until after load ended, which understated loaded latency.
    const inputPhase = {}
    const inputWork = (async () => {
      await delay(Math.min(10000, durationMs / 2))
      inputPhase.startedAtMs = performance.now() - started
      inputPhase.viewport = await source.webContents.executeJavaScript("({width:innerWidth,height:innerHeight})")
      assert.deepEqual(inputPhase.viewport, { width: 1920, height: 1080 },
        "Fixture viewport changed before input; fixed-resolution pixel acceptance is invalid")
      if (recording) {
        const receipt = await run({ action: "recording", target, operation: "status", id: recording.id })
        inputPhase.recordingAtStart = receipt.status
      }
      for (const kind of ["click", "type", "scroll"]) {
        if (kind === "type")
          await run({ action: "click", target, at: { x: 400, y: 50 } })
        for (let i = 0; i < 12; i++) {
          // Arming changes no pixels: the trusted input's DOM event paints the acknowledgment.
          const ack = await source.webContents.executeJavaScript(
            "++window.fixture.nextAck"
          )
          pendingInput = { kind, ack, at: performance.now() }
          if (kind === "click")
            await run({ action: "click", target, at: { x: 100, y: 50 } })
          else if (kind === "type")
            await run({ action: "type", target, text: "a" })
          else
            await run({
              action: "scroll",
              target,
              at: { x: 1000, y: 800 },
              deltaY: 70,
            })
          await until(
            () => !pendingInput,
            `${kind} visible acknowledgment ${ack}, last ${lastAck}`
          )
        }
      }
      inputPhase.endedAtMs = performance.now() - started
    })()
    void inputWork.catch(() => {})
    const rateLabel = "[...document.querySelectorAll('[data-control-preview-task]')].map((task) => task.querySelector('[data-control-preview-rate]')?.textContent ?? null)"
    const rateLabels = []
    while (performance.now() - started < durationMs) {
      await delay(
        Math.min(1000, Math.max(0, durationMs - (performance.now() - started)))
      )
      await sampleMemory()
      rateLabels.push(await viewer.webContents.executeJavaScript(rateLabel))
    }
    await inputWork
    const elapsed = performance.now() - started
    for (const child of loadProcesses) child.stdin.end()
    const animated = samples.splice(0)
    const cpuSeconds = app
      .getAppMetrics()
      .reduce(
        (sum, value) =>
          sum +
          Math.max(
            0,
            (value.cpu.cumulativeCPUUsage ?? 0) -
              (cpuBefore.get(value.pid) ?? 0)
          ),
        0
      )
    const metrics = app.getAppMetrics()
    const coresOf = (metric) => metric &&
      (Math.max(0, (metric.cpu.cumulativeCPUUsage ?? 0) - (cpuBefore.get(metric.pid) ?? 0)) * 1000) / elapsed
    const viewerCores = {
      renderer: coresOf(metrics.find((metric) => metric.pid === viewer.webContents.getOSProcessId())),
      gpu: coresOf(metrics.find((metric) => metric.type === "GPU")),
      browser: coresOf(metrics.find((metric) => metric.type === "Browser")),
    }
    const hostCpuAfter = shared && !installed
      ? await invokeRuntime(socket, client, "mako:audit-cpu", [])
      : undefined
    const hostCpuCoreEquivalent = hostCpuAfter
      ? (hostCpuAfter.user +
          hostCpuAfter.system -
          hostCpuBefore.user -
          hostCpuBefore.system) /
        1000 /
        elapsed
      : 0
    const transfer = {
      reads,
      bytes,
      notifications,
      wireBytes,
      decodedBytes,
    }
    const gaps = animated
      .slice(1)
      .map((frame, index) => frame.at - animated[index].at)
    const stageTrace = await viewer.webContents.executeJavaScript("previewAudit.trace()")
    const stageWindow = [performance.timeOrigin + started, performance.timeOrigin + started + elapsed]
    const stalls = attributeStalls(mainStages, stageTrace, stageWindow)
    await writeFile(join(root, "stages.json"), JSON.stringify({ window: stageWindow, main: mainStages, viewer: stageTrace, stalls }))
    const windowReads = mainStages.reads.filter((read) => read.started >= stageWindow[0] && read.ended <= stageWindow[1])
    const animation = {
      elapsedMs: elapsed,
      startupMs,
      reads: { count: windowReads.length, sized: windowReads.filter((read) => read.box).length,
        kilobytes: stats(windowReads.map((read) => read.bytes / 1024)) },
      memory,
      resourceSamples,
      resources: summarizeProcessResources(resourceSamples, elapsed),
      requestedLoadWorkers: Number(process.env.MAKO_PREVIEW_LOAD_WORKERS),
      distinctFrames: animated.length,
      fps: (animated.length * 1000) / elapsed,
      gapsMs: stats(gaps),
      stages: summarizeStages(mainStages, stageTrace, stageWindow),
      stalls,
      ...transfer,
      cpuCoreEquivalent: (cpuSeconds * 1000) / elapsed,
      viewerCores,
      hostCpuCoreEquivalent,
      cpuBoundary: installed ? "Installed host/session trees include concurrent Mako tasks; encoder includes every FFmpeg descendant. Fixture viewer, whole browser and OS encoder services are separate. Summed RSS may double-count shared pages; no physical-scanout or isolated-host cost claim." :
        "Electron counters and host counters retain their prior scope. resources includes host descendants/FFmpeg; wholeBrowser includes ALL installed browser tabs, not target-only CPU. fixtureIncludingHost also includes requested synthetic load workers. videoToolboxServices covers all visible VTEncoderXPCService processes, including other applications; GPU/media-engine power is not measured. RSS sums can double-count shared pages.",
      paints,
      invalidPixelSamples: invalid,
      // The viewer's own "N of M fps" label, sampled once a second per viewer.
      shownRate: {
        samples: rateLabels.length,
        labelled: rateLabels.filter((labels) => labels.some(Boolean)).length,
        labelledPerViewer: [0, 1].map((index) => rateLabels.filter((labels) => labels[index]).length),
        labels: [...new Set(rateLabels.flat().filter(Boolean))],
      },
      // Fixture steps the first viewer's samples span; distinct/steps is its own shown ratio.
      fixtureStepsPerSecond: animated.length > 1 ? (((animated.at(-1).sequence - animated[0].sequence + 65536) % 65536) * 1000) / (animated.at(-1).at - animated[0].at) : 0,
    }
    await writeFile(
      join(root, "animation.json"),
      JSON.stringify(animation, null, 2)
    )
    if (process.env.MAKO_PREVIEW_BASELINE === "1") {
      console.log(
        JSON.stringify(
          { mode: "original async img", animated: animation },
          null,
          2
        )
      )
      return
    }
    assert.equal(
      invalid,
      0,
      "Every sampled image contains valid fixture pixels"
    )
    const oracle = await source.webContents.executeJavaScript(
      "({clicks:fixture.clicks,text:document.querySelector('input').value,scroll:document.querySelector('main').scrollTop})"
    )
    assert.equal(oracle.clicks, 12)
    assert.equal(oracle.text, "a".repeat(12))
    assert.ok(oracle.scroll > 0)
    const finalSequence = await source.webContents.executeJavaScript(
      "fixture.paused=true;fixture.sequence"
    )
    await until(
      () => lastSequence === finalSequence,
      "final source sequence reaches viewer"
    )
    samples.length = 0
    await delay(1000)
    assert.equal(
      samples.length,
      0,
      "Static pixels cannot inflate displayed fps"
    )
    // The label covers the last two seconds of source frames; a caret blink
    // keeps frames arriving, so it clears once that window has moved past.
    const stillAt = performance.now()
    await until(
      async () => !(await viewer.webContents.executeJavaScript(rateLabel)).some(Boolean),
      "reduced-rate label clears on a still page",
      3_000
    )
    const rateClearedAfterStillMs = performance.now() - stillAt
    // Scaled frames are judged against the full capture they came from, not
    // only against themselves.
    let capture
    if (mainStages.reads.some((read) => read.box)) {
      const conversation = installed ? process.env.MAKO_PREVIEW_CONVERSATION : "preview-audit"
      const read = (watching) => shared
        ? invokeRuntimePreview(socket, client, [conversation, watching, "fidelity"])
        : previews.read("preview-audit", watching, "fidelity")
      const full = (await read(true))?.frame
      await read(false)
      assert.ok(full && !full.id.includes(":"), "A read without a box returns the full capture")
      capture = full.image.data ?? Buffer.from(full.image.bytes).toString("base64")
    }
    const fidelity = await viewer.webContents.executeJavaScript(
      `previewAudit.fidelity(${capture ? JSON.stringify(capture) : ""})`
    )
    assert.equal(
      fidelity.length,
      new URL(process.env.MAKO_PREVIEW_AUDIT_URL).searchParams.get(
        "viewers"
      ) === "2"
        ? 2
        : 1
    )
    for (const image of fidelity) {
      // A sizing host scales the capture to the viewers' displayed pixels and
      // names that size in the frame id.
      const scaled = image.frameId.split(":")[1]
      if (scaled) {
        assert.equal(scaled, `${image.sourceWidth}x${image.sourceHeight}`, "A scaled frame is the size its id names")
        assert.ok(
          image.sourceWidth >= image.box[0] - 1 || image.sourceHeight >= image.box[1] - 1,
          `A viewer-sized frame fills its viewer: ${scaled} for ${image.box.join("x")}`
        )
        assert.ok(
          Math.abs(image.sourceWidth * 1080 - image.sourceHeight * 1920) <= 1500,
          "Scaling preserves the viewport aspect ratio"
        )
      } else if (extension) {
        assert.ok(
          image.sourceWidth >= 1920 && image.sourceHeight >= 1080,
          "Browser capture must retain at least the requested viewport resolution"
        )
        assert.equal(
          image.sourceWidth * 1080,
          image.sourceHeight * 1920,
          "Capture preserves viewport aspect ratio"
        )
      } else assert.deepEqual([image.sourceWidth, image.sourceHeight], [1920, 1080])
      assert.ok(
        Math.abs(image.width - image.displayed[0]) <= 1 &&
          Math.abs(image.height - image.displayed[1]) <= 1,
        `Viewer holds its displayed device pixels: ${image.width}x${image.height}, displayed ${image.displayed.join("x")}`
      )
      assert.ok(
        image.psnr >= 35 && image.meanAbsolute <= 2,
        `Viewer matches a high-quality downscale of the retained frame: ${image.psnr.toFixed(1)} dB, mean ${image.meanAbsolute.toFixed(2)}`
      )
      // Against Chromium's own downscale, the viewer decoding a full 1080p
      // capture itself scores 33.1 dB at a 576-pixel card; host scaling must
      // not fall below that.
      if (image.capture)
        assert.ok(
          image.capture.psnr >= 33 && image.capture.meanAbsolute <= 2.5,
          `Viewer matches a high-quality downscale of the full capture: ${image.capture.psnr.toFixed(1)} dB, mean ${image.capture.meanAbsolute.toFixed(2)}`
        )
      assert.equal(image.bytes, image.width * image.height * 4)
    }
    await writeFile(
      join(root, "viewer.png"),
      (await viewer.webContents.capturePage()).toPNG()
    )
    await writeFile(
      join(root, "source.png"),
      (await source.webContents.capturePage()).toPNG()
    )
    observing = false
    if (!extension)
      assert.equal(
        captureStarts,
        1,
        "All viewers and recording share the same capture"
      )
    const consumers = fidelity.length
    if (consumers === 2) {
      await viewer.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Hide preview"]').click()`
      )
      await delay(100)
      assert.equal(captureStops, 0, "Closing one viewer preserves its sibling")
    }
    await viewer.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Hide preview"]').click()`
    )
    await delay(100)
    const stoppedBeforeRecordingFinalization = !!recording && captureStops !== 0
    if (recording) {
      await run({
        action: "recording",
        target,
        operation: "stop",
        id: recording.id,
      })
      await until(
        async () => {
          recording = await run({
            action: "recording",
            target,
            operation: "status",
            id: recording.id,
          })
          return !["recording", "finalizing"].includes(recording.status)
        },
        "recording finalization",
        60_000
      )
    }
    if (!extension)
      await until(() => captureStops === 1, "last consumer stops capture")
    let restoredPage
    if (
      extension &&
      process.env.MAKO_PREVIEW_LEASE_FOCUS !== "1" &&
      process.env.MAKO_PREVIEW_WINDOW !== "1"
    ) {
      // The installed task's own conversation may also be open in a Mako
      // window, whose live preview is a viewer this audit does not own.
      let viewers
      try {
        await until(async () => {
          restoredPage = await source.webContents.executeJavaScript(
            "({visibility:document.visibilityState,focus:document.hasFocus()})"
          )
          // Installed activity may start the preview before the initial probe.
          // This fixture explicitly opened a background tab; capture must release
          // its emulated visibility after the fixture consumers stop. hasFocus
          // is reported separately; it is not an internal ownership receipt.
          if (!installed) return restoredPage.visibility === initialPage.visibility
          viewers = await invokeRuntime(socket, client, "mako:control-preview-viewers", [process.env.MAKO_PREVIEW_CONVERSATION])
            .catch((error) => ({ unavailable: error instanceof Error ? error.message : String(error) }))
          if (viewers.own === 0 && viewers.others > 0) return true
          return restoredPage.visibility === "hidden"
        }, "last consumer restores hidden page visibility")
        if (viewers?.others > 0)
          console.error("Capture continues for another client's viewer of this task:", viewers)
      } catch (error) {
        if (installed && error instanceof Error)
          error.message += viewers?.unavailable
            ? " (this host does not report preview viewers)"
            : ` with ${viewers?.own} own and ${viewers?.others} other viewers, capture ${viewers?.capturing ? "running" : "stopped"}`
        throw error
      } finally {
        if (installed) {
          await writeFile(join(root, "restoration.json"), JSON.stringify({ initialPage, restoredPage,
            viewers: viewers ?? "Not reported by this host", heldByAnotherViewer: viewers?.others > 0 }, null, 2))
        } else {
        const ownership = await invokeRuntime(
          socket,
          client,
          "mako:audit-capture",
          []
        )
        assert.ok(
          ownership.bindings.every(
            (binding) =>
              !binding.focusEnabled &&
              binding.focusUsers === 0 &&
              !binding.captureRunning &&
              binding.captureConsumers === 0
          ),
          "All capture and emulation owners must be released"
        )
        assert.equal(
          ownership.focusEvents.at(-1)?.enabled,
          false,
          "Browser acknowledged emulation reset"
        )
        viewers = await invokeRuntime(socket, client, "mako:control-preview-viewers", ["preview-audit"])
        assert.deepEqual(viewers, { own: 0, others: 0, capturing: false },
          "The host's viewer report agrees with the released capture")
        console.error("Capture restoration:", { restoredPage, ownership, viewers })
        await writeFile(
          join(root, "restoration.json"),
          JSON.stringify({ initialPage, restoredPage, ownership, viewers }, null, 2)
        )
        }
      }
    }
    if (extension) await run({ action: "close", target })
    const report = {
      runtimePackage: process.env.MAKO_PREVIEW_RUNTIME_APP || null,
      runtimeScope: installed ? "Live installed task session" : process.env.MAKO_PREVIEW_RUNTIME_APP
        ? "Isolated host executing signed packaged modules; not the desktop's live task host" : "Source fixture host",
      machine: { ...machine, loadAverageAtEnd: loadavg() },
      decoder: "shared JPEG ImageDecoder when supported; HTMLImage fallback",
      mediaTransport: process.env.MAKO_PREVIEW_IDENTITY === "1" ? "test-only JSON identity bridge to binary painter" : "bounded binary preview v1",
      boundary: `production ${extension ? "installed extension" : "desk"} capture → ControlPreviews → ${installed ? "running installed host and existing task / private Unix socket → " : shared ? "separate Node fixture host / private Unix socket → " : ""}Electron IPC/preload → production React overlay fixture → offscreen compositor pixels`,
      installed: installed?.identity,
      clock:
        "input dispatch and compositor delivery use the same main-process performance.now; excludes physical display scanout",
      dimensions: { sourceCss: [1920, 1080], preview: rectangle },
      captureFormat: process.env.MAKO_PREVIEW_CAPTURE,
      initialPage,
      restoredPage,
      disposition: process.env.MAKO_PREVIEW_WINDOW === "1" ? "window" : "tab",
      electron: process.versions.electron,
      animated: animation,
      inputPhase,
      inputToVisibleMs: Object.fromEntries(
        Object.entries(latencies).map(([key, values]) => [key, stats(values)])
      ),
      oracle,
      fidelity,
      consumers,
      frontmostBefore,
      frontmostSamples: focusSamples
        ? Object.fromEntries(await focusSamples.stop())
        : undefined,
      focusPolicy:
        process.env.MAKO_PREVIEW_LEASE_FOCUS === "1" ? "lease" : "action",
      captureStarts: extension ? null : captureStarts,
      captureStops: extension ? null : captureStops,
      recording: recording && {
        status: recording.status,
        error: recording.error,
        durationMs: recording.durationMs,
        frames: recording.frames,
        droppedFrames: recording.droppedFrames,
        sampledFrames: recording.sampledFrames,
        encodedFrames: recording.encodedFrames,
        encodedDurationMs: recording.encodedDurationMs,
        frameRate: recording.frameRate,
        dimensions: recording.dimensions,
        video: recording.video,
        timeline: recording.timeline,
      },
      paints,
      invalidPixelSamples: invalid,
      rateClearedAfterStillMs,
    }
    if (recording?.video) report.recordedMarkers = await recordedMarkers(recording.video, durationMs / 1000)
    await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    // Preserve input/restoration evidence even when sustained throughput misses its budget.
    if (recording) {
      assert.equal(recording.status, "finished", recording.error)
      assert.equal(stoppedBeforeRecordingFinalization, false, "Closing every viewer preserves recording")
    }
    // September 24: user accepts roughly 56 fps. Keep 60 as the target;
    // the sustained 55 fps floor cannot hide corrupt pixels or long stalls.
    // September 26: under requested load a lower rate is accepted when the
    // viewer shows it, so the floor applies to ordinary load only.
    if (!animation.requestedLoadWorkers) {
      assert.ok(animation.fps >= (durationMs >= 30_000 ? 55 : 45), `Composited unique fps: ${animation.fps}`)
      assert.ok(animation.shownRate.labelled <= Math.ceil(animation.shownRate.samples / 10),
        `Ordinary load rarely shows a reduced rate: ${JSON.stringify(animation.shownRate)}`)
    }
    if (durationMs >= 30_000) assert.ok(animation.gapsMs.max < 500, "Preview must not freeze for half a second")
    if (report.recordedMarkers) {
      assert.equal(report.recordedMarkers.invalidFrames, 0, "Recorded marker integrity")
      assert.ok(report.recordedMarkers.longestHoldMs < 500, "Recorded motion must not freeze for half a second")
      assert.ok(report.recordedMarkers.distinctFps >= (durationMs >= 30_000 ? 55 : 45),
        `Recorded unique fps: ${report.recordedMarkers.distinctFps}`)
    }
  } finally {
    for (const child of loadProcesses) child.kill("SIGTERM")
    await focusSamples?.stop()
    previews?.close()
    browser?.close()
    unsubscribe()
    await installed?.close().catch(error => console.error("Installed fixture cleanup failed:", error.message))
    if (worker?.connected) worker.send({ close: true })
    if (worker)
      await new Promise((resolve) => {
        if (worker.exitCode !== null) resolve()
        else worker.once("exit", resolve)
      })
    fixtureServer?.close()
    desk.close()
    viewer.destroy()
    ipcMain.removeHandler("mako:control-preview")
    clearTimeout(watchdog)
    clearInterval(lagTimer)
  }
}

// Viewer path in delivery order. A freeze belongs to the earliest stage that
// was also silent for most of it: everything after that stage had nothing to do.
function stageEvents(main, viewer) {
  let previous
  const newFrames = main.reads.filter((read) => {
    const fresh = read.id && read.id !== previous
    previous = read.id ?? previous
    return fresh
  })
  return [
    ["host notification reaches audit", main.notified],
    ["read returns a new frame", newFrames.map((read) => read.ended)],
    ["notification reaches viewer", viewer.notified],
    ["viewer stores frame", viewer.stored.map((frame) => frame.at)],
    ["decode completes", viewer.decoded.map((decode) => decode.at)],
    ["canvas draws", viewer.drawn],
    ["compositor paints", main.painted],
  ]
}

function longestSilence(times, from, to) {
  let last = from,
    longest = 0
  for (const at of times) {
    if (at <= from) continue
    if (at >= to) break
    longest = Math.max(longest, at - last)
    last = at
  }
  return Math.max(longest, to - last)
}

function attributeStalls(main, viewer, [start, end]) {
  const stages = stageEvents(main, viewer)
  const painted = main.painted.filter((at) => at >= start && at <= end)
  const stalls = []
  for (let i = 1; i < painted.length; i++) {
    const from = painted[i - 1],
      to = painted[i],
      duration = to - from
    if (duration <= 250) continue
    const silences = Object.fromEntries(
      stages.map(([name, times]) => [name, Math.round(longestSilence(times, from, to))])
    )
    const overlapping = main.reads.filter((read) => read.started < to && read.ended > from)
    const lag = (entries) => Math.round(Math.max(0, ...entries.filter((entry) => entry.at > from && entry.at - entry.ms < to).map((entry) => entry.ms)))
    const published = [...main.reads, ...viewer.stored].filter((frame) => frame.publishedAt > from && frame.publishedAt < to)
    stalls.push({
      atMs: Math.round(from - start),
      durationMs: Math.round(duration),
      cause: stages.find(([name]) => silences[name] >= duration * 0.8)?.[0] ?? "no single stage",
      silencesMs: silences,
      longestOverlappingReadMs: Math.round(Math.max(0, ...overlapping.map((read) => read.ended - read.started))),
      framesPublishedInside: new Set(published.map((frame) => frame.publishedAt)).size,
      mainLagMs: lag(main.lagged),
      viewerLagMs: lag(viewer.lagged),
    })
  }
  return stalls.sort((a, b) => b.durationMs - a.durationMs).slice(0, 20)
}

function summarizeStages(main, viewer, [start, end]) {
  const inside = (at) => at >= start && at <= end
  const reads = main.reads.filter((read) => inside(read.started))
  const stored = viewer.stored.filter((frame) => inside(frame.at))
  const round = (value) => value === undefined ? value : Math.round(value * 10) / 10
  const rounded = (values) => Object.fromEntries(Object.entries(stats(values)).map(([key, value]) => [key, round(value)]))
  // The owned fixture host stamps when its preview route answered (installed hosts do not).
  const split = reads.flatMap((read) => {
    const served = main.served.find((at) => at >= read.started && at <= read.ended)
    return served === undefined ? [] : [[served - read.started, read.ended - served]]
  })
  return {
    readMs: rounded(reads.map((read) => read.ended - read.started)),
    readRequestToHostMs: rounded(split.map(([request]) => request)),
    readHostToViewerMs: rounded(split.map(([, response]) => response)),
    hostCaptureToPublishMs: rounded(stored.map((frame) => frame.publishedAt - frame.capturedAt)),
    publishToViewerStoreMs: rounded(stored.map((frame) => frame.at - frame.publishedAt)),
    decodeMs: rounded(viewer.decoded.filter((decode) => inside(decode.at)).map((decode) => decode.ms)),
    silenceMs: Object.fromEntries(stageEvents(main, viewer).map(([name, times]) => [name, round(longestSilence(times.filter(inside), start, end))])),
    mainLagMs: rounded(main.lagged.filter((entry) => inside(entry.at)).map((entry) => entry.ms)),
    viewerLagMs: rounded(viewer.lagged.filter((entry) => inside(entry.at)).map((entry) => entry.ms)),
  }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  }
}

function fixtureHTML() {
  return `<style>body{margin:0;background:#181b20;color:#dbe5ef;font:14px monospace}button,input{position:absolute;top:20px;height:60px}button{left:20px;width:180px}input{left:300px;width:400px}canvas{position:fixed;top:400px;left:0}main{position:absolute;top:600px;height:450px;width:1900px;overflow:auto}pre{font:14px/21px monospace}</style>
<button>Save</button><input><canvas width="1920" height="100"></canvas><main><pre>${Array.from({ length: 300 }, (_, i) => `${i}  const result = await tab.locator({ role: "button", name: "Save ${i}" }).click(); // independently checked text`).join("\n")}</pre></main>
<script>
window.fixture={sequence:0,nextAck:0,ack:0,clicks:0,paused:false};
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
function paint(){const f=fixture;const words=[f.sequence>>8,f.sequence&255,f.ack>>8,f.ack&255,165];words.push(words.reduce((a,b)=>a^b,0));words.forEach((value,byte)=>{for(let bit=0;bit<8;bit++){ctx.fillStyle=value&(1<<(7-bit))?'white':'black';ctx.fillRect((byte*8+bit)*40,0,40,100)}})}
function ack(){fixture.ack=fixture.nextAck;paint()}
document.querySelector('button').onclick=()=>{fixture.clicks++;ack()};document.querySelector('input').oninput=ack;document.querySelector('main').onscroll=ack;
function animate(){if(!fixture.paused){fixture.sequence=(fixture.sequence+1)&65535;paint()}requestAnimationFrame(animate)}animate();
</script>`
}
