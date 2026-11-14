import { AsyncLocalStorage } from "node:async_hooks"
import { fork as nodeFork } from "node:child_process"

type SessionProcesses = { fork: typeof nodeFork }
const contexts = new AsyncLocalStorage<SessionProcesses>()
/** Standalone catalog workers keep their own decoder lifetime; hosts inject their stop scope. */
const standalone: SessionProcesses = { fork: nodeFork }

export function withSessionProcesses<T>(runner: SessionProcesses, operation: () => T): T { return contexts.run(runner, operation) }
// SAFETY: all arguments and the original child pass through to the selected runner, preserving every fork overload.
const fork = ((...args: Parameters<typeof nodeFork>) => (contexts.getStore() ?? standalone).fork(...args)) as typeof nodeFork
export { fork }
