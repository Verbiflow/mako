import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { ProviderArtifactPreview } from "../artifact-preview.js"

const require = createRequire(import.meta.url)
const runtimeJs = fileURLToPath(new URL("./canvas-runtime.js", import.meta.url))
const runtimePath = existsSync(runtimeJs)
  ? runtimeJs
  : fileURLToPath(new URL("./canvas-runtime.ts", import.meta.url))
const reactPath = require.resolve("react")
const reactDomPath = require.resolve("react-dom/client")
const allowedPackages = [
  dirname(reactPath),
  dirname(reactDomPath),
  dirname(require.resolve("scheduler")),
]

const STYLES = `
* { box-sizing: border-box; }
body { margin: 0; padding: 20px; color: var(--foreground); background: var(--surface); font: 440 var(--text-ui)/1.55 system-ui, sans-serif; }
h1,h2,h3,p { margin: 0; } h1,h2 { font-size: var(--text-title); font-weight: 640; } h3,strong { font-size: inherit; font-weight: 530; }
button { cursor: pointer; font: inherit; color: inherit; background: var(--raised); border: 1px solid var(--border); border-radius: 5px; padding: 4px 8px; }
button:hover { background: var(--fill-hover); } button:focus-visible, summary:focus-visible { outline: 2px solid var(--foreground); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: default; }
.canvas-pill { display: inline-flex; gap: 5px; align-items: center; border-radius: 20px; padding: 3px 9px; }
.canvas-pill[data-active=true] { background: var(--fill-selected); }
.canvas-card { border: 1px solid var(--border); border-radius: 7px; min-width: 0; }
.canvas-card-header { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.canvas-card-body { padding: 12px; }
.canvas-table { overflow: auto; } table { border-collapse: collapse; width: 100%; } td,th { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; } th { white-space: nowrap; font-weight: 530; }
.canvas-callout { border-left: 2px solid var(--border); padding: 8px 12px; } .canvas-callout strong { display: block; margin-bottom: 5px; }
.canvas-callout[data-tone=warning] { border-color: var(--caution); } .canvas-callout[data-tone=danger] { border-color: var(--negative); }
.canvas-text[data-tone=secondary], .canvas-text[data-tone=tertiary] { color: var(--muted-foreground); }
.canvas-text[data-size=small] { font-size: var(--text-label); } .canvas-text[data-weight=bold] { font-weight: 640; }
.canvas-link { border: 0; background: none; padding: 0; text-decoration: underline; }
.canvas-notice { position: sticky; bottom: 0; padding: 12px; background: var(--raised); border: 1px solid var(--border); overflow-wrap: anywhere; }
summary { cursor: pointer; padding: 8px 0; } hr { width: 100%; border: 0; border-top: 1px solid var(--border); }
code { font: 12px ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 620px) { .canvas-grid { grid-template-columns: minmax(0, 1fr) !important; } }
`

export const cursorCanvasPreview: ProviderArtifactPreview = {
  provider: "cursor",
  name: "Canvas",
  files: [".canvas.tsx"],
  via: "Cursor writes a canvas as a React file importing `cursor/canvas`; its SDK lists no artifacts for a local run.",
  async render(source) {
    if (source.length > 256_000)
      throw new Error(
        "This Canvas exceeds the preview size limit. Its source is still available."
      )
    const { build } = await import("esbuild")
    const result = await build({
      stdin: {
        contents:
          'import {createElement as h} from "react"; import {createRoot} from "react-dom/client"; import Canvas from "canvas-source"; import {CanvasNotice} from "cursor/canvas"; const root = createRoot(document.getElementById("canvas"), {onUncaughtError: () => {document.getElementById("canvas").textContent = "Canvas failed to render. Switch to Source to read the document."}}); root.render(h("main", null, h(Canvas), h(CanvasNotice)));',
        sourcefile: "canvas-entry",
        resolveDir: dirname(reactPath),
      },
      bundle: true,
      write: false,
      minify: true,
      platform: "browser",
      format: "iife",
      target: "es2022",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
      plugins: [
        {
          name: "canvas-boundary",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (
                args.path === "canvas-source" &&
                args.importer.endsWith("canvas-entry")
              )
                return { path: "canvas-source", namespace: "canvas" }
              if (args.path === "cursor/canvas") return { path: runtimePath }
              if (args.path === "react") return { path: reactPath }
              if (args.path === "react/jsx-runtime")
                return { path: require.resolve("react/jsx-runtime") }
              if (
                args.path === "react-dom/client" &&
                args.importer.endsWith("canvas-entry")
              )
                return { path: reactDomPath }
              // Dependencies of our own renderer can resolve normally. Artifact imports cannot touch disk.
              if (
                allowedPackages.some((root) =>
                  args.importer.startsWith(`${root}/`)
                )
              )
                return undefined
              return {
                errors: [
                  {
                    text: `Unsupported Canvas import: ${args.path}. The preview supports cursor/canvas and React only.`,
                  },
                ],
              }
            })
            builder.onLoad({ filter: /.*/, namespace: "canvas" }, () => ({
              contents: source,
              loader: "tsx",
            }))
          },
        },
      ],
    })
    const script = result.outputFiles[0]?.text
    if (!script || script.length > 4_000_000)
      throw new Error("Canvas preview could not be built within the size limit")
    // The iframe supplies no same-origin permission, host bridge, file access, or network transport.
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-canvas'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><style>${STYLES}</style></head><body><div id="canvas"></div><script nonce="canvas">${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`
  },
}
