/**
 * What starts a task's Local Control session, apart from what runs one (`./session`): the launch's folder, its
 * listening socket and the workers' pool. A host starts a session for every agent it launches, and loads the rest at
 * the session's first use.
 */
export * from "./desktop-session.js"
export * from "./control-workers.js"
