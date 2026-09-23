import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { resolveExecutable } from "../../executable.js"
import type { ProviderUpdateSource, RuntimeRelease } from "../update-source.js"
import { isOpenCodeV2 } from "./version.js"
import { openCodeExecutable } from "./installation.js"

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
    throw new Error("Mako supports OpenCode v2 only. Install a v2 release to continue.")
  const prerelease = version.match(/^0\.0\.0-(beta|next|dev)-\d+$/)?.[1]
  const native = [binary, real].some((path) => path.includes("/.opencode/bin/"))
  const label = `OpenCode 2${prerelease ? ` · ${prerelease}` : ""}`
  const selected = openCodeExecutable(env)
  const primary = Boolean(
    selected && sameOpenCodeBinary(openCodeBinaryTarget(selected), binary)
  )
  const description = primary
    ? "Used for new sessions"
    : "Additional installation"
  // The v2 prerelease installer publishes to its own repository.
  // Package-manager installations must compare against their own package tag.
  return {
    label,
    description,
    pinVersion: true,
    primary,
    npmPackage: "@opencode-ai/cli",
    npmTag: prerelease ?? "latest",
    githubRelease:
      native
        ? `anomalyco/${prerelease ? "opencode-beta" : "opencode"}`
        : undefined,
    acceptsLatest: (_installed, latest) =>
      isOpenCodeV2(latest) &&
      (prerelease
        ? latest.startsWith(`0.0.0-${prerelease}-`)
        : !latest.includes("-")),
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
  binary: (env) => openCodeUpdateBinary("opencode", env),
  supportsVersion: isOpenCodeV2,
  release: openCodeRelease,
  installations: [
    {
      id: "opencode2",
      label: "OpenCode 2",
      binary: (env) => {
        const binary = openCodeUpdateBinary("opencode2", env)
        const other = openCodeUpdateBinary("opencode", env)
        return binary && other && realpathSync(binary) === realpathSync(other)
          ? null
          : binary
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
