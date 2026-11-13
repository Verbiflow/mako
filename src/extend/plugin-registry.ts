import { Registry } from "@/extend/registry"

/**
 * The plugins a window has loaded, apart from the runtime that loads them (`plugin-host.ts`, with
 * its compiler): what Settings lists and what a sync compares against, readable without loading it.
 */
export interface LoadedPlugin {
  id: string
  source: string
  error?: string
}

export const plugins = new Registry<LoadedPlugin>()
