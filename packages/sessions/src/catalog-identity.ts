import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const RuntimePackage = z.object({
  name: z.string().optional(), version: z.string().optional(), type: z.string().optional(),
  main: z.string().optional(), module: z.string().optional(),
  exports: z.unknown().optional(), imports: z.unknown().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
})

/** Hash the shipped reader implementation, not its installation location. */
export async function catalogCodeIdentity(
  directory = fileURLToPath(new URL("./", import.meta.url))
): Promise<string> {
  const hash = createHash("sha256")
  async function readDirectory(root: string, relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(relative, entry.name)
      if (entry.isSymbolicLink()) throw new Error("Catalog reader identity requires regular packaged files")
      if (entry.isDirectory()) await readDirectory(root, path)
      else if (entry.isFile() && /\.(js|cjs|json|node)$/.test(entry.name)) {
        hash.update(JSON.stringify(path))
        const bytes = await readFile(join(root, path))
        hash.update(createHash("sha256").update(entry.name === "package.json"
          ? JSON.stringify(RuntimePackage.parse(JSON.parse(bytes.toString("utf8"))))
          : bytes).digest())
      }
    }
  }
  await readDirectory(directory, "")
  hash.update(JSON.stringify(RuntimePackage.parse(JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ))))
  // Electron packaging strips scripts/keywords. They do not affect the reader;
  // runtime entry points and the actual dependency code do.
  hash.update("zod")
  await readDirectory(dirname(fileURLToPath(import.meta.resolve("zod/package.json"))), "")
  return hash.digest("hex")
}

export interface CatalogSharingScope {
  code: string
  archivePath: string
  providers: Array<{ harness: string; roots: string[] }>
}

/** A private, scope-specific endpoint and cache for hosts with login sync off. */
export function onDemandCatalogPaths(identity: string) {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw new Error("Invalid catalog identity")
  const root = join(homedir(), ".mako", "catalogs", identity.slice(0, 24))
  return {
    socket: process.platform === "win32"
      ? `\\\\.\\pipe\\mako-catalog-${identity}`
      : join(root, "reader.sock"),
    cache: join(root, "metadata.json"),
  }
}

/** Equal code still must not mix account roots, archives or native runtimes. */
export function catalogSharingIdentity(scope: CatalogSharingScope): string {
  return createHash("sha256").update(JSON.stringify({
    code: scope.code,
    runtime: [process.platform, process.arch, process.versions.node],
    archive: resolve(scope.archivePath),
    providers: scope.providers.map(provider => ({
      harness: provider.harness,
      roots: [...new Set(provider.roots.map(root => resolve(root)))].sort(),
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })).digest("hex")
}
