import { readFile, stat } from "node:fs/promises"
import { basename, isAbsolute, join, resolve } from "node:path"
import { createServer } from "vite"

/*
 * The desk's Files panel and file viewer on a page of their own (`scripts/files-check.html`), answered by the host's
 * real index of a folder: the tree, names and lines found as they're typed, and files read from disk. For looking at
 * the view and timing it in a browser; it starts no host and writes nothing.
 *
 *   node scripts/files-ui.mjs [--folder <path>] [--port 21082]
 *   open http://127.0.0.1:<port>/scripts/files-check.html?theme=dark
 */

const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const folder = resolve(option("--folder") ?? process.cwd())
const port = Number(option("--port") ?? (process.env.MAKO_THREAD_PORT ? Number(process.env.MAKO_THREAD_PORT) + 2 : 5174))

let index
const root = resolve(import.meta.dirname, "..")
const server = await createServer({
  server: { host: "127.0.0.1", port, strictPort: true },
  // The host's own packages from source, as tsx reads them, so the page answers with this checkout's code.
  resolve: { alias: [{ find: /^@mako\/(git|protocol|sessions)$/, replacement: `${root}/packages/$1/src/index.ts` }] },
  plugins: [{
    name: "mako-files-check",
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (!request.url?.startsWith("/__files/") || request.method !== "POST") return next()
        const method = request.url.slice("/__files/".length)
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]")
        try {
          if (!index) {
            const [{ Git }, { FolderIndex }, { WorkspaceGit }] = await Promise.all([
              vite.ssrLoadModule("/packages/git/src/index.ts"),
              vite.ssrLoadModule("/packages/host/src/workspaces/file-index.ts"),
              vite.ssrLoadModule("/packages/host/src/git/workspace-git.ts"),
            ])
            const git = new Git()
            const workspaceGit = new WorkspaceGit(git, folder)
            index = new FolderIndex({ folder, git, changed: () => workspaceGit.status() })
            index.feed(true)
          }
          const answer = await (async () => {
            if (method === "folder") return { folder, name: basename(folder) }
            if (method === "folders") return index.folders(args[0], args[1] ?? undefined)
            if (method === "find") return index.find(args[0], args[1] ?? undefined)
            if (method === "grep") return index.grep(args[0], args[1] ?? undefined)
            if (method === "list") return index.list()
            if (method === "read") {
              const path = isAbsolute(args[0]) ? args[0] : join(folder, args[0])
              const info = await stat(path)
              const bytes = await readFile(path)
              const binary = bytes.subarray(0, 8000).includes(0)
              return { path: args[0], contents: binary ? "" : bytes.subarray(0, 2_000_000).toString("utf8"), size: info.size, binary, truncated: info.size > 2_000_000 }
            }
            throw new Error(`no ${method}`)
          })()
          response.setHeader("content-type", "application/json")
          response.end(JSON.stringify(answer))
        } catch (error) {
          response.statusCode = 500
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      })
    },
  }],
})
await server.listen()
console.log(`Files check for ${folder}: http://127.0.0.1:${port}/scripts/files-check.html`)
