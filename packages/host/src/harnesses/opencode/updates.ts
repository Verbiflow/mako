import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { resolveExecutable } from "../../base/executable.js"
import {
  npmInstall,
  type ProviderUpdateSource,
  type RuntimeRelease,
} from "../update-source.js"
import { isOpenCodeV2 } from "./version.js"
import { openCodeExecutable } from "./installation.js"

/**
 * The newest OpenCode release Mako is verified against: the version of its
 * `@opencode/client`, published with that server. Installs and updates go
 * here. A newer release someone already runs is kept, since an update never
 * moves back, and run: from `OPENCODE_OLDEST` on, OpenCode's API has only
 * grown. `scripts/test-opencode-updates.ts` holds the two versions equal.
 */
export const OPENCODE_RELEASE = "2.0.27"

export function openCodeUpdateBinary(
  name: "opencode" | "opencode2",
  env: NodeJS.ProcessEnv
): string | null {
  const configured = env.OPENCODE_BIN_PATH
  const override =
    configured &&
    basename(configured).startsWith("opencode2") === (name === "opencode2")
      ? configured
      : name === "opencode2"
        ? env.OPENCODE2_BIN_PATH
        : undefined
  const binary = resolveExecutable(override ?? name, env)
  return binary ? openCodeBinaryTarget(binary) : null
}

export function openCodeRelease(
  version: string,
  binary: string,
  real: string,
  env: NodeJS.ProcessEnv = process.env
): RuntimeRelease {
  if (!isOpenCodeV2(version))
    throw new Error(`OpenCode ${version} is not an OpenCode 2 release.`)
  const prerelease = version.match(/^0\.0\.0-(beta|dev)-\d+$/)?.[1]
  const native = [binary, real].some((path) => path.includes("/.opencode/bin/"))
  const label = `OpenCode 2${prerelease ? ` · ${prerelease}` : ""}`
  const selected = openCodeExecutable(env)
  const primary = Boolean(
    selected && sameOpenCodeBinary(openCodeBinaryTarget(selected), binary)
  )
  const description = primary
    ? "Used for new sessions"
    : "Additional installation"
  // A stable install, native or npm, goes to the release Mako is verified
  // against. A prerelease someone chose follows its own feed: the native beta
  // installer's repository, or its npm tag.
  return {
    label,
    description,
    pinVersion: true,
    primary,
    npmPackage: "@opencode/cli",
    npmTag: prerelease ?? OPENCODE_RELEASE,
    githubRelease: native && prerelease ? "anomalyco/opencode-beta" : undefined,
    acceptsLatest: (_installed, latest) =>
      prerelease
        ? isOpenCodeV2(latest) && latest.startsWith(`0.0.0-${prerelease}-`)
        : latest === OPENCODE_RELEASE,
    // Pin the verified version. An update must not silently migrate generations.
    native: {
      label: "Update",
      args: ["upgrade"],
      ownsPath: (path) => path.includes("/.opencode/bin/"),
      pinVersion: true,
    },
    // Homebrew owns its formula migrations; do not apply an unverified generation change.
    homebrew: undefined,
  }
}

export const openCodeUpdateSource: ProviderUpdateSource = {
  provider: "opencode",
  // `@opencode/cli` links both names; the retired prerelease package
  // `@opencode-ai/cli` linked only `opencode2`, which is then the one
  // sessions run.
  binary: (env) =>
    openCodeUpdateBinary("opencode", env) ??
    openCodeUpdateBinary("opencode2", env),
  supportsVersion: isOpenCodeV2,
  release: openCodeRelease,
  install: [npmInstall("@opencode/cli", OPENCODE_RELEASE)],
  installations: [
    {
      id: "opencode2",
      label: "OpenCode 2",
      binary: (env) => {
        const binary = openCodeUpdateBinary("opencode2", env)
        const other = openCodeUpdateBinary("opencode", env)
        return binary && other && realpathSync(binary) !== realpathSync(other)
          ? binary
          : null
      },
      supportsVersion: isOpenCodeV2,
      release: openCodeRelease,
    },
  ],
}

/** Only unwrap the known, argument-preserving sibling shim. Never evaluate shell code,
 * infer identity from equal versions, or discard wrappers that change the environment.
 */
export function openCodeBinaryTarget(binary: string): string {
  const real = realpathSync(binary)
  if (statSync(real).size > 512) return binary
  const fd = openSync(real, "r")
  let script: string
  try {
    const bytes = Buffer.alloc(512)
    script = bytes
      .subarray(0, readSync(fd, bytes, 0, bytes.length, 0))
      .toString("utf8")
  } finally {
    closeSync(fd)
  }
  if (
    /^#!\/bin\/sh\r?\nexec "\$\(dirname "\$0"\)\/opencode" "\$@"\r?\n?$/.test(
      script
    )
  ) {
    const target = resolveExecutable(join(dirname(binary), "opencode"))
    if (target) return target
  }
  return binary
}

function sameOpenCodeBinary(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return left === right
  }
}
