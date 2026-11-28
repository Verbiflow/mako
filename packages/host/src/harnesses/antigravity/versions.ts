import type { HarnessVersions } from "../../contracts/harness-versions.js"
import { antigravityTarget } from "./install.js"

const MANIFESTS = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{target}.json"

/**
 * The agy builds Mako runs. Installs and Update put Google's build of `tested` in place from the files and SHA-512
 * digests `builds.ts` keeps (`antigravityInstall`), so `tested` is always the version those files are: the harness
 * definitions check holds the two to each other. Cloud machines' images install exactly `tested`.
 */
export const ANTIGRAVITY_VERSIONS: HarnessVersions = {
  tested: "1.5.15",
  oldest: "1.5.15",
  feed: { manifest: MANIFESTS.replace("{target}", antigravityTarget() ?? "darwin_arm64") },
  digests: {
    manifests: MANIFESTS,
    targets: ["darwin_arm64", "darwin_amd64", "linux_amd64", "linux_arm64", "linux_amd64_musl", "linux_arm64_musl", "windows_amd64", "windows_arm64"],
    file: "builds.ts",
  },
  checked: { on: "2026-11-23", how: "ACP handshake, model discovery, HTTP MCP and a complete Gemini-compatible test turn with agy 1.5.15." },
}
