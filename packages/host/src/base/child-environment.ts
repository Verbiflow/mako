/**
 * Runtime-only values must never leak into a provider child process. The
 * host's own launch variables are included: an agent under the installed
 * app once ran `npm run dev` and, through the inherited `MAKO_DATA_ROOT`
 * and `MAKO_WEB_SOCKET`, attached its "profile" client to the installed
 * app's host instead of starting one.
 */
const MAKO_RUNTIME_ENV = [
  "MAKO_CUA_SOCKET",
  "MAKO_DATA_ROOT",
  "MAKO_PROFILE",
  "MAKO_WEB_SOCKET",
  "MAKO_HOST_EXECUTABLE",
  "MAKO_AGENT_VIEWS",
  "MAKO_CLIENT_ID",
  "VITE_DEV_SERVER_URL",
]

/** The environment a process the host starts for the person or an agent gets: the host's own, less its runtime variables. */
export function childProcessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of MAKO_RUNTIME_ENV) delete env[key]
  return env
}
