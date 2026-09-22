import { reloadExtensionFixture } from "./extension-reload-fixture.mjs"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash, generateKeyPairSync } from "node:crypto"
import {
  mkdtemp,
  cp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { once } from "node:events"
import { BrowserService } from "../dist-electron/browser-service.js"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
} from "../dist-electron/contracts/browser-control.js"

const executable = process.env.MAKO_TEST_BROWSER_EXECUTABLE
if (!executable)
  throw new Error(
    "Set MAKO_TEST_BROWSER_EXECUTABLE to a Chromium executable that supports loading unpacked extensions"
  )
const root = await mkdtemp(join(tmpdir(), "mako-extension-e2e-"))
const registrations = join(root, "registrations")
const sourceExtension = resolve(
  process.env.MAKO_TEST_EXTENSION ?? "dist-browser-extension"
)
const extension = process.argv.includes("--local-update")
  ? join(root, "extension")
  : sourceExtension
if (extension !== sourceExtension)
  await cp(sourceExtension, extension, { recursive: true })
const manifest = JSON.parse(
  await readFile(join(extension, "manifest.json"), "utf8")
)
const extensionId = createHash("sha256")
  .update(Buffer.from(manifest.key, "base64"))
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (value) =>
    String.fromCharCode(97 + parseInt(value, 16))
  )
