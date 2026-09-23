import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { resolveExecutable } from "../../executable.js"
import type { ProviderUpdateSource, RuntimeRelease } from "../update-source.js"
import { openCodeExecutable } from "./installation.js"

/** V2 betas used 0.0.0 versions before the stable 2.x releases. */
export function openCodeVersionGeneration(
  version: string
): "v1" | "v2" | undefined {
  if (version.startsWith("1.")) return "v1"
  if (
    /^(?:[2-9]|\d{2,})\./.test(version) ||
    /^0\.0\.0-(?:beta|next|dev)-\d+$/.test(version)
  )
    return "v2"
  return undefined
}

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
        : env.OPENCODE1_BIN_PATH
  const binary = resolveExecutable(override ?? name, env)
  return binary ? openCodeBinaryTarget(binary) : null
}

export function openCodeRelease(
  version: string,
  binary: string,
  real: string,
  env: NodeJS.ProcessEnv = process.env
): RuntimeRelease {
  const generation = openCodeVersionGeneration(version)
  const prerelease = version.match(/^0\.0\.0-(beta|next|dev)-\d+$/)?.[1]
  const native = [binary, real].some((path) => path.includes("/.opencode/bin/"))
  const label =
    generation === "v2"
      ? `OpenCode 2${prerelease ? ` · ${prerelease}` : ""}`
      : generation === "v1"
        ? "OpenCode 1"
        : "OpenCode"
  const selected = openCodeExecutable(env)
  const primary = Boolean(
    selected && sameOpenCodeBinary(openCodeBinaryTarget(selected), binary)
  )
  const description = primary
    ? "Used for new sessions"
    : generation === "v1"
      ? "Available for V1 sessions"
      : "Additional installation"
  // The beta's native installer publishes to a different repository from V1.
  // Package-manager installations must compare against their own package tag.
  return {
    label,
    description,
    pinVersion: true,
    primary,
    npmPackage:
      generation === "v1"
        ? "opencode-ai"
        : generation === "v2"
          ? "@opencode-ai/cli"
          : undefined,
    npmTag: prerelease ?? "latest",
    githubRelease:
      native && generation
        ? `anomalyco/${prerelease ? "opencode-beta" : "opencode"}`
        : undefined,
    acceptsLatest: (_installed, latest) =>
      openCodeVersionGeneration(latest) === generation &&
      (prerelease
        ? latest.startsWith(`0.0.0-${prerelease}-`)
        : !latest.includes("-")),
    // Pin the verified version. An update must not silently migrate generations.
    native: generation
      ? {
          label: "Update",
          args: ["upgrade"],
          ownsPath: (path) => path.includes("/.opencode/bin/"),
          pinVersion: true,
        }
      : undefined,
    // Homebrew owns its formula migrations; do not apply an unverified generation change.
    homebrew: undefined,
  }
}

export const openCodeUpdateSource: ProviderUpdateSource = {
  provider: "opencode",
  binary: (env) => openCodeUpdateBinary("opencode", env),
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
