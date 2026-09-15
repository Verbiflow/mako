// Shared by the local-control e2e and the agent benchmark: an Electron window
// that stays behind the user's, its state written to a file every 100 ms,
// and the frontmost-application readers the invariants are checked with.
import { execFile, spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const runCommand = promisify(execFile)

/** The pid of the frontmost application, read from AppKit. */
export async function frontmostPid() {
  const { stdout } = await runCommand(
    "osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier',
    ],
    { timeout: 3000 }
  )
  const pid = Number(stdout.trim())
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error(`frontmost pid unreadable: ${stdout}`)
  return pid
}

/**
 * Frontmost, sampled continuously rather than before and after: the driver
 * once took the screen for a fifth of a second while it started, which two
 * point samples never caught. Every distinct pid seen is kept with a count.
 */
export function sampleFrontmost(intervalMs = 60) {
  const seen = new Map()
  let stopped = false
  const tick = async () => {
    while (!stopped) {
      try {
        const pid = await frontmostPid()
        seen.set(pid, (seen.get(pid) ?? 0) + 1)
      } catch {
        // A sample that fails to read is not a change.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
    }
  }
  const running = tick()
  return {
    async stop() {
      stopped = true
      await running
      return seen
    },
  }
}

/**
 * Electron main-process source for one fixture window: shown inactive, its
 * `#proof` field, selection length and `#result` output written to `status`.
 * `policy` "prohibited" keeps it out of the Dock and off the menu bar, the
 * harder background case; "regular" gives it Electron's default menu.
 */
export function electronFixtureSource({ title, html, status, userData, policy }) {
  return `
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(userData)});
app.whenReady().then(async () => {
 app.setAccessibilitySupportEnabled(true);
 app.setActivationPolicy(${JSON.stringify(policy)});
 const window = new BrowserWindow({show:false,width:650,height:420,title:${JSON.stringify(title)},webPreferences:{contextIsolation:true}});
 await window.loadFile(${JSON.stringify(html)});
 window.showInactive();
 setInterval(async () => { if (!window.isDestroyed()) fs.writeFileSync(${JSON.stringify(status + ".next")}, JSON.stringify({pid:process.pid, argv:process.argv, input:await window.webContents.executeJavaScript('document.getElementById("proof").value'), selection:await window.webContents.executeJavaScript('(()=>{const e=document.getElementById("proof");return e.selectionEnd-e.selectionStart})()'), value:await window.webContents.executeJavaScript('document.getElementById("result").textContent')})); fs.renameSync(${JSON.stringify(status + ".next")}, ${JSON.stringify(status)}); }, 100);
});
app.on('window-all-closed', () => app.quit());
`
}

/** The fixture page: a labelled Proof field, a Verify button and a result. */
export function fixtureHtml({ title, initial = "", form = false }) {
  const input = `<label>Proof <input aria-label="Proof" id="proof" value="${initial}"></label>`
  const verify = form
    ? `<form onsubmit="event.preventDefault();document.getElementById('result').textContent=document.getElementById('proof').value"><button type="submit">Verify proof</button></form><output id="result"></output><script>document.getElementById('proof').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('result').textContent = e.target.value })</script>`
    : `<button onclick="document.getElementById('result').textContent=document.getElementById('proof').value">Verify proof</button><output id="result"></output>`
  return `<title>${title}</title><h1>${title}</h1>${input}${verify}`
}

/**
 * Write and start one Electron fixture under `root`. Returns the process,
 * the status path and readers; `until` polls a condition against the file.
 */
export async function startElectronFixture({
  root,
  name,
  title,
  policy = "prohibited",
  initial = "",
  form = false,
  start = true,
}) {
  const html = join(root, `${name}.html`)
  const status = join(root, `${name}-status.json`)
  const main = join(root, `${name}.cjs`)
  await writeFile(html, fixtureHtml({ title, initial, form }))
  await writeFile(
    main,
    electronFixtureSource({
      title,
      html,
      status,
      userData: join(root, `${name}-user-data`),
      policy,
    })
  )
  const state = async () => JSON.parse(await readFile(status, "utf8"))
  const until = async (check, what, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    throw new Error(`Fixture condition timed out: ${what}`)
  }
  let child = null
  if (start) {
    child = spawn(resolve("node_modules/.bin/electron"), [main], {
      stdio: ["ignore", "ignore", "pipe"],
    })
    child.stderr.on("data", (chunk) => process.stderr.write(chunk))
  }
  return {
    process: child,
    main,
    html,
    status,
    state,
    until,
    async started() {
      return until(async () => {
        try {
          return await state()
        } catch {
          return null
        }
      }, `${name} fixture started`)
    },
    stop() {
      child?.kill("SIGTERM")
    },
  }
}
