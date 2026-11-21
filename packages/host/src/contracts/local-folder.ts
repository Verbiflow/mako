/**
 * Whether a folder path names a folder on this computer's own drives, read from its text alone, so nothing is asked
 * of a network share to decide. A Windows path that starts with two slashes is a share (`\\server\share`,
 * `//server/share`, WebDAV's `\\host@SSL\dav`) or a device namespace (`\\?\…`, `\\.\…`, `\\?\UNC\…`): opening one
 * makes Windows connect to the server and offer the person's NTLM credentials, so a link or a renderer must never
 * get there. #1117's `windowsSharePath` and `windowsDevicePath` (`workspaces/project-folders.ts`) name the same paths
 * for the host's folder listing.
 */
export function windowsRemoteOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path) || /@SSL(?:@\d+)?(?:[\\/]|$)/i.test(path)
}

/**
 * A folder a `mako:` link may name: on Windows a drive-letter path (`C:\work`), with no second colon (an alternate
 * data stream) and no control character; elsewhere an absolute path that isn't `//`. A mapped network drive still
 * passes: the person chose its server.
 */
export function linkableLocalFolder(path: string, windows: boolean): boolean {
  if (!path || [...path].some((character) => character.charCodeAt(0) < 0x20)) return false
  if (windows) return /^[A-Za-z]:[\\/]/.test(path) && !path.slice(2).includes(":") && !windowsRemoteOrDevicePath(path)
  return path.startsWith("/") && !path.startsWith("//")
}
