/**
 * Version strings the way CLIs print them, compared the way a person would:
 * `@mako/sessions/runtime-version`, so the record store's restore, the
 * host's continuation plan and the window's rows all order versions with
 * one function.
 */
export { compareVersions, namesBuild, parseVersion, versionBehind } from "@mako/sessions/runtime-version"
