import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { writeMachineCaptureExtension } from "@mako/control-runtime/desktop"
import { hostWarn } from "../base/host-log.js"

/**
 * The capture page `scripts/build-machine-capture.mjs` builds beside this module's compiled form; run from source, the
 * build's own output.
 */
const CAPTURE_PAGE = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../dist/control/machine-capture.page.mjs" : "./machine-capture.page.mjs", import.meta.url))

/**
 * The machine browser's capture extension, written into `dataRoot` before each launch from the page this host was
 * built with. None when the build has no page (a checkout whose control runtime wasn't built), so a tab's live video
 * comes from its screencast there.
 */
export function machineCaptureExtension(dataRoot: string): () => Promise<{ directory: string; id: string } | undefined> {
  return async () => {
    if (!existsSync(CAPTURE_PAGE)) {
      hostWarn("browser", "the machine browser's capture page isn't built; its tabs' live video uses their screencast", { page: CAPTURE_PAGE })
      return undefined
    }
    return writeMachineCaptureExtension(join(dataRoot, "machine-browser-capture"), await readFile(CAPTURE_PAGE, "utf8"))
  }
}
