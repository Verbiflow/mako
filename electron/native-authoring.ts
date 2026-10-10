import { z } from "zod"
import { resolve } from "node:path"
import { NativeAuthoringFamilySchema, type NativeAuthoringCatalog, type NativeAuthoringDocument, type NativeAuthoringTarget, type NativeAuthoringWrite, type NativeAuthoringRemove } from "@mako/host/contracts/native-authoring"
import type { ToolHarnesses } from "./tool-harnesses.js"

const Target = z.object({ provider: z.string().min(1), family: NativeAuthoringFamilySchema, cwd: z.string().min(1) })
const Write = Target.extend({ id: z.string().min(1), contents: z.string().max(256 * 1024), revision: z.string().regex(/^[a-f0-9]{64}$/).nullable() })
const Remove = Target.extend({ id: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{64}$/) })

/** Each harness's own hooks and commands, edited where the harness reads them. */
export interface NativeAuthoring {
  catalog(cwd: string): NativeAuthoringCatalog
  list(cwd: string, target: NativeAuthoringTarget): Promise<{ id: string; name: string }[]>
  read(cwd: string, target: NativeAuthoringTarget, id: string): Promise<NativeAuthoringDocument>
  write(cwd: string, input: NativeAuthoringWrite): Promise<NativeAuthoringDocument>
  remove(cwd: string, input: NativeAuthoringRemove): Promise<void>
}

export function nativeAuthoring(harnesses: ToolHarnesses): NativeAuthoring {
  function capability(cwd: string, target: NativeAuthoringTarget) {
    const parsed = Target.parse(target)
    if (resolve(parsed.cwd) !== resolve(cwd)) throw new Error("The project changed after opening this editor. Reopen it in the intended project.")
    const implementation = harnesses.authoring[parsed.family].get(parsed.provider)
    if (!implementation) {
      const reason = harnesses.harnesses.get(parsed.provider)?.absent[parsed.family]?.reason
      throw new Error(reason ?? "Native authoring is unavailable for this agent.")
    }
    return implementation
  }
  return {
    catalog: (cwd) => ({ cwd, capabilities: harnesses.harnesses.list().flatMap((harness) => NativeAuthoringFamilySchema.options.map((family) => {
      const implementation = harnesses.authoring[family].get(harness.provider)
      return { provider: harness.provider, family, label: harnesses.label(harness.provider),
        supported: implementation !== undefined, detail: implementation?.detail ?? harness.absent[family]?.reason ?? "Unavailable" }
    })) }),
    list: (cwd, target) => capability(cwd, target).list(cwd),
    read: (cwd, target, id) => capability(cwd, target).read(cwd, id),
    write(cwd, input) {
      const value = Write.parse(input)
      return capability(cwd, value).write(cwd, value.id, value.contents, value.revision)
    },
    remove(cwd, input) {
      const value = Remove.parse(input)
      return capability(cwd, value).remove(cwd, value.id, value.revision)
    },
  }
}
