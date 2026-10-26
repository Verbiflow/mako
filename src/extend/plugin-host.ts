import { transform } from "sucrase"
import * as React from "react"
import {
  registerCommand,
  registerCommands,
  runCommand,
  type DeskCommand,
} from "@/extend/commands"
import {
  registerSlot,
  registerToolView,
  type SlotMap,
  type SlotName,
  type ToolView,
} from "@/extend/slots"
import { registerSurface, type SurfaceDefinition } from "@/extend/surfaces"
import { stage } from "@/state/stage"
import { actions, store, useSession } from "@/state/session"
import { threads, threadsStore, useThreads } from "@/state/threads"
import { toast } from "sonner"
import { prefsStore, setPref, togglePref, usePrefs } from "@/state/prefs"
import { Registry } from "@/extend/registry"

/**
 * The plugin host.
 *
 * Mako is meant to be modifiable by the agent running inside it, and the
 * obvious way to do that — edit the source and let the bundler hot-replace it —
 * only works in development. A shipped app has no source tree and no dev
 * server, so that path offers the user a change they could never see.
 *
 * This is the path that works in both. A plugin is one `.tsx` file. It is
 * transpiled in-process, evaluated as a module, and calls the same registration
 * API that everything Mako ships already uses. Because those registries are
 * versioned and React reads them through `useSyncExternalStore`, a registration
 * repaints the surfaces that consume it **immediately** — no reload, no lost
 * session, no lost scroll position, in a packaged build exactly as in a dev
 * one.
 *
 * Three deliberate limits:
 *
 *   * No bundler. A plugin cannot `import` from npm; everything it may touch is
 *     handed to it as `mako`. That keeps the runtime at about a megabyte
 *     instead of fifteen, and keeps the surface something a person can read.
 *   * No type checking. Sucrase strips types rather than verifying them, which
 *     is the right trade for something re-evaluated on every save.
 *   * Every registration is disposable, and reloading a plugin disposes the
 *     previous one first. That is what makes editing a plugin feel like editing
 *     a component rather than like restarting a service.
 */

export const MAKO_UI_EXTENSION_API_VERSION = 1
const MAX_REGISTRATIONS_PER_EXTENSION = 256

/** What a plugin module is handed. Nothing else is reachable from one. */
export interface MakoApi {
  apiVersion: typeof MAKO_UI_EXTENSION_API_VERSION
  React: typeof React
  registerCommand: (command: DeskCommand) => void
  registerCommands: (list: DeskCommand[]) => void
  registerSlot: <K extends SlotName>(
    slot: K,
    render: React.ComponentType<SlotMap[K]>,
    order?: number
  ) => void
  registerToolView: (name: string, view: ToolView) => void
  registerSurface: (surface: SurfaceDefinition) => void
  /** Show, hide, or swap the stage's companion surface. */
  surfaces: {
    open: (id: string) => void
    close: () => void
    toggle: (id: string) => void
  }
  runCommand: (id: string) => void
  /** Session state: `read()` once, `use()` to subscribe from a component. */
  session: { read: typeof store.get; use: typeof useSession; actions: typeof actions }
  prefs: { read: typeof prefsStore.get; use: typeof usePrefs; set: typeof setPref; toggle: typeof togglePref }
  /** Every harness's threads — the meta-harness, scriptable. */
  threads: { read: typeof threadsStore.get; use: typeof useThreads; actions: typeof threads }
  /** Say something small without building UI for it. */
  toast: typeof toast
}

export interface LoadedPlugin {
  id: string
  source: string
  error?: string
}

interface PluginModule {
  setup?: (api: MakoApi) => void
}

export const plugins = new Registry<LoadedPlugin>()

const pluginApis = new Map<string, MakoApi>()
Object.defineProperty(globalThis, "__makoApi__", {
  configurable: true,
  value: pluginApis,
})

/** Disposers for everything a given plugin registered, so a reload can undo it. */
const disposers = new Map<string, Array<() => void>>()

function dispose(id: string) {
  for (const undo of disposers.get(id) ?? []) undo()
  disposers.delete(id)
  pluginApis.delete(id)
}

