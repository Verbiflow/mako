/**
 * The journal writer's worker on a thread that takes seconds to start, as one does on a machine whose cores are all
 * taken: `test-journal-writer` gives it to a `JournalWriter`.
 */
await new Promise((resolve) => setTimeout(resolve, 3_000))
await import("@mako/host/conversations/journal-writer-worker")
