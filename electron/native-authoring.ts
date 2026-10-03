import { z } from "zod"
import { resolve } from "node:path"
import { NativeAuthoringFamilySchema, type NativeAuthoringCatalog, type NativeAuthoringTarget, type NativeAuthoringWrite, type NativeAuthoringRemove } from "./contracts/native-authoring.js"
import { providerHost } from "./providers/index.js"

const Target = z.object({ provider: z.string().min(1), family: NativeAuthoringFamilySchema, cwd: z.string().min(1) })
const Write = Target.extend({ id: z.string().min(1), contents: z.string().max(256 * 1024), revision: z.string().regex(/^[a-f0-9]{64}$/).nullable() })
const Remove = Target.extend({ id: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{64}$/) })

function capability(cwd: string, target: NativeAuthoringTarget) {
  const parsed = Target.parse(target)
  if (resolve(parsed.cwd) !== resolve(cwd)) throw new Error("The project changed after opening this editor. Reopen it in the intended project.")
  const implementation = providerHost[parsed.family].get(parsed.provider)
  if (!implementation) {
    const reason = providerHost.harnesses.get(parsed.provider)?.absent[parsed.family]?.reason
    throw new Error(reason ?? "Native authoring is unavailable for this agent.")
  }
  return implementation
}

export function nativeAuthoringCatalog(cwd: string): NativeAuthoringCatalog {
  return { cwd, capabilities: providerHost.harnesses.list().flatMap((harness) => NativeAuthoringFamilySchema.options.map((family) => {
    const implementation = providerHost[family].get(harness.provider)
    return { provider: harness.provider, family, label: providerHost.profiles.get(harness.provider)?.label ?? harness.provider,
      supported: implementation !== undefined, detail: implementation?.detail ?? harness.absent[family]?.reason ?? "Unavailable" }
  })) }
}
export const listNativeAuthoring = (cwd: string, target: NativeAuthoringTarget) => capability(cwd, target).list(cwd)
export const readNativeAuthoring = (cwd: string, target: NativeAuthoringTarget, id: string) => capability(cwd, target).read(cwd, id)
export function writeNativeAuthoring(cwd: string, input: NativeAuthoringWrite) {
  const value = Write.parse(input)
  return capability(cwd, value).write(cwd, value.id, value.contents, value.revision)
}
export function removeNativeAuthoring(cwd: string, input: NativeAuthoringRemove) {
  const value = Remove.parse(input)
  return capability(cwd, value).remove(cwd, value.id, value.revision)
}