/**
 * Build the API object for one plugin.
 *
 * Every registration made through it is recorded against that plugin's id, so
 * unloading is exact: a plugin cannot leave a command behind, and a reload
 * cannot end up with two copies of the same contribution fighting over a slot.
 */
function apiFor(id: string): MakoApi {
  const undo = disposers.get(id) ?? []
  disposers.set(id, undo)
  const track = (disposer: () => void) => {
    if (undo.length >= MAX_REGISTRATIONS_PER_EXTENSION) {
      disposer()
      throw new Error(
        `A local UI extension can register at most ${MAX_REGISTRATIONS_PER_EXTENSION} contributions`
      )
    }
    undo.push(disposer)
  }

  return {
    apiVersion: MAKO_UI_EXTENSION_API_VERSION,
    React,
    registerCommand: (command) => track(registerCommand(scopeCommand(id, command))),
    registerCommands: (list) => track(registerCommands(list.map((c) => scopeCommand(id, c)))),
    registerSlot: (slot, render, order) => track(registerSlot(id, slot, render, order ?? 0)),
    registerToolView: (name, view) => track(registerToolView(name, view)),
    registerSurface: (surface) =>
      track(registerSurface({ ...surface, id: `${id}:${surface.id}` })),
    surfaces: {
      open: (surfaceId) => stage.open(`${id}:${surfaceId}`),
      close: () => stage.close(),
      toggle: (surfaceId) => stage.toggle(`${id}:${surfaceId}`),
    },
    runCommand,
    session: { read: store.get, use: useSession, actions },
    prefs: { read: prefsStore.get, use: usePrefs, set: setPref, toggle: togglePref },
    threads: { read: threadsStore.get, use: useThreads, actions: threads },
    toast,
  }
}

/** Namespaced so two plugins choosing `refresh` do not overwrite each other. */
function scopeCommand(id: string, command: DeskCommand): DeskCommand {
  return { ...command, id: `${id}:${command.id}`, section: command.section ?? "Extension" }
}

/**
 * Compile and run one plugin, replacing any previous version of it.
 *
 * Evaluated through a blob URL rather than `new Function` so the module keeps
 * real ES module semantics — top-level `export`, and a stack trace that points
 * at a URL rather than at `<anonymous>`.
 */
export async function loadPlugin(
  id: string,
  source: string,
  sourceError?: string
): Promise<LoadedPlugin> {
  dispose(id)
  if (sourceError) {
    const loaded = { id, source, error: sourceError }
    plugins.register(id, loaded)
    return loaded
  }

  let url: string | undefined
  try {
    const compiled = transform(source, {
      transforms: ["typescript", "jsx"],
      // Classic runtime, because the automatic one emits an import of
      // `react/jsx-runtime` — a bare specifier, which a blob module cannot
      // resolve. `React` is in scope instead.
      jsxRuntime: "classic",
      production: true,
      filePath: `${id}.tsx`,
    }).code

    // The plugin sees `mako` and `React` as module-scope bindings. Assigning
    // them from the global is what lets the module be plain ESM while still
    // receiving a per-plugin API object.
    const wrapped = [
      `const mako = globalThis.__makoApi__.get(${JSON.stringify(id)});`,
      `const React = mako.React;`,
      compiled,
    ].join("\n")

    const api = apiFor(id)
    pluginApis.set(id, api)

    url = URL.createObjectURL(new Blob([wrapped], { type: "text/javascript" }))
    const module: PluginModule = await import(/* @vite-ignore */ url)

    // `setup` is optional: a plugin may do its registration at module top
    // level. Both are legitimate, and neither needs explaining to someone
    // writing their first one.
    module.setup?.(api)

    const loaded = { id, source }
    plugins.register(id, loaded)
    return loaded
  } catch (error) {
    // A broken plugin must not take the window with it. It is recorded with
    // its error so the UI can say which one failed and why.
    dispose(id)
    const loaded = { id, source, error: error instanceof Error ? error.message : String(error) }
    plugins.register(id, loaded)
    return loaded
  } finally {
    // The module is resolved by now; the URL only kept it reachable long
    // enough to import.
    if (url) URL.revokeObjectURL(url)
  }
}

export function unloadPlugin(id: string) {
  dispose(id)
  plugins.register(id, { id, source: "" })
}
