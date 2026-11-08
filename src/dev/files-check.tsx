/* eslint-disable react-refresh/only-export-components -- This isolated check entry mounts the Files view and exposes no components. */
// The desk's Files panel and file viewer, against the host's real index of a folder (`scripts/files-ui.mjs`). No
// agent is started and nothing is written.
import { createRoot } from "react-dom/client"
import { useState } from "react"
import { installMockBridge } from "./mock-bridge"
import { FileTree } from "@/components/rail/file-tree"
import { DocumentView } from "@/components/viewer/file-viewer"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { FileIcon } from "@/components/ui/file-icon"
import { bindTheme, prefsStore } from "@/state/prefs"
import { activeDocument, useViewer, viewer } from "@/state/viewer"
import { FilesLayer } from "@/web-client/files-layer"
import { openFiles } from "@/web-client/files-open"
import type { FileFoldersOptions, FileGrepOptions } from "@mako/host/contracts/file-index"
import "../index.css"

const params = new URLSearchParams(location.search)
prefsStore.set({ theme: params.get("theme") === "light" ? "light" : "dark", openDirs: (params.get("open") ?? "").split(",").filter(Boolean) })
bindTheme()
installMockBridge()

async function call<T>(method: string, ...args: Array<string | number | string[] | FileFoldersOptions | FileGrepOptions | undefined>): Promise<T> {
  const response = await fetch(`/__files/${method}`, { method: "POST", body: JSON.stringify(args) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? response.statusText)
  return body
}
const bridge = window.mako!
Object.assign(bridge, {
  filesFolders: (paths: string[], options?: FileFoldersOptions) => call("folders", paths, options),
  filesFind: (query: string, limit?: number) => call("find", query, limit),
  filesGrep: (query: string, options?: FileGrepOptions) => call("grep", query, options),
  liveFilesFolders: (_id: string, paths: string[], options?: FileFoldersOptions) => call("folders", paths, options),
  liveFilesFind: (_id: string, query: string, limit?: number) => call("find", query, limit),
  liveFilesGrep: (_id: string, query: string, options?: FileGrepOptions) => call("grep", query, options),
  readLiveFile: (_id: string, path: string) => call("read", path),
  listFiles: () => call("list"),
  readFile: (path: string) => call("read", path),
  watchFile: async () => {},
  unwatchFile: async () => {},
})
const folder = await call<{ folder: string; name: string }>("folder")

function Check() {
  const documents = useViewer((state) => state.documents)
  const panes = useViewer((state) => state.panes)
  const focused = useViewer((state) => state.focusedPaneId)
  const document = activeDocument(documents, panes, focused)
  const [width] = useState(Number(params.get("panel") ?? 340))
  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen bg-shell p-1.5 text-foreground" data-files-check>
        <main className="flex min-w-0 flex-1 flex-col bg-surface">
          {document && document.kind !== "plan" ? <DocumentView document={document} /> : <p className="m-auto text-ui text-faint">Open a file</p>}
        </main>
        <div className="w-1.5 shrink-0" />
        <aside style={{ width }} className="flex min-h-0 shrink-0 flex-col bg-surface">
          <div className="flex h-9 shrink-0 items-center px-3 text-ui font-medium text-foreground">Files</div>
          <WorkspaceFocusContext.Provider value={{ cwd: folder.folder, identity: folder.folder, ready: true }}>
            <FileTree />
          </WorkspaceFocusContext.Provider>
        </aside>
      </div>
    </TooltipProvider>
  )
}

/** `?icons`: every kind's mark beside a file of that kind, at the tree's size. */
const SAMPLES = ["src", "index.ts", "view.tsx", "main.js", "App.jsx", "types.d.ts", "app.py", "lib.rs", "main.go", "model.rb", "Main.java", "App.kt", "View.swift", "main.c", "engine.cpp", "Program.cs", "index.php", "README.md", "guide.md", "LICENSE", "package.json", "tsconfig.json", "data.json", "config.yaml", "Cargo.toml", ".env", "index.html", "styles.css", "logo.svg", "photo.png", "clip.mp4", "sound.wav", "report.pdf", "table.csv", "bundle.zip", "package-lock.json", "server.pem", ".gitignore", "build.sh", "schema.sql", "view.test.ts", "Inter.woff2", "notes.ipynb", "fix.patch", "server.log", "module.wasm", "Dockerfile", "notes.txt", "Makefile", "query.graphql", "App.vue", "unknown.xyz"]
function Icons() {
  return (
    <div className="grid h-screen grid-cols-4 content-start gap-x-4 gap-y-2 bg-surface p-6 text-ui text-foreground/90">
      {SAMPLES.map((name) => (
        <div key={name} className="flex items-center gap-2">
          <FileIcon path={name} folder={name === "src"} className="size-4 text-muted-foreground" />
          {name}
        </div>
      ))}
    </div>
  )
}

/** `?form=phone`: the web app's Files over a Thread, as a phone draws it. */
function Phone() {
  return (
    <TooltipProvider>
      <div className="web-app relative flex h-screen w-screen overflow-hidden bg-shell text-foreground" data-form="phone">
        <main className="relative flex min-w-0 flex-1 flex-col">
          <FilesLayer form="phone" place="thread:check" />
        </main>
      </div>
    </TooltipProvider>
  )
}

// `?file=`: the file the viewer opens, as a click in the tree would.
const opening = params.get("file")
if (opening && params.get("form") !== "phone") void viewer.open(opening)

if (params.get("form") === "phone") {
  await import("@/web-client/style.css")
  openFiles({ conversation: "check" })
  const path = params.get("path")
  if (path) openFiles({ conversation: "check", path })
}
createRoot(document.getElementById("root")!).render(params.has("icons") ? <Icons /> : params.get("form") === "phone" ? <Phone /> : <Check />)
