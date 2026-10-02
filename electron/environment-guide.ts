import { RECIPE_PATH } from "./thread-recipe.js"

/**
 * How an agent sets up, or repairs, a project's recipe. Served by the
 * `recipe_guide` tool.
 */
export const ENVIRONMENT_GUIDE = `# Setting up this project's recipe

Mako runs many agents at once, each in its own Thread, usually on its own branch in its own checkout (a Git worktree). Your job: make every Thread able to start this project's app and pass its checks side by side with the others, with the least change to the project. You write one small recipe and save it in Mako with recipe_save. Every Thread of this project uses it from then on, on every branch, with nothing to commit or merge.

## What each Thread already has

- Ten ports of its own: MAKO_THREAD_PORT is the first, MAKO_THREAD_PORTS says how many.
- A hostname of its own, such as fix-login.thread.localhost, with its own cookies. MAKO_THREAD_URL is http://<host>:<first port>.
- A private data folder outside the checkout: MAKO_THREAD_DATA_DIR.
- The app_* tools on Mako's mako server. Mako runs the recipe's processes outside your shell, so they survive your turn and a Mako restart, and it stops their whole process tree.

## 0. Is there a recipe already?

Call app_status first. Its recipe section says where the recipe comes from and shows what it says.

- If the recipe is ready, prove it (step 5). If the proof passes, you're done: say so and stop. Don't rewrite a recipe that works.
- If it's broken or fails the proof, repair it. Start from what it says, keep what works, change only what's wrong, and save it again.
- A recipe committed with the project (${RECIPE_PATH}) is used when Mako has none saved. Start from it; saving one in Mako puts yours first.

Changing a working recipe for a change of your own, such as a new install step, a renamed script or a new port or value, doesn't need this whole guide: take the recipe app_status shows, edit it, pass the whole of it to recipe_save, then prove it with app_restart and app_check. Do it in the same turn as the change, so the next Thread doesn't start from a stale recipe.

## 1. Learn how the project runs from what it already has

Read in this order, and stop once you know the install, start and check commands:

1. A recipe for another tool: .conductor/, conductor.json, .capy/setup.json, replicas.json, .hoplite/settings.json, .cursor/environment.json, .devcontainer/, compose files, a Procfile. Start from its commands.
2. CI configuration, such as .github/workflows. It runs from a clean machine, so its install and test steps are the real ones.
3. README, CONTRIBUTING and AGENTS.md; package scripts, Makefile, justfile.

## 2. Find what two copies would fight over

Search the code. Don't guess.

- Fixed ports: listen( calls, port: settings, numbers like 3000, 5173 and 8080. A port the system picks (port 0) never collides; leave it alone.
- Fixed places for data: app data folders, profiles, SQLite files, ~/Library/Application Support/<app>, ~/.config/<app>, caches, sockets, lock and pid files, single-instance locks.
- Docker Compose: published ports ("5432:5432") and container_name collide. Compose names everything else after its project, which defaults to the folder's name, so Threads sharing a folder share one stack.
- Outside services: databases, queues, email, payments, OAuth, production APIs. For each, how does a developer's copy reach it today?
- Credentials: which files Git ignores hold them (.env files, key files, a service's own env file), found by name and from the code, an .env.example or the README. Never open one to look. And whether the project has a way to run without them, such as a local or mock mode.

## 3. Fix each collision on the lowest rung

Note which rung each fix used.

1. Wrap: map Mako's values to names the app already reads, in "values", such as PORT, DATABASE_URL, or a data-folder or profile variable. For Compose, COMPOSE_PROJECT_NAME set to {thread}, and a published port read from a variable, such as "\${DB_PORT:-5432}:5432" with DB_PORT set to {port+2}.
2. Configure: pass the app's own flags in the command, such as --port {port}.
3. A small change to the project, only when the app can't take a port or folder from outside. Keep today's behavior as the default, so nothing changes for anyone not using Mako, for example \`port: Number(process.env.PORT) || 5173\`. Say what the change buys.
4. Take turns: when nothing else works, set "oneAtATime": true. One copy runs on this Mac at a time, so a process may keep its fixed port; a start while another Thread has it running is refused and names that Thread. Say plainly what's shared.

## 4. Save the recipe

Pass it to recipe_save as the recipe. Mako checks it against this Thread's ports and this checkout's folders, and refuses it with the reason if it can't run. It keeps the version it replaces.

\`\`\`json
{
  "values": { "PORT": "{port}", "APP_URL": "{url}", "API_URL": "http://{host}:{port+1}" },
  "processes": {
    "web": { "command": "npm run dev", "port": "{port}" },
    "api": { "command": "npm run api", "port": "{port+1}", "cwd": "server", "values": { "HOME": "{data}/home" } }
  },
  "checks": { "quick": "npm run typecheck && npm test", "full": "npm run e2e" },
  "prepare": [{ "command": "npm install", "inputs": ["package-lock.json"], "outputs": ["**/node_modules"] }],
  "carry": ["config/dev.local.json"],
  "secrets": [".env.local", "server/.env"]
}
\`\`\`

The fields:

- values: names the app reads. Mako sets them in every agent's shell and in every process.
  - The placeholders are {port}, {port+N} (N up to 9), {host}, {url}, {data} and {thread}. {thread} names this copy of the app, for a profile, database, branch or Compose project name: lowercase letters, digits and hyphens, at most 36 characters, so quote it where a hyphen needs quoting. Threads that share one folder share one copy, so they get the same values.
  - PATH, HOME, SHELL, USER, TMPDIR and PWD can't be set here, because the agent's own shell needs them.
  - MAKO_THREAD_* and MAKO_CONTROL_* are Mako's own. The project's own MAKO_ names are fine.
- processes: what runs the app, as the project's own commands.
  - "port" is {port} or {port+N}. The process counts as running once that port answers.
  - A fixed port, such as "5432", only with "oneAtATime": true.
  - A process can set its own values, including HOME, TMPDIR or XDG_* for an app with no data-folder setting.
- checks.quick: no running app, such as typecheck, lint and unit tests.
- checks.full: runs against the running app, such as end-to-end tests. Mako starts the app first.
- prepare: install in a fresh copy, and catch up after the branch moves. Each step runs again only when one of its inputs changes. Only add it if a fresh checkout can't start without it.
  - Use the command a developer runs after pulling, in the project's own tool: npm install, pnpm install, bun install, uv sync, bundle install, cargo fetch. Never a clean reinstall (npm ci, or deleting what it installs first): it throws away what a new checkout was given.
  - inputs: the files the step reads, usually the lockfiles. A folder counts only the files Git tracks or would track there.
  - outputs: what the step writes, as paths or patterns (* stays in one folder, ** crosses folders), such as **/node_modules. A new checkout gets them cloned from the main checkout when its inputs are the same there, which costs no disk and takes a second or two, so its first install only catches up. List only what still works in another folder. Never a Python virtual environment (.venv): it names its own folder, so a copy quietly runs the main checkout's code, and Mako refuses it; uv sync makes one from its cache in well under a second anyway. A build cache that checks itself works: with Rust's target/ cloned in, Cargo keeps the dependencies and rebuilds only the project's own crates.
- carry: files Git ignores that a new checkout gets from the main checkout as they are, before its agent starts, such as a local settings file. Paths or patterns. Never credentials: recipe_save refuses a file that holds them by its name, such as .env, and says to list it under secrets.
- secrets: files Git ignores that hold credentials, such as .env.local or server/.env. A new checkout gets them from the main checkout only once the user allows it in Mako, where they see the list; until then, Threads outside the main checkout start without them. Nobody reads them, you included.
- oneAtATime: true for an app whose fixed port, local database or Docker stack copies can't split (rung 4 above).
- Nothing else comes from the main checkout: without carry, secrets and outputs, a new checkout has only what Git checks out.

Keep it small, and name the project's own scripts. Add a script to the project only when none exists. Nothing Mako-specific goes inside a command, so every command still works without Mako.

Saving it reaches every Thread of the project at once, including ones on other branches. So save it once you've worked it out, not piece by piece. The tools below run the saved recipe, so if the proof fails, fix it and save again.

## 5. Prove it with the tools, not by hand

Never run the app with & or nohup in your own shell. Use the tools, so it stays this Thread's.

1. Call app_status: the recipe is ready, and the values resolved as you meant. If it has carry or outputs, saving it said what each found in the main checkout; check that's what you meant.
2. Call app_start: every process is running on its port. If one isn't, call app_logs, fix the cause, and try again.
3. Fetch the app at MAKO_THREAD_URL, or at 127.0.0.1 on its port, from your shell (curl, or the project's own test script), and check that it's this copy answering, such as the page title or a health endpoint. Don't drive a browser or the desktop for this.
4. Show it keeps out of the way, with app_probe while it runs:
   - listening: every port is inside this Thread's block; one with a note is a fixed port a second copy would fight over.
   - connectsTo: each local service it uses, with who runs it. A service another Thread's copy uses too is shared, so the copy needs its own database, namespace or prefix there (section 6).
   - writing and changedFolders: nothing of the project's in the usual data folder or profile, such as ~/Library/Application Support/<app>. Other apps write to these folders too; look for this project's names.
5. Call app_check "quick", then app_check "full" if the recipe has one.
6. Call app_stop, then app_probe again: nothing is listening, and leftovers is empty. A leftover is a process the app left behind, such as a daemon it started, which the next copy would find.

## 6. Outside services

Give each service its mode in one plain sentence: its own copy per Thread, shared, or read-only.

- Sharing is a fine answer when the project wants it.
- When a service is shared, write the one rule agents follow, such as "only touch rows you created".
- Ask the user only when your choice changes where real data goes, for example agents writing to a production database today.

### A database of its own per Thread

When copies would change each other's data, give each Thread its own database with one of these, whichever fits how the project already runs its database. Mako runs no database server; the project's own does the work.

1. The project's own local server, a database per Thread. Name it for the Thread in values, such as DATABASE_URL set to postgres://localhost:5432/app_{thread} (and DB_NAME to app_{thread} if the project's scripts want the name), and make it with the project's own setup or migration script, run as a prepare step whose inputs are the migrations. Copying a prepared database is fastest: Postgres's createdb -T app_template makes one in milliseconds, though nothing may be connected to the template while it's copied. Elsewhere, create it and run the migrations.
2. A database in Docker Compose: COMPOSE_PROJECT_NAME set to {thread} gives each Thread its own containers and volume, with the published port on a Thread port (rung 1 above). A container_name in the compose file defeats this, so remove it or take turns.
3. A hosted database that branches, such as Neon, Supabase or PlanetScale: a branch named for the Thread, made by the provider's own CLI in a prepare step, with DATABASE_URL pointing at it. Neon makes a branch in about a second. Ask the user first: it needs the CLI signed in and may cost money.

Several services can share one server this way. A queue or workflow server (Temporal, Redis) needs a namespace, prefix or database number per Thread too, or one copy's workers take another's work.

### Credentials

Every project that reads credentials gets the same treatment:

1. List them under secrets, by file, never in carry and never by value.
2. If the project can also run without them (a local, isolated or mock mode), say so and ask the user which every Thread should run: with the credentials copied in, against what they reach, or without them.
3. Tell the user they allow the files in Mako, under Settings, then Apps. Never ask them to paste a value, and never copy a file yourself.

## 7. Stop and ask

Ask before any of these:

- A secret: never read .env values or any file under secrets. Name the file or variable the app needs; the user allows the file in Mako or supplies the value.
- A paid service.
- A change bigger than a small one.
- sudo, or installing anything globally.

Never write to production data, delete data, or stop a process you didn't start.

## 8. Finish

1. The recipe needs no commit: it's saved in Mako. Commit any small change to the project on this Thread's branch.
2. Tell the user in full, plain sentences, not fragments, someone who hasn't read the code:
   - what every Thread now gets;
   - what stays shared, and the rule for it; each database's pattern;
   - the credentials files, what the app needs them for, and that they allow them in Settings, then Apps;
   - each change to the project, which rung it used, and what it buys; fixes to things that were already broken, separately;
   - the proof: the processes that ran, their ports, and the check results.
3. If you changed the project, say that other branches run the recipe without that change until it's merged, and what that means for them, such as two copies still sharing one port. Offer to merge or open a pull request; the user decides.
4. If the user wants teammates to get the recipe through Git, write the same recipe to ${RECIPE_PATH} and commit it too. Offer this; don't do it unasked.

If something needs human eyes, such as a sign-in flow you can't complete or a visual change, you may ask the user to try it on the running app. That's optional, never a gate.
`
