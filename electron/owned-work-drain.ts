/** Completion is signalled by the exact owner after its cleanup boundary. */
export function ownedWorkCompletion() {
  let resolve = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** A timeout refuses closure; it does not settle work or relinquish ownership. */
export async function drainOwnedWork(
  work: readonly Promise<void>[],
  timeoutMs: number,
  description: string
): Promise<void> {
  if (!work.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = Promise.allSettled(work).then(results => {
    const failures: Error[] = []
    for (const result of results)
      if (result.status === "rejected") failures.push(result.reason instanceof Error ? result.reason : new Error(description))
    if (failures.length) throw new AggregateError(failures, description)
  })
  try {
    await Promise.race([
      settled,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} Some owned work has not settled; ownership was retained.`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
