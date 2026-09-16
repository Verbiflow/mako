import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { once } from "node:events"
import { BrowserService } from "../dist-electron/browser-service.js"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
} from "../dist-electron/contracts/browser-control.js"

const executable = process.env.MAKO_TEST_CHROME
if (!executable)
  throw new Error("Set MAKO_TEST_CHROME to a Chrome for Testing executable")
const root = await mkdtemp(join(tmpdir(), "mako-extension-e2e-"))
const registrations = join(root, "registrations")
const extension = resolve("dist-browser-extension")
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
  `import { startBrowserNativeHost } from ${JSON.stringify(new URL("../dist-electron/browser-native-host.js", import.meta.url).href)}; await startBrowserNativeHost(${JSON.stringify(registrations)}, process.stdin, process.stdout);`
)
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
const launcher = join(root, "host")
await writeFile(
  launcher,
  `#!/bin/sh\n${process.env.MAKO_EXPECT_BROWSER_PRODUCT ? `export MAKO_BROWSER_PRODUCT=${quote(process.env.MAKO_EXPECT_BROWSER_PRODUCT)}\n` : ""}exec ${quote(process.execPath)} ${quote(entry)} "$@"\n`,
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
let child
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const deadline = setTimeout(() => child.kill("SIGKILL"), 3000)
  await exited
  clearTimeout(deadline)
}
async function registration() {
  for (let n = 0; n < 200; n++) {
    const names = (await readdir(registrations).catch(() => [])).filter(
      (name) => name.endsWith(".json")
    )
    if (names.length)
      return JSON.parse(await readFile(join(registrations, names[0]), "utf8"))
    if (child.exitCode !== null)
      throw new Error("Chrome exited before connecting")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const port = (
    await readFile(join(root, "profile", "DevToolsActivePort"), "utf8")
  ).split("\n")[0]
  console.log(await (await fetch(`http://127.0.0.1:${port}/json/list`)).text())
  throw new Error(`Extension did not connect. Logs: ${root}/chrome.log`)
}
const page = createServer((_req, res) =>
  res
    .writeHead(200, { "content-type": "text/html" })
    .end(
      '<input aria-label="Proof" style="position:absolute;left:0;top:0;width:200px;height:40px"><script>window.trusted=false;document.querySelector("input").oninput=e=>window.trusted=e.isTrusted</script>'
    )
)
await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve))
const logs = []
try {
  let previousId
  let previousEndpoint
  for (let round = 0; round < 2; round++) {
    child = spawn(
      executable,
      [
        `--user-data-dir=${join(root, "profile")}`,
        `--load-extension=${extension}`,
        `--disable-extensions-except=${extension}`,
        "--headless=new",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    )
    child.stderr.on("data", (chunk) => logs.push(chunk.toString()))
    const value = await registration()
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
        requiresApproval: false,
        endpoint: async () => value.endpoint,
      },
    ])
    const run = (input) =>
      service.execute(
        "extension-e2e",
        BrowserCommandSchema.parse(input),
        new AbortController().signal
      )
    try {
      await run({ action: "connect", browser: value.id })
      const target = BrowserTargetSchema.parse(
        await run({ action: "open", browser: value.id })
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
      const screenshot = await run({ action: "screenshot", target })
      assert.ok(
        screenshot.coordinates.imageWidth > 0 &&
          screenshot.coordinates.imageHeight > 0
      )
      assert.equal(
        Buffer.from(screenshot.data, "base64").subarray(0, 2).toString("hex"),
        "ffd8"
      )
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
      console.log(
        `${value.name} round ${round + 1}: native messaging, trusted input, cross-client exclusion, screenshot, temporary tab/window ownership and cleanup passed`
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
  if (previous) await writeFile(registrationPath, previous)
  else await rm(registrationPath, { force: true })
  console.log(`Extension integration evidence: ${root}`)
}
