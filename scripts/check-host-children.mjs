import { relative, resolve, sep } from "node:path"
import ts from "typescript"
import { join } from "node:path"

/**
 * A host child belongs to the stop scope unless it is an explicit handoff.
 * Check Node's symbols, not spelling: aliases, namespace calls, promisify and
 * destructuring must not open a second, unregistered command path.
 *
 * Exceptions name one value use in one function, with its lifetime. Adding
 * another raw start even in that function fails; an obsolete exception fails too.
 */
const hostApproved = [
  ["application/process-group.ts", "runProcessGroup", "spawn", "combines the host stop signal; kills and reaps the whole build group"],
  ["application/process-group.ts", "run", "execFile", "bounded ps diagnostic used while the cancelled group is being reaped"],
  ["threads/catalog-connection.ts", "connectOnDemandCatalog", "spawn", "shared reader daemon outlives this host; its client is cancelled separately"],
  ["terminals/client.ts", "#spawnDaemon", "spawn", "terminal daemon keeps the person's terminals through host restarts"],
  ["transport/service.ts", "ensureRuntime", "spawn", "launches the independent host this client is connecting to"],
  ["base/host-lifecycle.ts", "nodeHostExit", "spawn", "successor starts after cleanup and must survive this host's exit"],
  ["application/local-update-install.ts", "prepareLocalInstall", "fork", "installer is handed off to replace the app after this host exits"],
  ["application/local-update-installer.ts", "execute", "execFile", "self-contained installer program runs after the host has quit"],
  ["workspaces/thread-processes.ts", "spawn", "spawn", "persisted app/check run is owned by its Thread and survives host restart"],
  ["workspaces/editors.ts", "openInExternalEditor", "spawn", "the person's launched editor outlives Mako"],
  ["harnesses/cursor/sdk/shell-folder.ts", "guardShellFolder", "load", "installed inside the SDK child; its shell spawns belong to the provider's process group"],
  ["harnesses/cursor/sdk/shell-folder.ts", "guardShellFolder", "spawn", "wraps the SDK child's original spawn without changing its owner"],
  ["harnesses/cursor/sdk/fork.ts", "cloneFile", "execFileSync", "synchronous APFS clone is finished before a stop can run"],
  ["terminals/process-groups.ts", "runPs", "execFileSync", "synchronous process-table read is bounded to one second"],
  ["workspaces/watcher-child-main.ts", "readTable", "execFile", "the watcher child's bounded ps for the host's app looks; it ends with the child, which the host's hostFork owns"],
  ["workspaces/watcher-child-main.ts", "runProbe", "execFile", "the host's probes (ps, lsof, sysctl: hostProbe) run in the probe child; each ends with the child, which the host's hostFork owns"],
]
const approved = [
  ...hostApproved.map(([file, ...rest]) => [`packages/host/src/${file}`, ...rest]),
  ["packages/git/src/process-runner.ts", "inspect", "execFile", "bounded reaping helpers outside the cancelled scope"],
  ["packages/git/src/process-runner.ts", "spawnOwned", "spawn", "isolated group with confirmed cleanup; host scope injected into Git"],
  ["packages/git/src/process-runner.ts", "forkOwned", "fork", "isolated IPC group with confirmed cleanup"],
  ["packages/control-runtime/src/processes.ts", "nodeCommand", "execFile", "standalone CLI/worker default; every embedded host call binds its scoped command adapter"],
  ["packages/control-runtime/src/processes.ts", "standalone", "spawn", "standalone CLI/worker default; embedded hosts bind their scoped spawn adapter"],
  ["packages/control-runtime/src/processes.ts", "standalone", "fork", "standalone CLI/worker default; embedded hosts bind their scoped fork adapter"],
  ["packages/sessions/src/processes.ts", "standalone", "fork", "standalone catalog default; embedded hosts bind their scoped fork adapter"],
  ["packages/sessions/src/daemon-main.ts", "run", "spawn", "shared reader's backfill process belongs to that independent daemon, not a profile host"],
  ["packages/control-runtime/src/control-cli.ts", "runControlCli", "spawn", "explicit detached cloud-job handoff survives the CLI that started it"],
  ["packages/control-runtime/src/cloud-control-main.ts", "main", "fork", "standalone cloud supervisor owns the worker group and confirms its end"],
  ["packages/control-runtime/src/process-registration.ts", "processRegistrationStartedAt", "execFileSync", "bounded synchronous identity read finishes before stop can run"],
]

