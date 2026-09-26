/** Native executables cannot run from Electron's virtual archive; packaging unpacks them beside it. */
export function unpackedPath(path: string): string {
  return path.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2")
}
