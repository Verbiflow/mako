import { existsSync } from "node:fs"
import { hostPlatform } from "../../base/platform.js"
import type { HarnessUpdateCommand } from "../../contracts/harness-updates.js"
import { builds } from "./builds.js"

/** Google's build for this machine, as its manifests and `builds` name it; none for a platform it doesn't build for. */
export function antigravityTarget(): keyof typeof builds | undefined {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined
  const platform = hostPlatform()
  if (!arch || platform === "other") return undefined
  if (platform === "win32") return `windows_${arch}`
  if (platform === "darwin") return `darwin_${arch}`
  return existsSync(`/lib/libc.musl-${arch === "amd64" ? "x86_64" : "aarch64"}.so.1`) ? `linux_${arch}_musl` : `linux_${arch}`
}

/** Google's installer follows latest. Install the release that Mako verified, checking Google's digest before replacing agy. */
export function antigravityInstall(): HarnessUpdateCommand | undefined {
  const target = antigravityTarget()
  if (!target) return undefined
  const { url, sha512 } = builds[target]
  const label = "Install Antigravity"
  if (target.startsWith("windows_")) {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$dir = Join-Path $HOME '.local/bin'",
      "New-Item -Force -ItemType Directory $dir | Out-Null",
      "$tmp = Join-Path $dir ([guid]::NewGuid().ToString() + '.exe')",
      `try { curl.exe --fail --location ${url} --output $tmp; if ($LASTEXITCODE -ne 0 -or (Get-FileHash $tmp -Algorithm SHA512).Hash -ne '${sha512}') { throw 'Antigravity download failed verification' }; Move-Item -Force $tmp (Join-Path $dir 'agy.exe') } finally { Remove-Item -ErrorAction SilentlyContinue $tmp }`,
    ].join("\n")
    return { label, command: "powershell.exe", args: ["-NoProfile", "-Command", command] }
  }
  const verify = target.startsWith("darwin_") ? "shasum -a 512 -c -" : "sha512sum -c -"
  const command = [
    'dir="$HOME/.local/bin"', 'mkdir -p "$dir"', 'stage=$(mktemp -d "$dir/.agy.XXXXXXXX")',
    'trap \'rm -rf "$stage"\' EXIT', 'cd "$stage"', `curl -fsSL ${url} -o release`,
    `echo '${sha512}  release' | ${verify}`, 'tar -xzf release antigravity', 'chmod 755 antigravity', 'mv -f antigravity "$dir/agy"',
  ].join("\n")
  return { label, command: "/bin/bash", args: ["-eu", "-o", "pipefail", "-c", command] }
}
