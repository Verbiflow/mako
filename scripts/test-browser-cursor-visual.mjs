import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
if (!process.versions.electron) {
  const { build } = await import("esbuild")
  const built = await build({
    stdin: {
      contents: 'export {installCursor} from "./browser-extension/cursor.ts"',
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "iife",
    globalName: "Cursor",
    platform: "browser",
    write: false,
  })
  const root = await mkdtemp(join(tmpdir(), "mako-cursor-visual-"))
  await writeFile(join(root, "cursor.js"), built.outputFiles[0].text)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-cursor-visual",
      main: fileURLToPath(import.meta.url),
    })
  )
  const env = { ...process.env, MAKO_CURSOR_VISUAL_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], {
    env,
    stdio: "inherit",
  })
  process.exitCode = await new Promise((resolve) =>
    child.on("exit", (code) => resolve(code ?? 1))
  )
} else {
  void (async () => {
    const { app, BrowserWindow } = await import("electron")
    const { readFile } = await import("node:fs/promises")
    await app.whenReady()
    app.setActivationPolicy("prohibited")
    const root = process.env.MAKO_CURSOR_VISUAL_ROOT
    const window = new BrowserWindow({
      show: false,
      width: 850,
      height: 520,
      webPreferences: { backgroundThrottling: false },
    })
    try {
      await window.loadURL(
        "data:text/html," +
          encodeURIComponent(
            `<style>body{margin:0;background:#171410;color:#efeae4;font:14px -apple-system,sans-serif;padding:48px}h1{font-size:22px;font-weight:550;margin:0 0 32px}main{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{border:1px solid #534c44;border-radius:12px;padding:24px;background:#211d18}section+section{background:#fffaf3;color:#302c27}label{display:block;font-size:12px;margin:22px 0 8px}input{box-sizing:border-box;width:100%;padding:10px;background:transparent;border:1px solid #887e71;color:inherit;border-radius:6px}button{margin-top:20px;padding:8px 18px;border-radius:6px;border:1px solid #877b6c;background:#e8dfd2;color:#302c27}</style><h1>Invoice details</h1><main><section>Billing<label>Reference</label><input value="INV-00123"><button id="save">Save</button></section><section>Shipping<label>Address</label><input value="Tokyo"><button>Save</button></section></main>`
          )
      )
      const source = await readFile(join(root, "cursor.js"), "utf8")
      await window.webContents.executeJavaScriptInIsolatedWorld(42, [
        {
          code:
            source +
            ";Cursor.installCursor();window.makoCursor({x:124,y:258,pressed:true})",
        },
      ])
      assert.equal(
        await window.webContents.executeJavaScript("typeof window.makoCursor"),
        "undefined",
        "Page scripts cannot control the cursor"
      )
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.elementFromPoint(124,258)?.closest('button')?.id"
        ),
        "save",
        "The overlay cannot intercept clicks"
      )
      await writeFile(
        join(root, "cursor.png"),
        (await window.webContents.capturePage()).toPNG()
      )
      await window.webContents.executeJavaScriptInIsolatedWorld(42, [
        { code: "window.makoCursor({clear:true})" },
      ])
      await writeFile(
        join(root, "cleared.png"),
        (await window.webContents.capturePage()).toPNG()
      )
      console.log(
        `Cursor isolation, pointer transparency and clear passed. Visual evidence: ${root}`
      )
    } finally {
      window.destroy()
      app.quit()
    }
  })().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
}