/** Every source in the host's local package dependency graph is checked, including worker/CLI entries. */
const packages = new Map()
function includePackage(path) {
  path = resolve(path)
  if (packages.has(path)) return
  const config = ts.getParsedCommandLineOfConfigFile(join(path, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
  if (!config) throw new Error(`No TypeScript config for ${path}`)
  packages.set(path, config)
  for (const reference of config.projectReferences ?? []) includePackage(reference.path)
}
includePackage("packages/host")
const roots = [...packages.values()].flatMap((config) => config.fileNames)
const checkedSource = (file) => !file.isDeclarationFile && [...packages.keys()].some((root) => file.fileName.startsWith(`${root}${sep}src${sep}`))

const spawners = new Set(["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"])
const config = ts.getParsedCommandLineOfConfigFile("packages/host/tsconfig.json", {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
if (!config) throw new Error("The host's TypeScript config doesn't parse")
const options = { ...config.options, noEmit: true, composite: false, declaration: false, declarationMap: false }

function owner(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at)) {
      if (at.name) return at.name.getText()
      let value = at
      while (ts.isAsExpression(value.parent) || ts.isParenthesizedExpression(value.parent)) value = value.parent
      if (ts.isVariableDeclaration(value.parent)) return value.parent.name.getText()
    }
  }
  for (let at = node.parent; at; at = at.parent)
    if (ts.isVariableDeclaration(at)) return at.name.getText()
  return "<module>"
}

function rawUses(program, file) {
  const checker = program.getTypeChecker()
  const uses = []
  const nodeApi = (symbol) => {
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    return symbol && spawners.has(symbol.name) && symbol.declarations?.some((declaration) => declaration.getSourceFile().fileName.split(sep).join("/").endsWith("@types/node/child_process.d.ts")) ? symbol.name : undefined
  }
  const report = (node, api) => uses.push({ api, owner: owner(node), line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
  const visit = (node) => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isCallExpression(node)) {
      const path = node.arguments[0]
      if (path && ts.isStringLiteral(path) && ["node:child_process", "child_process"].includes(path.text)) report(node, "load")
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // Replacing the SDK child's spawn is a write, not starting a child.
      if (!(ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
        const name = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression
        const symbol = ts.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(name) : ts.isStringLiteral(name) ? checker.getTypeAtLocation(node.expression).getProperty(name.text) : undefined
        const api = nodeApi(symbol)
        if (api) report(node, api)
        else if (ts.isElementAccessExpression(node) && !ts.isStringLiteral(name) && nodeApi(checker.getTypeAtLocation(node.expression).getProperty("spawn"))) report(node, "dynamic child_process member")
      }
      // The property identifier is handled here, not a second time below.
      visit(node.expression)
      if (ts.isElementAccessExpression(node)) visit(node.argumentExpression)
      return
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const name = node.propertyName ?? node.name
      const api = nodeApi(checker.getTypeAtLocation(node.parent).getProperty(name.getText()))
      if (api) report(node, api)
      if (node.initializer) visit(node.initializer)
      return
    }
    if (ts.isIdentifier(node)) {
      const declaration = (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent) || ts.isFunctionLike(node.parent)) && node.parent.name === node
      const api = !declaration && nodeApi(checker.getSymbolAtLocation(node))
      if (api) report(node, api)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return uses
}

if (process.argv.includes("--test")) {
  const path = resolve("__host_child_fixture.ts")
  const dependency = resolve("packages/git/src/__host_child_fixture.ts")
  const source = `import {spawn as launch, execFile} from "node:child_process";
import * as cp from "node:child_process";
import {promisify} from "node:util";
import {createRequire} from "node:module";
import {hostCommand, hostExecFile, hostSpawn, hostFork} from "./packages/host/src/base/host-command.js";
import type {ChildProcess} from "node:child_process";
function direct(){ launch("child"); }
function alias(){ const start = launch; start("child"); }
function namespace(){ cp.spawn("child"); }
function bound(){ const start = launch.bind(null); start("child"); }
function computed(){ cp["execFile"]("child"); }
function destructured(){ const {fork: start} = cp; start("child"); }
function promised(){ const run = promisify(execFile); run("child"); }
function required(){ const raw = require("node:child_process"); raw.spawn("child"); }
function aliasedRequire(){ const load = createRequire(import.meta.url); load("node:child_process").spawn("child"); }
async function imported(){ const raw = await import("node:child_process"); raw.spawn("child"); }
function dynamic(name: keyof typeof cp){ return cp[name]; }
function covered(){ hostCommand("child", []); hostSpawn("child", []); hostFork("child", []); hostExecFile("child", [], {}, () => {}); }
function types(child: ChildProcess){ return child.pid; }
function unrelated(){ const app = {spawn(){}}; app.spawn(); }`
  const host = ts.createCompilerHost(options)
  const getSource = host.getSourceFile.bind(host)
  host.getSourceFile = (name, language, ...rest) => name === path ? ts.createSourceFile(name, source, language, true) : getSource(name, language, ...rest)
  const originalSource = host.getSourceFile.bind(host)
  host.getSourceFile = (name, language, ...rest) => name === dependency ? ts.createSourceFile(name, 'import {spawn as start} from "node:child_process"; function dependencyStart(){start("child")}', language, true) : originalSource(name, language, ...rest)
  const program = ts.createProgram({ rootNames: [path, dependency], options, host })
  const uses = rawUses(program, program.getSourceFile(path))
  const found = new Set(uses.map((use) => use.owner))
  for (const name of ["direct", "alias", "namespace", "bound", "computed", "destructured", "promised", "required", "aliasedRequire", "imported", "dynamic"])
    if (!found.has(name)) throw new Error(`The child-process check missed ${name}`)
  for (const name of ["covered", "types", "unrelated"])
    if (found.has(name)) throw new Error(`The child-process check refused ${name}`)
  if (!checkedSource(program.getSourceFile(dependency)) || !rawUses(program, program.getSourceFile(dependency)).some((use) => use.owner === "dependencyStart")) throw new Error("An unowned start inside a host dependency escaped the child check")
  console.log("host child check: rejects aliases, namespaces, promisify, destructuring and module-load bypasses; permits covered runners and types")
} else {
  const program = ts.createProgram({ rootNames: roots, options })
  const expected = new Map(approved.map(([file, name, api, why]) => [`${file}:${name}:${api}`, { why, seen: 0 }]))
  const problems = []
  for (const file of program.getSourceFiles()) {
    const path = relative(resolve("."), file.fileName).split(sep).join("/")
    if (!checkedSource(file)) continue
    for (const use of rawUses(program, file)) {
      const entry = expected.get(`${path}:${use.owner}:${use.api}`)
      if (entry && ++entry.seen === 1) continue
      problems.push(`${path}:${use.line}: ${use.api} in ${use.owner} bypasses the host stop scope; use hostCommand, hostExecFile, hostSpawn or hostFork`)
    }
  }
  for (const [point, entry] of expected)
    if (!entry.seen) problems.push(`${point}: obsolete child-lifetime exception (${entry.why})`)
  if (problems.length) {
    console.error(problems.join("\n"))
    process.exitCode = 1
  } else console.log(`host children: every process start uses a covered runner or one of ${approved.length} documented lifetime boundaries`)
}
