export function configureDevinEnvironment(env: NodeJS.ProcessEnv): void {
  delete env.ACP_BACKEND
  delete env.WINDSURF_IDE_TYPE
}

export function devinEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  configureDevinEnvironment(env)
  return env
}
