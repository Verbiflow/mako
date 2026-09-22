import { z } from "zod"
const manifestSchema = z.object({
  version: z.string().regex(/^\d+(?:\.\d+){0,3}$/),
})
/** Unpacked installs do not emit onUpdateAvailable when Mako replaces their files. */
export async function localExtensionUpdateAvailable(
  runtime: Pick<typeof chrome.runtime, "getURL" | "getManifest">,
  read: typeof fetch = fetch
) {
  const response = await read(runtime.getURL("manifest.json"), {
    cache: "no-store",
  })
  if (!response.ok) return false
  const available = manifestSchema
    .parse(await response.json())
    .version.split(".")
    .map(Number)
  const current = manifestSchema
    .parse(runtime.getManifest())
    .version.split(".")
    .map(Number)
  for (let index = 0; index < 4; index++) {
    const difference = (available[index] ?? 0) - (current[index] ?? 0)
    if (difference) return difference > 0
  }
  return false
}
