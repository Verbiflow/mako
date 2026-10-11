/** OpenCode v2 used these prerelease versions before adopting 2.x. */
export function isOpenCodeV2(version: string): boolean {
  return /^(?:opencode2?\s+)?v?(?:2\.\d+\.\d+(?:[-+][\w.-]+)?|0\.0\.0-(?:beta|next|dev)-\d+)$/i.test(version.trim())
}
