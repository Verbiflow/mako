import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

if (process.versions.electron) {
  void checkElectron()
} else {
  await buildAndCheck()
}

async function buildAndCheck() {
  const { build, preview } = await import("vite")
  const directory = await mkdtemp(join(tmpdir(), "mako-renderer-assets-"))
  let server
  try {
    const outDir = join(directory, "dist")
    await build({
      logLevel: "error",
      build: {
        outDir,
        rollupOptions: { input: resolve("scripts/renderer-assets.html") },
      },
    })
    server = await preview({
      build: { outDir },
      preview: { host: "127.0.0.1", port: 0 },
    })
    const url = server.resolvedUrls.local[0]
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "mako-renderer-assets", main: fileURLToPath(import.meta.url) })
    )
    const environment = {
      ...process.env,
      MAKO_ASSET_TEST_ROOT: directory,
      MAKO_ASSET_TEST_URL: url,
      MAKO_ASSET_TEST_REPO: resolve("."),
    }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(resolve("node_modules/.bin/electron"), [directory], {
      stdio: "inherit",
      env: environment,
    })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server?.httpServer.close()
    await rm(directory, { recursive: true, force: true })
  }
}

// The dev server's origin and the packaged app's own scheme, each with the
// sandbox the desk runs under; `file:` is no longer a way the desk loads.
async function checkElectron() {
  const { app, BrowserWindow, protocol: electronProtocol } = await import("electron")
  const { DESK_ORIGIN, privilegedSchemes } = await import(
    pathToFileURL(resolve(process.env.MAKO_ASSET_TEST_REPO, "dist-electron/desk-scheme.js")).href
  )
  const { deskFileHandler } = await import(
    pathToFileURL(resolve(process.env.MAKO_ASSET_TEST_REPO, "dist-electron/desk-protocol.js")).href
  )
  const directory = process.env.MAKO_ASSET_TEST_ROOT
  app.setPath("userData", join(directory, "profile"))
  electronProtocol.registerSchemesAsPrivileged(privilegedSchemes())
  await app.whenReady()
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const previewRequests = []
  electronProtocol.handle("mako-app", deskFileHandler(join(directory, "dist"), async request => {
    previewRequests.push({ url: request.url, range: request.headers.get("range") })
    if (request.url !== "mako-file://asset/document.pdf?client=fixture") return new Response("Forbidden", { status: 403 })
    if (request.headers.get("range") === "bytes=0-3") return new Response("%PDF", { status: 206, headers: { "content-range": `bytes 0-3/${Buffer.byteLength(pdf)}` } })
    return new Response(pdf, { headers: { "content-type": "application/pdf" } })
  }))
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  try {
    for (const protocol of ["http", "mako-app"]) {
      if (protocol === "http")
        await window.loadURL(`${process.env.MAKO_ASSET_TEST_URL}scripts/renderer-assets.html`)
      else
        await window.loadURL(`${DESK_ORIGIN}/scripts/renderer-assets.html`)
      const result = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 5000;
        while (document.images.length < 3 && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 20));
        const images = await Promise.all([...document.images].map(async image => {
          await image.decode().catch(() => {});
          return { src: image.src, width: image.naturalWidth, height: image.naturalHeight };
        }));
        const masks = await Promise.all(['.ocean-grain', '.ocean-fin', '.ocean-fin-glint'].map(async selector => {
          const element = document.querySelector(selector);
          const maskUrl = getComputedStyle(element).maskImage.match(/url\\(["']?([^"')]+)/)[1];
          const mask = new Image();
          mask.src = maskUrl;
          await mask.decode().catch(() => {});
          return { selector, width: mask.naturalWidth };
        }));
        return { images, masks };
      })()`)
      assert.equal(result.images.length, 3, "Both ocean images and the About icon must mount")
      for (const image of result.images)
        assert.ok(image.width > 0 && image.height > 0, `${protocol}: asset failed to load: ${image.src}`)
      for (const mask of result.masks)
        assert.ok(mask.width > 0, `${protocol}: ${mask.selector} mask failed to load`)
      console.log(`${protocol}: ocean artwork, reflection, About icon and all CSS animation masks load`)
      if (protocol === "http") {
        const blocked = await window.webContents.executeJavaScript(`fetch('mako-app://desk/__mako_file/asset/document.pdf?client=fixture').then(() => false, () => true)`)
        assert.equal(blocked, true, "An unrelated HTTP origin must not read authorized desk files")
        assert.equal(previewRequests.length, 0, "Cross-origin requests must not reach the file authorization handler")
      }
      if (protocol === "mako-app") {
        const preview = await window.webContents.executeJavaScript(`(async () => {
          const url = 'mako-app://desk/__mako_file/asset/document.pdf?client=fixture';
          const bytes = await fetch(url).then(response => response.text());
          const range = await fetch(url, {headers:{Range:'bytes=0-3'}}).then(async response => ({status:response.status, bytes:await response.text()}));
          const denied = await fetch(url.replace('fixture', 'another-client')).then(response => response.status);
          const deadline = Date.now() + 10000;
          while (document.querySelector('canvas[aria-label="Protocol fixture.pdf, page 1"]')?.parentElement?.getAttribute('aria-busy') !== 'false' && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 25));
          return {bytes:bytes.slice(0,4), range, denied, canvas:document.querySelector('canvas[aria-label="Protocol fixture.pdf, page 1"]')?.width ?? 0, ready:document.querySelector('canvas[aria-label="Protocol fixture.pdf, page 1"]')?.parentElement?.getAttribute('aria-busy') === 'false', error:document.querySelector('[role="status"]')?.textContent};
        })()`)
        assert.equal(preview.bytes, "%PDF")
        assert.deepEqual(preview.range, {status:206, bytes:"%PDF"})
        assert.equal(preview.denied, 403, "Client authorization must survive same-origin routing")
        assert.ok(preview.canvas > 0, `Packaged PDF worker and XHR failed: ${preview.error}`)
        assert.equal(preview.ready, true, `PDF page rendering did not finish: ${preview.error}`)
        assert.ok(previewRequests.some(request => request.range === "bytes=0-3"))
        console.log("mako-app: authorized PDF bytes, range forwarding, rejected client and actual PDF worker rendering pass")
      }
    }
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}
