import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { createHash, generateKeyPairSync } from "node:crypto"

const executable = process.env.MAKO_TEST_BROWSER_EXECUTABLE
assert.ok(
  executable,
  "Set MAKO_TEST_BROWSER_EXECUTABLE to the Chromium executable under test"
)
const root = await mkdtemp("/private/tmp/mako-direct-jobs-")
let frameUrl
const extensionArgs = []
if (process.argv.includes("--restricted-frame")) {
  const directory = root + "/frame-extension"
  await mkdir(directory)
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).publicKey.export({ type: "spki", format: "der" })
  const id = createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
  await writeFile(
    directory + "/manifest.json",
    JSON.stringify({
      manifest_version: 3,
      name: "Mako restricted frame test",
      version: "1.0",
      key: key.toString("base64"),
      web_accessible_resources: [
        { resources: ["frame.html"], matches: ["http://127.0.0.1/*"] },
      ],
    })
  )
  await writeFile(
    directory + "/frame.html",
    "<p>Disposable extension frame</p>"
  )
  extensionArgs.push(
    `--load-extension=${directory}`,
    `--disable-extensions-except=${directory}`
  )
  frameUrl = `chrome-extension://${id}/frame.html`
}
const browser = spawn(
  executable,
  [
    `--user-data-dir=${root}`,
    ...extensionArgs,
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" }
)
try {
  let port
  for (let i = 0; i < 100; i++) {
    try {
      port = (await readFile(root + "/DevToolsActivePort", "utf8")).split(
        "\n"
      )[0]
      break
    } catch {}
    assert.equal(
      browser.exitCode,
      null,
      "Browser must remain running during startup"
    )
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(port, "Browser must publish its private CDP endpoint")
  let ready = false
  for (let i = 0; i < 100; i++) {
    const tabs = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json()
    if (tabs.some((t) => t.type === "page")) {
      ready = true
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(
    ready,
    "Wait for the initial browser page before creating background tabs"
  )
  const endpoint = (
    await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  ).webSocketDebuggerUrl
  const job = spawn(
    process.execPath,
    ["scripts/test-background-browser-job.mjs"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        MAKO_TEST_BROWSER: "fixture-cdp",
        MAKO_TEST_BROWSER_ENDPOINT: endpoint,
        MAKO_TEST_RESTRICTED_FRAME_URL: frameUrl,
      },
    }
  )
  const [code] = await once(job, "exit")
  assert.equal(code, 0, "The complete browser job must pass")
} finally {
  if (browser.exitCode === null && browser.signalCode === null) {
    const exited = once(browser, "exit")
    browser.kill("SIGTERM")
    const deadline = setTimeout(() => browser.kill("SIGKILL"), 3000)
    await exited
    clearTimeout(deadline)
  }
  console.log("Disposable profile:", root)
}
