import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import {
  MAX_UI_EXTENSIONS,
  MAX_UI_EXTENSION_BYTES,
  uiExtensionName,
  validateUiExtensionWrite,
} from "./plugin-policy.js"

/**
 * Where plugins live on disk.
 *
 * `userData`, not the app bundle. A packaged app's resources are read-only and
 * on macOS are inside a signed bundle — writing there would either fail or
 * break the signature. userData is writable in every build, which is the whole
 * point: the agent must be able to change this app after it ships, not only
 * when it is running from a checkout.
 */
export function pluginsDir(dataRoot: string): string {
  return join(dataRoot, "plugins")
}

export interface PluginFile {
  id: string
  source: string
  error?: string
}

/** Read every plugin, newest-name-first order being irrelevant here. */
export async function listPlugins(dir: string): Promise<PluginFile[]> {
  await mkdir(dir, { recursive: true })
  const names = (await readdir(dir))
    .filter((name) => /\.(tsx|ts|jsx|js)$/.test(name))
    .sort()
    .slice(0, MAX_UI_EXTENSIONS)

  const files = await Promise.all(
    names.map(async (name): Promise<PluginFile | null> => {
      const id = name.replace(/\.\w+$/, "")
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (info.size > MAX_UI_EXTENSION_BYTES) {
          return {
            id,
            source: `// ${name} exceeds Mako's local UI extension size limit.`,
            error: `Extension is larger than ${MAX_UI_EXTENSION_BYTES / 1024} KB`,
          }
        }
        return { id, source: await readFile(path, "utf8") }
      } catch {
        return null
      }
    })
  )
  return files.filter((file): file is PluginFile => file !== null)
}

export async function writePlugin(dir: string, id: string, source: string) {
  await mkdir(dir, { recursive: true })
  const entries = (await readdir(dir)).filter((entry) =>
    /\.(tsx|ts|jsx|js)$/.test(entry)
  )
  const name = validateUiExtensionWrite(
    id,
    source,
    entries.map((entry) => entry.replace(/\.\w+$/, ""))
  )
  // The id is a bare name, never a path: a plugin called `../../etc/passwd`
  // must land in the plugins directory as a strange filename, not outside it.
  await writeFile(join(dir, `${name}.tsx`), source, "utf8")
}

export async function deletePlugin(dir: string, id: string) {
  await rm(join(dir, `${uiExtensionName(id)}.tsx`), { force: true })
  // Other extensions the same plugin might have been saved under.
  for (const extension of ["ts", "jsx", "js"]) {
    await rm(join(dir, `${uiExtensionName(id)}.${extension}`), { force: true })
  }
}

/**
 * Watch for changes and report which plugin changed.
 *
 * This is what closes the loop: the agent writes a file with its ordinary
 * `write` tool — it needs to know nothing about Mako's IPC — and the window
 * re-evaluates that plugin a moment later. Debounced because an editor or an
 * agent writing a file commonly produces several events for one save.
 */
export interface PluginWatch {
  readonly ready: Promise<void>
  close(): Promise<void>
}

/** Composition supplies the existing watcher child; tools neither start a process nor own native handles. */
export type PluginWatchPort = (dir: string, changed: () => void) => Promise<{ unsubscribe(): Promise<void> }>

export function watchPlugins(dir: string, onChange: () => void, watch: PluginWatchPort): PluginWatch {
  let closed = false
  let timer: NodeJS.Timeout | undefined
  let subscription: Awaited<ReturnType<PluginWatchPort>> | undefined
  let releasing: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const release = () => releasing ??= subscription?.unsubscribe() ?? Promise.resolve()
  const changed = () => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(() => { if (!closed) onChange() }, 80)
  }
  const ready = (async () => {
    await mkdir(dir, { recursive: true })
    if (closed) return
    subscription = await watch(dir, changed)
    if (closed) await release()
  })()
  return {
    ready,
    close() {
      closed = true
      clearTimeout(timer)
      return closing ??= ready.then(release, (error) => { if (subscription) throw error })
    },
  }
}
