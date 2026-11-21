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

/** The longest path a link may name: past this a dialog can't show it whole. */
export const LINKED_FOLDER_MAX_LENGTH = 1000

/**
 * Whether a path holds a character that would show as something other than what it is: a control character (C0, DEL
 * and C1), a zero-width one or a direction mark (U+200B to U+200F, U+FEFF), or a bidirectional control (U+202A to
 * U+202E, U+2066 to U+2069), which can make a dialog show a path's parts in another order.
 */
export function misleadingPathText(path: string): boolean {
  return [...path].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || code === 0xfeff || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  })
}

/**
 * A folder a `mako:` link may name: at most `LINKED_FOLDER_MAX_LENGTH` characters, none of them misleading
 * (`misleadingPathText`); on Windows a drive-letter path (`C:\work`) with no second colon (an alternate data
 * stream); elsewhere an absolute path that isn't `//`.
 */
export function linkableLocalFolder(path: string, windows: boolean): boolean {
  if (!path || path.length > LINKED_FOLDER_MAX_LENGTH || misleadingPathText(path)) return false
  if (windows) return /^[A-Za-z]:[\\/]/.test(path) && !path.slice(2).includes(":") && !windowsRemoteOrDevicePath(path)
  return path.startsWith("/") && !path.startsWith("//")
}
