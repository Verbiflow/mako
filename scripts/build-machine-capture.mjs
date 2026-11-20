import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

/**
 * The machine browser's capture page (`src/live-video/machine-capture.ts`) as one module, beside the host's control
 * code that loads it into the capture extension (`packages/host/src/control/machine-video.ts`). A cloud machine's
 * Chromium runs it to encode its tabs' live video with WebCodecs. `.mjs`, so the compiler's pruning of stale `.js`
 * output leaves it alone.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const machineCaptureBuildOptions = {
  entryPoints: [join(root, "src/live-video/machine-capture.ts")],
  outfile: join(root, "packages/host/dist/control/machine-capture.page.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  // Debian bookworm's Chromium, which cloud machines run, is far newer; `toBase64` needs 140.
  target: "chrome140",
  tsconfig: join(root, "tsconfig.app.json"),
  // The page needs only the packet's wire format; the package's barrel would bring every contract's zod schemas.
  alias: { "@mako/control-runtime/contracts": join(root, "packages/control-runtime/src/contracts/control-video.ts") },
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build(machineCaptureBuildOptions)
