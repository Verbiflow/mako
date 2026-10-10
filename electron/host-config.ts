import { basename, resolve } from "node:path"
import { devHostBuild } from "@mako/host/application"
import { hostEnvironment, type HostEnvironment } from "@mako/host/base/host-environment"

/** What a host is started with: where it keeps its data, where clients reach it, and what it may launch. */
export interface HostConfig {
  /**
   * One data directory per instance. The host's lock is per data directory
   * (`@mako/host/base/host-lock`), so a source checkout that shared the installed app's
   * directory could never run beside it — and developing Mako from inside
   * Mako needs exactly that: the desk you work in stays up while the build
   * under test comes and goes. Dev defaults to its own profile; `MAKO_PROFILE`
   * names any other, for a second checkout or a throwaway test instance.
   */
  environment: HostEnvironment
  /** Every client reaches the host here: the desktop, the agent views app, browsers through the gateway. */
  socket: string
  /** What `hostCommand` starts this host with again: Mako's Electron executable, or plain Node. */
  executable: string
  /**
   * Electron, which runs the agent views app. A host under plain Node, such as
   * on a cloud machine, has none: agents there get no Mako windows of its own.
   */
  desktopExecutable: string | undefined
  /**
   * A fixture desk host serves agents a look at the interface. It keeps its own
   * profile and refuses every host call outside the fixture allowlist, from
   * every client, for its whole life.
   */
  fixtureDesk: boolean
  /** The host's compiled files: its children's scripts, and the build a development host watches. */
  buildDirectory: string
  /** A development host's compiled build, by content, and the renderer it was started for. */
  development: { build: string; devServerUrl: string | null } | undefined
}

/** The host this process was started as, or why it can't be one. */
export function processHostConfig(buildDirectory: string, env: NodeJS.ProcessEnv = process.env): HostConfig | { refused: string; code: number } {
  const environment = hostEnvironment()
  const socket = env.MAKO_WEB_SOCKET
  if (!socket) return { refused: "The Mako host needs MAKO_WEB_SOCKET, the socket its clients reach it on; start it with `ensureRuntime`", code: 64 }
  const fixtureDesk = env.MAKO_FIXTURE_DESK === "1"
  if (fixtureDesk && !/(^|-)fixture-/.test(basename(environment.dataRoot)))
    return { refused: "A fixture desk host needs a fixture profile of its own", code: 78 }
  const executable = env.MAKO_HOST_EXECUTABLE ?? process.execPath
  return {
    environment,
    socket,
    executable,
    desktopExecutable: process.versions.electron ? executable : undefined,
    fixtureDesk,
    buildDirectory,
    development: environment.development
      ? { build: devHostBuild(environment.appRoot), devServerUrl: env.VITE_DEV_SERVER_URL ?? null }
      : undefined,
  }
}

/** How another host's refusal names this one. */
export function hostLabel({ environment }: HostConfig): string {
  if (environment.profile) return `Mako's ${environment.profile} host`
  if (resolve(environment.dataRoot) !== resolve(environment.defaultDataRoot))
    return `another Mako host (${basename(environment.dataRoot)})`
  return environment.packaged ? "the installed Mako app" : "Mako's default host"
}