// A second extension exposes a frame, reproducing Chromium's debugger
// security detach without modifying any extension in the user's profile.
const companion = join(root, "frame-extension")
await mkdir(companion)
const frameKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).publicKey.export({ type: "spki", format: "der" })
const frameId = createHash("sha256")
  .update(frameKey)
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (x) => String.fromCharCode(97 + parseInt(x, 16)))
await writeFile(
  join(companion, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Mako restricted frame fixture",
    version: "1.0",
    key: frameKey.toString("base64"),
    web_accessible_resources: [
      { resources: ["frame.html"], matches: ["http://127.0.0.1/*"] },
    ],
  })
)
await writeFile(
  join(companion, "frame.html"),
  "<p>Isolated extension frame fixture</p>"
)
const hosts = join(root, "profile", "NativeMessagingHosts")
const registrationPath = join(hosts, "dev.mako.browser.json")
await mkdir(hosts, { recursive: true })
const previous = await readFile(registrationPath).catch((error) => {
  if (error.code !== "ENOENT") throw error
  return null
})
const entry = join(root, "native.mjs")
await writeFile(
  entry,
  `import { startBrowserNativeHost } from ${JSON.stringify(process.env.MAKO_TEST_NATIVE_HOST ?? new URL("../dist-electron/browser-native-host.js", import.meta.url).href)}; await startBrowserNativeHost(${JSON.stringify(registrations)}, process.stdin, process.stdout);`
)
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
const launcher = join(root, "host")
await writeFile(
  launcher,
  `#!/bin/sh\nexport MAKO_BROWSER_ROOT=${quote(join(root, "profile"))}\n${process.env.MAKO_EXPECT_BROWSER_PRODUCT ? `export MAKO_BROWSER_PRODUCT=${quote(process.env.MAKO_EXPECT_BROWSER_PRODUCT)}\n` : ""}exec ${quote(process.execPath)} ${quote(entry)} "$@"\n`,
  { mode: 0o700 }
)
await writeFile(
  registrationPath,
  JSON.stringify({
    name: "dev.mako.browser",
    description: "Mako isolated integration test",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }),
  { mode: 0o600 }
)
await mkdir(join(root, "profile", "Default"), { recursive: true })
await writeFile(
  join(root, "profile", "Default", "Preferences"),
  JSON.stringify({
    extensions: { ui: { developer_mode: true } },
    download: {
      default_directory: join(root, "browser-downloads"),
      prompt_for_download: false,
    },
  })
)
if (process.argv.includes("--profile-metadata")) {
  await mkdir(join(root, "profile", "Default"), { recursive: true })
  await writeFile(
    join(root, "profile", "Local State"),
    JSON.stringify({
      profile: { info_cache: { Default: { name: "Work fixture" } } },
    })
  )
  await writeFile(
    join(root, "profile", "Default", "Preferences"),
    JSON.stringify({
      extensions: { ui: { developer_mode: true } },
      profile: { name: "Work fixture" },
      download: {
        default_directory: join(root, "browser-downloads"),
        prompt_for_download: false,
      },
    })
  )
}
const windowed = process.argv.includes("--windowed")
let child
async function stop() {
  if (!child) return
  if (windowed) {
    // LaunchServices owns this child: the open wrapper may already have exited.
    // Match the root executable AND our unique disposable profile every time.
    const owned = async () => {
      const { stdout } = await promisify(execFile)(
        "/bin/ps",
        ["-axo", "pid=,command="],
        { maxBuffer: 4 * 1024 * 1024 }
      )
      const profile = `--user-data-dir=${join(root, "profile")} `
      return stdout.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line)
        return match &&
          match[2].startsWith(executable + " ") &&
          match[2].includes(profile)
          ? [Number(match[1])]
          : []
      })
    }
    for (const pid of await owned()) {
      try {
        process.kill(pid, "SIGTERM")
      } catch (error) {
        if (error.code !== "ESRCH") throw error
      }
    }
    for (let n = 0; n < 30; n++) {
      if ((await owned()).length === 0) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    for (const pid of await owned()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch (error) {
        if (error.code !== "ESRCH") throw error
      }
    }
    return
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const deadline = setTimeout(() => child.kill("SIGKILL"), 3000)
  await exited
  clearTimeout(deadline)
}
async function registration(attempts = 200) {
  for (let n = 0; n < attempts; n++) {
    const names = (await readdir(registrations).catch(() => [])).filter(
      (name) => name.endsWith(".json")
    )
    if (names.length)
      return JSON.parse(await readFile(join(registrations, names[0]), "utf8"))
    if (!windowed && child.exitCode !== null)
      throw new Error("Chromium exited before connecting")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Extension did not connect. Logs: ${root}/chrome.log`)
}
const fixtureSaves = []
const page = createServer(async (req, res) => {
  if (req.url === "/download") {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename=proof.txt",
    })
    res.write("download proof ")
    setTimeout(() => res.end("東京 🐟"), 200)
    return
  }
  if (req.method === "POST" && req.url === "/save") {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    fixtureSaves.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.end("ok")
    return
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`
    <input aria-label="Proof" style="position:absolute;left:0;top:0;width:200px;height:40px">
    <button style="position:absolute;left:0;top:60px">Save</button>
    <script>window.trusted=false;document.querySelector('input').oninput=e=>window.trusted=e.isTrusted;
    document.querySelector('button').onclick=()=>{if(confirm('Save this value?'))fetch('/save',{method:'POST',body:JSON.stringify({value:document.querySelector('input').value})})}</script>`)
})
await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve))
const logs = []
const timings = []
try {
  let previousId
  let previousEndpoint
  for (let round = 0; round < 2; round++) {
    const browserArgs = [
      `--user-data-dir=${join(root, "profile")}`,
      ...(process.argv.includes("--recovery") ? ["--remote-debugging-port=0"] : []),
      `--load-extension=${extension},${companion}`,
      `--disable-extensions-except=${extension},${companion}`,
      ...(windowed ? [] : ["--headless=new"]),
      ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      process.argv.includes("--local-update")
        ? "chrome://extensions"
        : "about:blank",
    ]
    child = spawn(
      windowed ? "/usr/bin/open" : executable,
      windowed
        ? [
            "-g",
            "-n",
            "-W",
            "-a",
            dirname(dirname(dirname(executable))),
            "--args",
            ...browserArgs,
          ]
        : browserArgs,
      { stdio: ["ignore", "ignore", "pipe"] }
    )
    child.stderr.on("data", (chunk) => logs.push(chunk.toString()))
    let value = await registration()
    if (process.argv.includes("--local-update") && round === 0) {
      if (!windowed)
        throw new Error(
          "Local reload proof requires a windowed fixture with Developer mode enabled through its Settings UI."
        )
      await writeFile(
        "/tmp/mako-local-update-fixture.json",
        JSON.stringify({
          root,
          profile: join(root, "profile"),
          readyFile: join(root, "developer-mode-ready"),
        })
      )
      console.log(
        `Enable Developer mode in the disposable fixture, then create ${root}/developer-mode-ready`
      )
      const setupDeadline = Date.now() + 180000
      while (
        Date.now() < setupDeadline &&
        !(await readFile(join(root, "developer-mode-ready"), "utf8").catch(
          () => ""
        ))
      )
        await new Promise((resolve) => setTimeout(resolve, 250))
      assert.ok(
        await readFile(join(root, "developer-mode-ready"), "utf8"),
        "Fixture Developer mode was not enabled"
      )
      const before = value.endpoint
      const parts = manifest.version.split(".").map(Number)
      parts[parts.length - 1]++
      const newer = { ...manifest, version: parts.join(".") }
      await writeFile(join(extension, "manifest.json"), JSON.stringify(newer))
      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        const current = await registration()
        if (current.endpoint !== before) {
          value = current
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      assert.notEqual(
        value.endpoint,
        before,
        "Local file update reloads the idle unpacked extension"
      )
      assert.equal(value.extensionVersion, newer.version)
      console.log(
        "PASS: unpacked extension detects new local files and reloads while idle without a browser restart"
      )
    }
    assert.equal(
      value.applicationPath,
      process.platform === "darwin" ? dirname(dirname(dirname(executable))) : executable,
      "Native messaging resolves actual browser application without a debugging port"
    )
    if (process.argv.includes("--profile-metadata")) {
      assert.ok(
        value.profileDirectory?.startsWith(join(root, "profile") + "/"),
        "A unique browser profile is resolved"
      )
      assert.ok(
        value.profileName?.length,
        "Actual profile display name is available"
      )
      assert.equal(value.profileName, "Work fixture")
      console.log(
        JSON.stringify({
          name: value.name,
          profileName: value.profileName,
          exactProfile: true,
        })
      )
      console.log(
        "PASS: unique browser profile resolves its actual display name"
      )
      break
    }
    if (process.env.MAKO_EXPECT_BROWSER_PRODUCT)
      assert.match(
        value.name,
        new RegExp(process.env.MAKO_EXPECT_BROWSER_PRODUCT, "i")
      )
    if (previousId) {
      assert.equal(
        value.id,
        previousId,
        "Profile identity survives browser restart"
      )
      assert.notEqual(
        value.endpoint,
        previousEndpoint,
        "Restart rotates connection secret"
      )
    }
    previousId = value.id
    previousEndpoint = value.endpoint
    const service = new BrowserService([
      {
        id: value.id,
        name: value.name,
        kind: "chromium",
        transport: "extension",
        requiresApproval: false,
        endpoint: async () => value.endpoint,
      },
    ])
    const run = (input) => {
      const started = performance.now()
      return service
        .execute(
          "extension-e2e",
          BrowserCommandSchema.parse(input),
          new AbortController().signal
        )
        .finally(() =>
          timings.push({
            action: input.action,
            ms: performance.now() - started,
          })
        )
    }
    try {
      await run({ action: "connect", browser: value.id })
      const target = BrowserTargetSchema.parse(
        await run({ action: "open", browser: value.id, disposition: "window" })
      )
      await run({
        action: "navigate",
        target,
        url: `http://127.0.0.1:${page.address().port}`,
      })
      await run({ action: "click", target, at: { x: 40, y: 20 } })
      await run({ action: "type", target, text: `round-${round}` })
      const typed = await run({
        action: "evaluate",
        target,
        expression:
          '({ value: document.querySelector("input").value, trusted: window.trusted })',
      })
      assert.deepEqual(typed.result.value, {
        value: `round-${round}`,
        trusted: true,
      })
      if (process.argv.includes("--benchmark")) {
        const hidden = BrowserTargetSchema.parse(
          await run({ action: "open", browser: value.id, background: true })
        )
        await run({
          action: "navigate",
          target: hidden,
          url: `http://127.0.0.1:${page.address().port}`,
        })
        const samples = { observe: [], type: [] }
        for (let i = 0; i < 65; i++) {
          let started = performance.now()
          const view = await run({ action: "observe", target: hidden })
          const readMs = performance.now() - started
          const ref = view.nodes.find((node) => node.role === "textbox").ref
          started = performance.now()
          await run({
            action: "type",
            target: hidden,
            ref,
            text: `benchmark-${i}`,
            clear: true,
          })
          if (i >= 5) {
            samples.observe.push(readMs)
            samples.type.push(performance.now() - started)
          }
        }
        const metrics = {}
        for (const [action, values] of Object.entries(samples)) {
          values.sort((a, b) => a - b)
          metrics[action] = {
            count: values.length,
            p50: values[30],
            p95: values[57],
          }
        }
        await writeFile(
          join(root, `hidden-benchmark-${round}.json`),
          JSON.stringify(metrics, null, 2)
        )
        console.log(JSON.stringify({ hiddenBenchmark: metrics, round }))
        await run({ action: "close", target: hidden })
      }
      // Complete repeated replacements on the same external-browser tab.
      for (const text of [
        "00123",
        "  東京 🐟  ",
        "mako-background-3",
        "",
        "  ",
        "again",
      ]) {
        const view = await run({ action: "observe", target })
        const ref = view.nodes.find((node) => node.role === "textbox").ref
        await run({ action: "type", target, ref, text, clear: true })
        const actual = await run({
          action: "evaluate",
          target,
          expression: 'document.querySelector("input").value',
        })
        assert.equal(actual.result.value, text)
        const save = view.nodes.find(
          (node) => node.role === "button" && node.name === "Save"
        ).ref
        const count = fixtureSaves.length
        await run({ action: "dialog", target, auto: "dismiss" })
        await run({ action: "click", target, at: { ref: save } })
        assert.equal(
          fixtureSaves.length,
          count,
          "Canceled confirmation must not save"
        )
        await run({ action: "dialog", target, auto: "accept" })
        await run({ action: "click", target, at: { ref: save } })
        for (let n = 0; n < 100 && fixtureSaves.length === count; n++)
          await new Promise((resolve) => setTimeout(resolve, 20))
        assert.equal(
          fixtureSaves.length,
          count + 1,
          "Exactly one server-confirmed save per complete job"
        )
        assert.deepEqual(fixtureSaves.at(-1), { value: text })
      }
      if (process.argv.includes("--workflows")) {
        const started = performance.now()
        await run({
          action: "evaluate",
          target,
          expression: `(()=>{const b=document.createElement('button');b.textContent='Open receipt';b.style='position:absolute;top:120px;left:0';b.onclick=()=>window.open('/child','mako-child');document.body.append(b);return true})()`,
        })
        const popupView = await run({ action: "observe", target })
        await run({
          action: "click",
          target,
          at: {
            ref: popupView.nodes.find(
              (n) => n.role === "button" && n.name === "Open receipt"
            ).ref,
          },
        })
        let children
        for (let n = 0; n < 40; n++) {
          children = await run({ action: "children", target })
          if (children.children.length) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        assert.equal(
          children.children.length,
          1,
          "Page-opened child is discoverable by exact parent"
        )
        const childTab = BrowserTargetSchema.parse(
          await run({
            action: "select",
            browser: value.id,
            tab: children.children[0].tab,
          })
        )
        await run({
          action: "navigate",
          target: childTab,
          url: `http://127.0.0.1:${page.address().port}/child`,
        })
        const childView = await run({ action: "observe", target: childTab })
        assert.ok(childView.nodes.some((n) => n.role === "textbox"))
        const downloads = join(root, `downloads-${round}`)
        await mkdir(downloads)
        const downloaded = await run({
          action: "download",
          target: childTab,
          directory: downloads,
          url: `http://127.0.0.1:${page.address().port}/download`,
          timeoutMs: 5000,
        })
        assert.equal(downloaded.state, "completed", JSON.stringify(downloaded))
        assert.equal(
          await readFile(downloaded.path, "utf8"),
          "download proof 東京 🐟"
        )
        await run({
          action: "retain",
          target: childTab,
          name: "Download proof",
        })
        await run({ action: "release", target: childTab })
        console.log(
          JSON.stringify({
            workflow: "child-download-retain",
            round,
            elapsedMs: Math.round(performance.now() - started),
            download: downloaded,
          })
        )
      }
      const other = new BrowserService([
        {
          id: value.id,
          name: value.name,
          requiresApproval: false,
          endpoint: async () => value.endpoint,
        },
      ])
      try {
        await other.execute(
          "intruder",
          BrowserCommandSchema.parse({ action: "connect", browser: value.id }),
          new AbortController().signal
        )
        await assert.rejects(
          other.execute(
            "intruder",
            BrowserCommandSchema.parse({
              action: "select",
              browser: value.id,
              tab: target.tab,
            }),
            new AbortController().signal
          ),
          /owns|attached|claimed/
        )
      } finally {
        other.close()
      }
      if (!process.argv.includes("--background-input")) {
        const screenshot = await run({ action: "screenshot", target })
        assert.ok(
          screenshot.coordinates.imageWidth > 0 &&
            screenshot.coordinates.imageHeight > 0
        )
        assert.equal(
          Buffer.from(screenshot.data, "base64").subarray(0, 2).toString("hex"),
          "ffd8"
        )
      }
      await assert.rejects(
        run({
          action: "open",
          browser: value.id,
          context: "isolated",
        }),
        /cannot create isolated contexts/
      )
      const temporaryWindow = BrowserTargetSchema.parse(
        await run({
          action: "open",
          browser: value.id,
          disposition: "window",
        })
      )
      assert.deepEqual(await service.releaseOwner("extension-e2e"), {
        released: 2,
        closed: 2,
      })
      const remaining = await run({ action: "tabs", browser: value.id })
      assert.equal(
        remaining.some(
          (entry) =>
            entry.targetId === target.tab ||
            entry.targetId === temporaryWindow.tab
        ),
        false
      )
      const restricted = BrowserTargetSchema.parse(
        await run({ action: "open", browser: value.id, disposition: "window" })
      )
      await run({
        action: "navigate",
        target: restricted,
        url: `http://127.0.0.1:${page.address().port}`,
      })
      await assert.rejects(
        run({
          action: "cdp",
          target: restricted,
          method: "Runtime.evaluate",
          params: {
            expression: `new Promise(resolve=>{const frame=document.createElement('iframe');frame.src='chrome-extension://${frameId}/frame.html';document.body.appendChild(frame);setTimeout(resolve,1000)})`,
            awaitPromise: true,
          },
        }),
        (error) => error.detail?.outcome === "unknown"
      )
      const detachedCleanup = await service.releaseOwner("extension-e2e")
      assert.equal(
        detachedCleanup.closed,
        1,
        "security detach must not lose ownership of the still-open tab"
      )
      assert.equal(
        (await run({ action: "tabs", browser: value.id })).some(
          (entry) => entry.targetId === restricted.tab
        ),
        false
      )
      const cancelTarget = BrowserTargetSchema.parse(
        await run({ action: "open", browser: value.id })
      )
      const cancellation = new AbortController()
      const timer = setTimeout(() => cancellation.abort(), 150)
      try {
        await assert.rejects(
          service.execute(
            "extension-e2e",
            BrowserCommandSchema.parse({
              action: "evaluate",
              target: cancelTarget,
              expression:
                "window.makoCancellationCount=(window.makoCancellationCount||0)+1;new Promise(resolve=>setTimeout(()=>resolve(window.makoCancellationCount),1500))",
            }),
            cancellation.signal
          ),
          (error) => error.detail?.outcome === "unknown"
        )
      } finally {
        clearTimeout(timer)
      }
      await assert.rejects(
        run({
          action: "evaluate",
          target: cancelTarget,
          expression: "window.makoCancellationCount",
        }),
        (error) => error.detail?.outcome === "not-dispatched"
      )
      await run({ action: "observe", target: cancelTarget })
      const count = await run({
        action: "evaluate",
        target: cancelTarget,
        expression: "window.makoCancellationCount",
      })
      assert.equal(
        count.result.value,
        1,
        "Cancellation never replays the dispatched operation"
      )
      await run({ action: "close", target: cancelTarget })
      const ephemeral = BrowserTargetSchema.parse(
        await run({ action: "open", browser: value.id, lifetime: "task" })
      )
      const persistent = BrowserTargetSchema.parse(
        await run({ action: "open", browser: value.id, lifetime: "persistent" })
      )
      service.disconnect(value.id)
      await run({ action: "connect", browser: value.id })
      await assert.rejects(
        run({ action: "observe", target: persistent }),
        (error) => error.detail?.outcome === "not-dispatched"
      )
      let remainingAfterDisconnect
      for (let n = 0; n < 100; n++) {
        remainingAfterDisconnect = await run({
          action: "tabs",
          browser: value.id,
        })
        if (!remainingAfterDisconnect.some((t) => t.targetId === ephemeral.tab))
          break
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      assert.ok(
        !remainingAfterDisconnect.some((t) => t.targetId === ephemeral.tab),
        "Disconnected client closes task tab"
      )
      assert.ok(
        remainingAfterDisconnect.some((t) => t.targetId === persistent.tab),
        "Disconnected client preserves persistent tab"
      )
      const reclaimed = BrowserTargetSchema.parse(
        await run({ action: "select", browser: value.id, tab: persistent.tab })
      )
      await run({ action: "close", target: reclaimed })
      if (process.argv.includes("--recovery") && round === 0) {
        const interrupted = BrowserTargetSchema.parse(await run({action:"open", browser:value.id, background:true}))
        await run({action:"navigate",target:interrupted,url:`http://127.0.0.1:${page.address().port}`})
        await run({action:"click",target:interrupted,at:{x:40,y:20}})
        await run({action:"type",target:interrupted,text:"before-reload"})
        const proof=await reloadExtensionFixture(join(root,"profile"),extensionId,()=>registration(1),value.endpoint)
        value=proof.registration
        await assert.rejects(run({action:"type",target:interrupted,text:"must-not-replay"}))
        await run({action:"connect",browser:value.id})
        const fresh=BrowserTargetSchema.parse(await run({action:"select",browser:value.id,tab:interrupted.tab}))
        const inspected=await run({action:"evaluate",target:fresh,expression:'document.querySelector("input").value'})
        assert.equal(inspected.result.value,"before-reload")
        await run({action:"close",target:fresh})
        await writeFile(join(root,"forced-reload.json"),JSON.stringify(proof.recovery,null,2))
        console.log("Forced extension reload: durable interruption, preserved page, stale lease refusal and fresh inspection without replay passed")
      }
      console.log(
        `${value.name} round ${round + 1}: native messaging, trusted input, cross-client exclusion, six complete saved jobs with canceled confirmations, restricted-frame detach, temporary tab/window ownership, disconnect/reconnect lifetime cleanup, cancellation without replay and stale-handle refusal passed`
      )
    } finally {
      await service.close()
    }
    if (round === 0 && process.env.MAKO_E2E_EXTENSION_PROVIDERS) {
      const providerTest = spawn(
        process.execPath,
        [
          "scripts/test-provider-e2e.mjs",
          "--browser-only",
          ...process.env.MAKO_E2E_EXTENSION_PROVIDERS.split(","),
        ],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            MAKO_E2E_BROWSER_REGISTRATION_ROOT: registrations,
          },
        }
      )
      const [code] = await once(providerTest, "exit")
      assert.equal(
        code,
        0,
        "Provider browser workflows pass through the extension"
      )
    }
    await stop()
    for (let n = 0; n < 100; n++) {
      if ((await readdir(registrations)).length === 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.deepEqual(
      await readdir(registrations),
      [],
      "Browser shutdown removes registration"
    )
  }
} finally {
  await stop()
  await new Promise((resolve) => page.close(resolve))
  await writeFile(join(root, "chrome.log"), logs.join(""))
  await writeFile(
    join(root, "job-results.json"),
    JSON.stringify({ saves: fixtureSaves }, null, 2)
  )
  if (previous) await writeFile(registrationPath, previous)
  else await rm(registrationPath, { force: true })
  const metrics = {}
  for (const action of ["open", "observe", "type", "click", "screenshot"]) {
    const values = timings
      .filter((t) => t.action === action)
      .map((t) => t.ms)
      .sort((a, b) => a - b)
    if (values.length)
      metrics[action] = {
        count: values.length,
        p50: values[Math.floor(values.length * 0.5)],
        p95: values[
          Math.min(values.length - 1, Math.floor(values.length * 0.95))
        ],
      }
  }
  await writeFile(
    join(root, "performance.json"),
    JSON.stringify(metrics, null, 2)
  )
  console.log(JSON.stringify({ latencyMs: metrics }))
  console.log(`Extension integration evidence: ${root}`)
}
