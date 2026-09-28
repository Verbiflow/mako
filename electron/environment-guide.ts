import { RECIPE_PATH } from "./thread-recipe.js"

/** What starts a setup Session; the guide itself comes from `environment_guide`, so it's the same for every agent. */
export const ENVIRONMENT_SETUP_PROMPT = `Set this project up so every Thread can run and check its own copy of the app at the same time as the others. Call the environment_guide tool first and follow it.`

/**
 * How an agent sets up, or repairs, a project's recipe. Served by the
 * `environment_guide` tool.
 */
export const ENVIRONMENT_GUIDE = `# Setting up this project's recipe

Mako runs many agents at once, each in its own Thread, usually on its own branch in its own checkout (a Git worktree). Your job: make every Thread able to start this project's app and pass its checks side by side with the others, with the least change to the project. You write one small file, ${RECIPE_PATH}, committed with the project. After that, every Thread uses it automatically.

## What each Thread already has

- Ten ports of its own: MAKO_THREAD_PORT is the first, MAKO_THREAD_PORTS says how many.
- A hostname of its own, such as fix-login.thread.localhost, with its own cookies. MAKO_THREAD_URL is http://<host>:<first port>.
- A private data folder outside the checkout: MAKO_THREAD_DATA_DIR.
- The environment_* tools. Mako runs the recipe's processes outside your shell, so they survive your turn and a Mako restart, and it stops their whole process tree.

## 0. Is there a recipe already?

Call environment_status first.

- If the recipe is ready, prove it (step 5). If the proof passes, you're done: say so and stop. Don't rewrite a recipe that works.
- If it's broken or fails the proof, repair it. Keep what works, and change only what's wrong.

## 1. Learn how the project runs from what it already has

Read in this order, and stop once you know the install, start and check commands:

1. A recipe for another tool: .conductor/, conductor.json, .capy/setup.json, replicas.json, .hoplite/settings.json, .cursor/environment.json, .devcontainer/, compose files, a Procfile. Start from its commands.
2. CI configuration, such as .github/workflows. It runs from a clean machine, so its install and test steps are the real ones.
3. README, CONTRIBUTING and AGENTS.md; package scripts, Makefile, justfile.

## 2. Find what two copies would fight over

Search the code. Don't guess.

- Fixed ports: listen( calls, port: settings, numbers like 3000, 5173 and 8080.
- Fixed places for data: app data folders, profiles, SQLite files, ~/Library/Application Support/<app>, ~/.config/<app>, caches, sockets, lock and pid files, single-instance locks.
- Outside services: databases, queues, email, payments, OAuth, production APIs. For each, how does a developer's copy reach it today?

## 3. Fix each collision on the lowest rung

Note which rung each fix used.

1. Wrap: map Mako's values to names the app already reads, in "values", such as PORT, DATABASE_URL, or a data-folder or profile variable.
2. Configure: pass the app's own flags in the command, such as --port {port}.
3. A small change to the project, only when the app can't take a port or folder from outside. Keep today's behavior as the default, so nothing changes for anyone not using Mako, for example \`port: Number(process.env.PORT) || 5173\`. Say what the change buys.
4. Take turns: when nothing else works, leave that one thing shared and say so plainly.

## 4. Write ${RECIPE_PATH}

\`\`\`json
{
  "values": { "PORT": "{port}", "APP_URL": "{url}", "API_URL": "http://{host}:{port+1}" },
  "processes": {
    "web": { "command": "npm run dev", "port": "{port}" },
    "api": { "command": "npm run api", "port": "{port+1}", "cwd": "server", "values": { "HOME": "{data}/home" } }
  },
  "checks": { "quick": "npm run typecheck && npm test", "full": "npm run e2e" },
  "prepare": [{ "command": "npm ci", "inputs": ["package-lock.json"] }]
}
\`\`\`

The fields:

- values: names the app reads. Mako sets them in every agent's shell and in every process.
  - The placeholders are {port}, {port+N} (N up to 9), {host}, {url}, {data} and {thread}.
  - PATH, HOME, SHELL, USER, TMPDIR and PWD can't be set here, because the agent's own shell needs them.
  - MAKO_THREAD_* and MAKO_CONTROL_* are Mako's own. The project's own MAKO_ names are fine.
- processes: what runs the app, as the project's own commands.
  - "port" is {port} or {port+N}. The process counts as running once that port answers.
  - A fixed port is refused.
  - A process can set its own values, including HOME, TMPDIR or XDG_* for an app with no data-folder setting.
- checks.quick: no running app, such as typecheck, lint and unit tests.
- checks.full: runs against the running app, such as end-to-end tests. Mako starts the app first.
- prepare: install in a fresh copy, and catch up after the branch moves. Each step runs again only when one of its inputs changes. Only add it if a fresh checkout can't start without it.

Keep it small, and name the project's own scripts. Add a script to the project only when none exists. Nothing Mako-specific goes inside a command, so every command still works without Mako.

## 5. Prove it with the tools, not by hand

Never run the app with & or nohup in your own shell. Use the tools, so it stays this Thread's.

1. Call environment_status: the recipe is ready, and the values resolved as you meant.
2. Call environment_start: every process is running on its port. If one isn't, call environment_logs, fix the cause, and try again.
3. Fetch the app at MAKO_THREAD_URL, or at 127.0.0.1 on its port, and check that it's this copy answering, such as the page title or a health endpoint.
4. Show it keeps out of the way:
   - With environment_port, the project's usual port (3000, 5173, ...) isn't held by your copy.
   - Nothing was written to the usual data folder or profile.
5. Call environment_check "quick", then environment_check "full" if the recipe has one.
6. Call environment_stop. Afterwards, nothing of this Thread's is still listening.

## 6. Outside services

Give each service its mode in one plain sentence: its own copy per Thread, shared, or read-only.

- Sharing is a fine answer when the project wants it.
- When a service is shared, write the one rule agents follow, such as "only touch rows you created".
- Ask the user only when your choice changes where real data goes, for example agents writing to a production database today.

## 7. Stop and ask

Ask before any of these:

- A secret: never read .env values; name the variable you need, and the user supplies it.
- A paid service.
- A change bigger than a small one.
- sudo, or installing anything globally.

Never write to production data, delete data, or stop a process you didn't start.

## 8. Finish

1. Commit the recipe, and any small change, on this Thread's branch.
2. Tell the user in plain sentences:
   - what every Thread now gets;
   - what stays shared, and the rule for it;
   - each change to the project, and what it buys;
   - the proof: the processes that ran, their ports, and the check results.
3. Offer to merge or open a pull request; the user decides.

If something needs human eyes, such as a sign-in flow you can't complete or a visual change, you may ask the user to try it on the running app. That's optional, never a gate.
`
