/**
 * Which Windows paths leave this computer's drives, read from a path's text alone, so nothing is asked of a network
 * share to decide. Opening a share makes Windows connect to its server and offer the person's NTLM credentials, and Git
 * there runs what the share's `.git/config` says; a device path goes past Windows's own path checks. The one rule for
 * the host's folder listing and project opening and for the desktop's `mako:` links.
 */

/** A Windows device or raw path (`\\?\`, `\\.\`, in either slash), `\\?\UNC\server\share` included. */
export const windowsDevicePath = (path: string): boolean => /^[\\/]{2}[?.][\\/]/.test(path)

/**
 * A Windows share (`\\server\share`, `//server/share`), WebDAV's forms included (`\\host@SSL\dav`,
 * `\\host@SSL@8443\dav`): reading one hands the server this user's NTLM credentials.
 */
export const windowsSharePath = (path: string): boolean => /^[\\/]{2}/.test(path) || /@SSL(?:@\d+)?(?:[\\/]|$)/i.test(path)

/** A share or a device path: never a folder Mako opens for a link or a window. */
export const windowsRemoteOrDevicePath = (path: string): boolean => windowsSharePath(path) || windowsDevicePath(path)

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
