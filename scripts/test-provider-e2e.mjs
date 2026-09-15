import { imageFixture } from "./provider-e2e-fixtures.mjs"
import {
  sampleFrontmost,
  startElectronFixture,
} from "./lib/control-fixture.mjs"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
if (
  process.argv.includes("--launch-only") &&
  process.argv
    .slice(2)
    .some((arg) => arg.startsWith("--") && arg !== "--launch-only")
)
  throw new Error(
    "Launch-only checks cannot be combined with prompt or mutation scenarios"
  )
if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-provider-e2e-"))
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "mako-e2e", main: fileURLToPath(import.meta.url) })
  )
  for (const name of ["node_modules", "dist-electron", "scripts"])
    await symlink(join(repo, name), join(root, name), "dir")
  const child = spawn(
    join(repo, "node_modules/.bin/electron"),
    [root, ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, MAKO_E2E_ROOT: root },
    }
  )
  child.on("exit", (code) => {
    process.exitCode = code ?? 1
  })
} else {
  void runElectron().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

async function runElectron() {
  const { app } = await import("electron")
  const root = process.env.MAKO_E2E_ROOT
  if (!root) throw new Error("Launch this test with Node")
  const controlMode = process.argv.includes("--control")
  await mkdir(join(root, "user-data"))
  app.setPath("userData", join(root, "user-data"))
  await app.whenReady()
  const { LiveConversations } =
    await import("../dist-electron/live-conversations.js")
  const { providerHost } = await import("../dist-electron/providers/index.js")
  const { discoverMcpRegistry } =
    await import("../dist-electron/mcp-registry.js")
  const { ensureCuaEmbedded, stopCuaEmbedded } =
    await import("../dist-electron/cua-embedded.js")
  const { bindAcp, stopAcp } = await import("../dist-electron/acp.js")
  const { bindCodexApp, stopCodexApps } =
    await import("../dist-electron/codex-app.js")
  const { startConversationMcp } =
    await import("../dist-electron/conversation-mcp.js")
  const { defaultCatalog } = await import("@mako/sessions")
  const { nativeCheckpoint, resumeVerdict: genericResumeVerdict } =
    await import("../dist-electron/native-continuation.js")
  const { resumable } =
    await import("../dist-electron/contracts/conversation-control.js")
  const cuaRoot = join("/tmp", `mako-provider-cua-${String(process.pid)}`)
  if (controlMode) {
    await mkdir(cuaRoot, { recursive: true })
    if (!(await ensureCuaEmbedded(cuaRoot, "dev.mako.provider-e2e")))
      throw new Error("--control needs an installed CUA Driver")
  }
  // The host's own policy: a driver that knows its store (Cursor's SDK
  // index root, Devin's lock file) judges it; the rest hash the record and
  // ask the provider's process probe.
  const checkpoint = (provider, path) => {
    const driver = providerHost.liveDrivers.get(provider)
    return driver?.checkpoint ? driver.checkpoint(path) : nativeCheckpoint(path)
  }
  const resumeVerdict = (binding) => {
    const driver = providerHost.liveDrivers.get(binding.provider)
    return driver?.resumeVerdict
      ? driver.resumeVerdict(binding)
      : genericResumeVerdict(
          binding,
          providerHost.processProbes.get(binding.provider)
        )
  }
  const catalog = defaultCatalog()
  const { BrowserService } = await import("../dist-electron/browser-service.js")
  const { startControlService } =
    await import("../dist-electron/control-service.js")
  const { extensionBrowsers } =
    await import("../dist-electron/browser-extension-registration.js")
  const browser = new BrowserService(
    process.env.MAKO_E2E_BROWSER_REGISTRATION_ROOT
      ? extensionBrowsers(process.env.MAKO_E2E_BROWSER_REGISTRATION_ROOT)
      : undefined
  )
  const browserOperations = []
  const executeBrowser = browser.execute.bind(browser)
  browser.execute = async (conversationId, command, ...args) => {
    const value = await executeBrowser(conversationId, command, ...args)
    browserOperations.push({ conversationId, action: command.action })
    return value
  }
  let control
  let mcp
  const dependencies = {
    mcpSnapshot: (cwd) => discoverMcpRegistry(cwd, root),
    root: join(root, "journals"),
    appPath: root,
    driver: (provider) => providerHost.liveDrivers.get(provider),
    providers: () =>
      providerHost.liveDrivers.list().map((driver) => driver.provider),
    tools: (binding, id) => {
      const conversation = mcp?.mint(binding, id)
      return conversation
        ? { ...conversation, control: control?.mint(id, binding) }
        : undefined
    },
    history: (path, before) => catalog.page(path, before),
    checkpoint: (path, provider) => checkpoint(provider, path),
    resumeVerdict,
    emit: () => {},
  }
  let owner = new LiveConversations(dependencies)
  bindAcp((event) => owner.observe(event))
  bindCodexApp((event) => owner.observe(event))
  mcp = await startConversationMcp(owner)
  control = await startControlService(browser, (id, binding) =>
    owner.authorizeAgent(id, binding)
  )
  const { harnessProfile } = await import("../dist-electron/harnesses.js")
  const { resolveSessionSettings, modelByIdentity } =
    await import("@mako/sessions/settings")
  const models = JSON.parse(process.env.MAKO_E2E_MODELS ?? "{}")
  const results = []
  const controlTitle = `Mako provider control ${randomUUID()}`
  const controlFixture = controlMode
    ? await startElectronFixture({
        root,
        name: "provider-control-fixture",
        title: controlTitle,
        initial: "provider-control-seed",
      })
    : undefined
  const controlStarted = controlFixture
    ? await controlFixture.started()
    : undefined
  const authentications = new Map()
  const delegationParents = new Set()
  const delegationChildren = new Set()
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  const drivers = providerHost.liveDrivers
    .list()
    .filter(
      (driver) => !requested.length || requested.includes(driver.provider)
    )
  async function waitFor(id, predicate, milliseconds = 180_000) {
    const deadline = Date.now() + milliseconds
    while (Date.now() < deadline) {
      const snapshot = owner.snapshot(id)
      if (snapshot?.permissions.length) {
        const reads = snapshot.blocks.filter(
          (block) =>
            block.type === "tool" &&
            block.toolKind === "read" &&
            block.status === "pending"
        )
        const grantedFiles = [
          ...snapshot.requests.flatMap((request) =>
            request.attachments.flatMap((attachment) =>
              attachment.path ? [attachment.path] : []
            )
          ),
          ...snapshot.requests
            .flatMap((request) => request.context ?? [])
            .flatMap((manifest) => [
              manifest.file,
              ...(manifest.resources ?? []),
            ]),
        ]
        for (const permission of snapshot.permissions) {
          const once = permission.options.find(
            (option) => option.kind === "allow_once"
          )
          const fixtureAuthentication =
            process.argv.includes("--launch-only") &&
            snapshot.session.harness === "devin" &&
            permission.kind === "authentication" &&
            permission.options.length === 1 &&
            permission.options[0].optionId === "devin-browser"
          const fixtureRead =
            permission.title === "Read File" &&
            reads.some((block) =>
              grantedFiles.some((file) => block.input?.includes(file))
            )
          const capabilitiesRead =
            permission.title ===
            "mcp__mako-conversations__mako_conversation_capabilities"
          const fixtureControl =
            controlMode &&
            /mako-local-control|mako_computer_/i.test(permission.title)
          const fixtureDelegation =
            delegationParents.has(id) &&
            permission.title ===
              'mako-conversations: Allow the mako-conversations MCP server to run tool "mako_delegate_task"?'
          const fixtureChildWrite =
            delegationChildren.has(id) &&
            permission.title ===
              `Write ${join(await realpath(snapshot.session.cwd), "proof.txt")}`
          if (
            !once ||
            (!fixtureRead &&
              !fixtureAuthentication &&
              !capabilitiesRead &&
              !fixtureControl &&
              !fixtureDelegation &&
              !fixtureChildWrite)
          )
            throw new Error(
              `Permission outside the fixture read grant: ${permission.title}`
            )
          if (fixtureAuthentication)
            authentications.set(id, (authentications.get(id) ?? 0) + 1)
          await owner.permission(id, permission.id, {
            kind: "choice",
            optionId: once.optionId,
          })
        }
      }
      if (predicate(snapshot)) return snapshot
      if (snapshot?.session.status === "failed")
        throw new Error(snapshot.session.error ?? "Provider failed")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Provider did not complete within the test deadline")
  }
  try {
    for (const driver of process.argv.includes("--browser-only") ||
    process.argv.includes("--fork-only")
      ? []
      : drivers) {
      const result = {
        provider: driver.provider,
        available: driver.available(root),
        status: "pending",
      }
      results.push(result)
      if (!result.available) {
        result.status = "unavailable"
        console.log(JSON.stringify(result))
        continue
      }
      if (process.argv.includes("--probe-steer") && !driver.steer) {
        const source = providerHost.acpSources.get(driver.provider)
        if (source) {
          source.steering = "concurrent-prompt"
          driver.steer = (await import("../dist-electron/acp.js")).liveSteer
        }
      }
      const id = randomUUID()
      const cwd = join(root, driver.provider)
      await mkdir(cwd)
      const nonce = randomUUID()
      await writeFile(
        join(cwd, "proof.txt"),
        `The fixture value is ${nonce}.\n`
      )
      console.log(`Testing installed ${driver.provider} through Mako`)
      try {
        const profile = process.argv.includes("--settings")
          ? await harnessProfile(driver.provider, true, cwd)
          : undefined
        const selectedModel =
          process.env.MAKO_E2E_MODEL ?? models[driver.provider]
        const tuning = profile
          ? resolveSessionSettings({
              models: profile.models,
              context: "new",
              defaults: profile.settings,
              overrides: selectedModel ? { model: selectedModel } : undefined,
            }).settings
          : selectedModel
            ? { model: selectedModel }
            : undefined
        if (profile) {
          result.discovery = {
            count: profile.models.length,
            settings: profile.settings,
            error: profile.configurationError,
          }
          if (!profile.models.length)
            throw new Error(
              "Installed provider returned an empty model catalog"
            )
        }
        const launchOnly = process.argv.includes("--launch-only")
        const launchBegan = performance.now()
        // MAKO_E2E_MODE selects an access mode before launch, exactly as the
        // desk does from a saved preference (for example `access:full`).
        await owner.start(driver.provider, cwd, {
          conversationId: id,
          title: "Mako disposable E2E fixture",
          tuning,
          modeId: process.env.MAKO_E2E_MODE || undefined,
          threadPath: undefined,
          displayPrompt: undefined,
        })
        await waitFor(
          id,
          (snapshot) => snapshot?.session.status === "ready",
          60_000
        )
        if (profile) {
          const session = owner.snapshot(id).session
          result.startedSettings = session.settings
          const ids = session.configOptions.map((option) => option.id)
          if (new Set(ids).size !== ids.length)
            throw new Error("Duplicate setting IDs in live provider options")
        }
        if (launchOnly) {
          const state = owner.snapshot(id).session
          result.status = "passed"
          result.launchMs = performance.now() - launchBegan
          result.nativeIdentityReported = Boolean(state.nativeId)
          result.authenticationConsents = authentications.get(id) ?? 0
          result.currentMode = state.currentMode
          result.availableModeIds = state.modes.map((mode) => mode.id)
          console.log(JSON.stringify(result))
          await writeFile(
            join(root, "results.json"),
            JSON.stringify(results, null, 2)
          )
          continue
        }
        const requestId = randomUUID()
        // --shell asks for a command instead of a file read. The permission
        // handler above rejects any command approval, so a completed shell
        // turn proves the selected access mode answered it without the user.
        const frontmost = controlMode ? sampleFrontmost() : undefined
        owner.submit(
          id,
          requestId,
          controlMode
            ? `Read proof.txt to obtain the exact fixture value. Then use Mako's local computer control MCP to operate the background window titled ${JSON.stringify(controlTitle)}. The target pid is ${String(controlStarted?.pid)}. Replace its Proof field with that fixture value, press its Verify proof button, and reply "done". Do not bring the target to the foreground. This is an authorized disposable integration test.`
            : process.argv.includes("--shell")
              ? "Run the shell command `cat proof.txt` with your terminal or shell tool and reply with only the fixture value it prints. This is an authorized disposable integration test. Do not modify files."
              : "Read proof.txt in this workspace using your file tool. Reply with only the fixture value. This is an authorized disposable integration test. Do not modify files."
        )
        let completed
        let frontmostSeen = []
        try {
          completed = await waitFor(id, (snapshot) =>
            snapshot?.requests.some(
              (request) =>
                request.id === requestId && request.status === "completed"
            )
          )
        } finally {
          if (frontmost) frontmostSeen = [...(await frontmost.stop()).keys()]
        }
        result.currentMode = completed.session.currentMode
        result.availableModeIds = completed.session.modes.map((mode) => mode.id)
        const response = completed.blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
        if (controlMode) {
          const controlState = await controlFixture.until(
            async () => {
              const state = await controlFixture.state()
              return state.input === nonce && state.value === nonce
                ? state
                : null
            },
            `${driver.provider} changed and verified the background fixture`,
            5000
          )
          if (frontmostSeen.includes(controlStarted.pid))
            throw new Error(
              `${driver.provider} brought the control fixture to the foreground`
            )
          result.control = {
            state: controlState,
            frontmostSeen,
            targetFronted: false,
          }
        } else if (!response.includes(nonce))
          throw new Error(
            `The real response did not contain the value from the fixture file: ${JSON.stringify(response.slice(0, 600))}`
          )
        if (profile) {
          const controls =
            profile.transport === "sdk"
              ? modelByIdentity(
                  profile.models,
                  completed.session.settings?.model
                )?.options
              : completed.session.configOptions
          const effort = controls?.find(
            (option) =>
              option.id === "effort" &&
              option.kind === "select" &&
              option.change !== "launch"
          )
          const originalEffort = completed.session.settings?.options?.effort
          const next = effort?.values?.find(
            (choice) => choice.value !== originalEffort
          )
          if (next && originalEffort !== undefined) {
            const changeId = randomUUID()
            owner.submit(
              id,
              changeId,
              "Repeat the fixture value from your previous answer. Do not use any tools.",
              [],
              { options: { effort: next.value } }
            )
            completed = await waitFor(id, (snapshot) =>
              snapshot?.requests.some(
                (request) =>
                  request.id === changeId && request.status === "completed"
              )
            )
            if (completed.session.settings?.options?.effort !== next.value)
              throw new Error("Provider did not retain the changed effort")
            result.changedEffort = next.value
            result.changedSettings = completed.session.settings
            const restoreId = randomUUID()
            owner.submit(
              id,
              restoreId,
              "Repeat the fixture value once more. Do not use any tools.",
              [],
              { options: { effort: originalEffort } }
            )
            completed = await waitFor(id, (snapshot) =>
              snapshot?.requests.some(
                (request) =>
                  request.id === restoreId && request.status === "completed"
              )
            )
            if (completed.session.settings?.options?.effort !== originalEffort)
              throw new Error(
                "Provider did not restore the original effort after the test"
              )
            result.restoredEffort = originalEffort
          }
        }
        if (process.argv.includes("--steer")) {
          if (!driver.steer)
            throw new Error("This provider has no steering transport")
          const nativeId = completed.session.nativeId
          const steeredRequest = randomUUID()
          const actionId = randomUUID()
          const steerNonce = randomUUID()
          owner.submit(
            id,
            steeredRequest,
            "Read proof.txt again with your file tool, then summarize the result briefly. Do not modify anything."
          )
          await waitFor(
            id,
            (snapshot) =>
              snapshot?.session.status === "running" &&
              snapshot.requests.some(
                (request) => request.id === steeredRequest && request.nativeRun
              )
          )
          const [receipt, finished] = await Promise.all([
            owner.act(id, {
              kind: "steer",
              id: actionId,
              requestId: steeredRequest,
              text: `Change the final answer to exactly ${steerNonce}. Do not use tools for this additional instruction.`,
              attachments: [],
            }),
            waitFor(id, (snapshot) =>
              snapshot?.requests.some(
                (request) =>
                  request.id === steeredRequest &&
                  request.status === "completed"
              )
            ),
          ])
          if (
            receipt.state.kind !== "accepted" &&
            receipt.state.kind !== "completed"
          )
            throw new Error(
              `Steering was not confirmed: ${JSON.stringify(receipt.state)}`
            )
          if (finished.session.nativeId !== nativeId)
            throw new Error("Steering changed native session identity")
          if (
            !finished.blocks.some(
              (block) =>
                block.type === "text" && block.text.includes(steerNonce)
            )
          )
            throw new Error(
              "The provider's answer did not incorporate the steering instruction"
            )
          if (
            finished.blocks.filter(
              (block) =>
                block.type === "user" && block.steeringFor === steeredRequest
            ).length !== 1
          )
            throw new Error(
              "Steering must appear exactly once in its original exchange"
            )
          completed = finished
          result.steering =
            "confirmed mid-turn instruction, same native session, one receipt"
        }
        if (process.argv.includes("--continuation")) {
          const nativeId = completed.session.nativeId
          const bindings = completed.control?.bindings.length
          const replyId = randomUUID()
          const queuedId = randomUUID()
          owner.submit(
            id,
            replyId,
            "Repeat the original fixture value read from proof.txt, not any later steering marker. Do not use tools."
          )
          owner.submit(
            id,
            queuedId,
            "Repeat the original value from proof.txt once more, not the steering marker. Do not use tools."
          )
          completed = await waitFor(id, (snapshot) =>
            snapshot?.requests.some(
              (request) =>
                request.id === queuedId && request.status === "completed"
            )
          )
          if (
            completed.session.nativeId !== nativeId ||
            completed.control?.bindings.length !== bindings
          )
            throw new Error(
              "A follow-up or queued message created a different native session"
            )
          const tail =
            completed.blocks.filter((block) => block.type === "text").at(-1)
              ?.text ?? ""
          if (!tail.includes(nonce))
            throw new Error("The continuation lost the previous turn's context")
          result.continuation =
            "idle reply and queued follow-up retain native identity and context"
        }
        result.status = "passed"
        result.nativeId = completed.session.nativeId
        if (profile) result.completedSettings = completed.session.settings
        result.toolCalls = completed.blocks
          .filter((block) => block.type === "tool")
          .map((block) => block.title)
        if (
          controlMode &&
          !result.toolCalls.some((title) => /mako_computer_exec/i.test(title))
        )
          throw new Error(
            `The provider changed the fixture without the requested local-control tool: ${JSON.stringify(result.toolCalls)}`
          )
        result.proof = nonce
        await writeFile(
          join(root, `${driver.provider}.json`),
          JSON.stringify(completed, null, 2)
        )
      } catch (error) {
        result.status = "failed"
        result.error = error instanceof Error ? error.message : String(error)
        const snapshot = owner.snapshot(id)
        if (snapshot) {
          result.nativeId ??= snapshot.session.nativeId
          await writeFile(
            join(root, `${driver.provider}.json`),
            JSON.stringify(snapshot, null, 2)
          )
        }
      } finally {
        if (owner.snapshot(id)) await owner.close(id)
      }
      console.log(JSON.stringify(result))
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    if (process.argv.includes("--settings")) {
      const refs = await catalog.scan()
      for (const result of results) {
        const ref = refs.find(
          (ref) =>
            ref.harness === result.provider && ref.nativeId === result.nativeId
        )
        result.nativeSettings = ref?.settings
        console.log(
          JSON.stringify({
            provider: result.provider,
            nativeSettings: result.nativeSettings,
          })
        )
      }
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    if (
      process.argv.includes("--browser") ||
      process.argv.includes("--browser-only")
    ) {
      const { runBrowserFixture } = await import("./provider-e2e-browser.mjs")
      results.push(
        ...(await runBrowserFixture(
          owner,
          root,
          drivers.map((driver) => driver.provider),
          browserOperations,
          models
        ))
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    if (process.argv.includes("--direct-attachments")) {
      const cwd = join(root, "direct-attachment-fixture")
      await mkdir(cwd)
      const id = randomUUID(),
        requestId = randomUUID(),
        proof = randomUUID()
      const picture = imageFixture(),
        file = Buffer.from(`FINAL_FIXTURE_VALUE=${proof}\n`)
      await owner.start("codex", cwd, {
        conversationId: id,
        title: "Mako direct attachment fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      owner.submit(
        id,
        requestId,
        "Inspect the attached image and return RED=n BLUE=n for its red and blue square counts. Read the attached text file and return its FINAL_FIXTURE_VALUE.",
        [
          {
            name: "squares.png",
            mimeType: "image/png",
            size: picture.length,
            data: picture.toString("base64"),
          },
          {
            name: "value.txt",
            mimeType: "text/plain",
            size: file.length,
            data: file.toString("base64"),
          },
        ]
      )
      const completed = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === requestId && request.status === "completed"
        )
      )
      const reply = completed.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (
        !/RED\s*=\s*4/i.test(reply) ||
        !/BLUE\s*=\s*2/i.test(reply) ||
        !reply.includes(proof)
      )
        throw new Error(`Direct attachment delivery failed: ${reply}`)
      results.push({ flow: "direct-image-and-file", status: "passed", proof })
      console.log("Real direct image and file attachment delivery passed")
      await writeFile(
        join(root, "direct-attachments.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
    }
    if (process.argv.includes("--remote")) {
      const { runRelayFixture } = await import("./provider-e2e-relay.mjs")
      const result = await runRelayFixture(owner, root)
      results.push(result)
      console.log(JSON.stringify(result))
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    if (process.argv.includes("--attachments")) {
      const cwd = join(root, "attachment-fixture")
      await mkdir(cwd)
      const proof = randomUUID()
      const picture = imageFixture()
      const artifact = Buffer.from(
        `${"Fixture padding.\n".repeat(20_000)}FINAL_FIXTURE_VALUE=${proof}\n`
      )
      await writeFile(join(cwd, "squares.png"), picture)
      await writeFile(join(cwd, "large.txt"), artifact)
      const attachments = [
        {
          name: "squares.png",
          mimeType: "image/png",
          size: picture.length,
          data: picture.toString("base64"),
        },
        {
          name: "large.txt",
          mimeType: "text/plain",
          size: artifact.length,
          data: artifact.toString("base64"),
        },
      ]
      const id = randomUUID()
      await owner.start("claude", cwd, {
        conversationId: id,
        title: "Mako attachment transfer fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      const initial = randomUUID()
      owner.submit(
        id,
        initial,
        "These are fixtures for a later request. Reply only READY. Do not describe the image or read the text file yet.",
        attachments
      )
      await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) => request.id === initial && request.status === "completed"
        )
      )
      await unlink(join(cwd, "squares.png"))
      await unlink(join(cwd, "large.txt"))
      const before = owner.snapshot(id).blocks.length
      const requestId = randomUUID()
      owner.transfer(id, {
        id: requestId,
        provider: "codex",
        text: "Read the transferred attachment files. Open and inspect squares.png using your image tool. Return the number of red and blue squares as RED=n BLUE=n. Read the very end of large.txt and return its FINAL_FIXTURE_VALUE. The original workspace copies have been deleted, so use the retained resources in the context bundle.",
        attachments: [],
      })
      const completed = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === requestId && request.status === "completed"
        )
      )
      const added = completed.blocks.slice(before)
      const reply = added
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (
        !/RED\s*=\s*4/i.test(reply) ||
        !/BLUE\s*=\s*2/i.test(reply) ||
        !reply.includes(proof)
      )
        throw new Error(`Attachment transfer failed: ${reply}`)
      const tools = added
        .filter((block) => block.type === "tool")
        .map((block) => block.title)
      results.push({
        flow: "real-attachment-transfer",
        status: "passed",
        proof,
        bytes: artifact.length,
        tools,
      })
      console.log(
        "Real image inspection and large artifact tail retrieval passed after original file deletion"
      )
      await writeFile(
        join(root, "attachments.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
    }
    if (process.argv.includes("--delegate")) {
      const cwd = join(root, "delegation-fixture")
      await mkdir(cwd)
      const parentValue = randomUUID()
      const childValue = randomUUID()
      await writeFile(join(cwd, "proof.txt"), parentValue)
      const id = randomUUID()
      const childId = randomUUID()
      await owner.start("codex", cwd, {
        conversationId: id,
        title: "Mako model delegation fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      delegationParents.add(id)
      delegationChildren.add(childId)
      owner.submit(
        id,
        randomUUID(),
        `This is an explicitly authorized delegation integration test. Call mako_delegate_task with id ${childId}, provider claude, and task: "Read proof.txt. Replace its contents with ${childValue}. Report the original and new value. This is your isolated disposable workspace." Do not perform the child task yourself. After delegating, end your response. When the child's result arrives, report both values.`
      )
      await waitFor(id, () => Boolean(owner.snapshot(childId)))
      const child = await waitFor(childId, (snapshot) =>
        snapshot?.requests.some((request) => request.status === "completed")
      )
      if (child.session.cwd === cwd)
        throw new Error("Delegated child shared the parent workspace")
      if ((await readFile(join(cwd, "proof.txt"), "utf8")) !== parentValue)
        throw new Error("Child modified the parent workspace")
      if (
        (
          await readFile(join(child.session.cwd, "proof.txt"), "utf8")
        ).trim() !== childValue
      )
        throw new Error("Child did not perform its isolated write")
      const completed = await waitFor(
        id,
        (snapshot) =>
          snapshot?.control.children.some(
            (child) => child.id === childId && child.delivery === "delivered"
          ) && snapshot.session.status === "ready"
      )
      const reply = completed.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (!reply.includes(childValue) || !reply.includes(parentValue))
        throw new Error("Parent did not receive the actual child result")
      const calls = completed.blocks.filter((block) => block.type === "tool")
      if (!JSON.stringify(calls).includes("mako_delegate_task"))
        throw new Error("Parent did not call the delegation tool")
      results.push({
        flow: "model-delegation",
        status: "passed",
        parent: id,
        child: childId,
        parentValue,
        childValue,
        workspace: child.session.cwd,
      })
      console.log(
        "Real model delegation, isolated child write and parent result delivery passed"
      )
      await writeFile(
        join(root, "delegation.json"),
        JSON.stringify({ parent: completed, child }, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
      owner.close(childId)
    }
    if (process.argv.includes("--restart")) {
      // The restart runs on the first requested provider whose driver can
      // reopen a session (Cursor's SDK resume, Grok's session/load, Codex's thread resume);
      // Codex remains the default when none is named.
      const restartProvider =
        process.argv
          .slice(2)
          .filter((arg) => !arg.startsWith("--"))
          .find(
            (candidate) => providerHost.liveDrivers.get(candidate)?.canResume
          ) ?? "codex"
      const cwd = join(root, "restart-fixture")
      await mkdir(cwd)
      const id = randomUUID()
      const proof = randomUUID()
      await owner.start(restartProvider, cwd, {
        conversationId: id,
        title: "Mako restart fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      const initial = randomUUID()
      owner.submit(
        id,
        initial,
        `Remember this fixture value: ${proof}. Reply with the value only.`
      )
      const source = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) => request.id === initial && request.status === "completed"
        )
      )
      const refs = await catalog.scan()
      const ref = refs.find(
        (ref) =>
          ref.harness === restartProvider &&
          ref.nativeId === source.session.nativeId
      )
      if (!ref) throw new Error("Exact native session ID was not discoverable")
      await owner.bind(id, ref.path)
      await waitFor(id, (snapshot) =>
        snapshot?.control.bindings.some((binding) => binding.checkpoint)
      )
      const binding = owner
        .snapshot(id)
        .control.bindings.find(
          (binding) => binding.nativeId === source.session.nativeId
        )
      owner.stop()
      stopCodexApps()
      mcp.close()
      const deadline = Date.now() + 30_000
      while (!resumable(await resumeVerdict(binding), "same")) {
        if (Date.now() > deadline)
          throw new Error("Native session did not become safe to resume")
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      owner = new LiveConversations(dependencies)
      mcp = await startConversationMcp(owner)
      const requestId = randomUUID()
      owner.submit(
        id,
        requestId,
        "What exact fixture value did I ask you to remember? Return the value only."
      )
      const completed = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === requestId && request.status === "completed"
        )
      )
      if (completed.session.nativeId !== source.session.nativeId)
        throw new Error("Restart did not reuse the verified native ID")
      const reply = completed.blocks
        .slice(source.blocks.length)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (!reply.includes(proof))
        throw new Error("Resumed provider lost native history")
      const request = completed.requests.find(
        (request) => request.id === requestId
      )
      if (
        request.context.some(
          (manifest) =>
            manifest.includesBase || manifest.fromBlock !== source.blocks.length
        )
      )
        throw new Error("Restart silently used full portable context")
      results.push({
        flow: "native-restart",
        provider: restartProvider,
        status: "passed",
        nativeId: completed.session.nativeId,
        proof,
      })
      console.log(
        "Real native restart passed with unchanged native ID and no portable history"
      )
      await writeFile(
        join(root, "restart.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
    }
    if (
      process.argv.includes("--fork") ||
      process.argv.includes("--fork-only")
    ) {
      const forkProvider = requested[0] ?? "codex"
      const cwd = join(root, "fork-fixture")
      await mkdir(cwd)
      const id = randomUUID()
      const proof = randomUUID()
      await owner.start(forkProvider, cwd, {
        conversationId: id,
        title: "Mako native fork fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      const requestId = randomUUID()
      owner.submit(
        id,
        requestId,
        `Remember this fixture value: ${proof}. Reply with that value only.`
      )
      const source = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === requestId && request.status === "completed"
        )
      )
      const laterId = randomUUID()
      const laterProof = randomUUID()
      owner.submit(
        id,
        laterId,
        `Replace the fixture value with ${laterProof}. Reply with this new value only.`
      )
      await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) => request.id === laterId && request.status === "completed"
        )
      )
      const nativeRuns = owner
        .snapshot(id)
        .requests.filter((request) => request.status === "completed")
        .map((request) => request.nativeRun?.runId)
      if (new Set(nativeRuns).size !== 2 || nativeRuns.some((run) => !run))
        throw new Error(
          "Distinct source turns did not retain distinct native run IDs"
        )
      await owner.close(id)
      const forkId = randomUUID()
      const sourcePath = owner.snapshot(id).threadPath
      if (!sourcePath)
        throw new Error("The host did not retain the native transcript path")
      const sourceCheckpoint = await nativeCheckpoint(sourcePath)
      if (!sourceCheckpoint)
        throw new Error("The native source must be stable before forking")
      const fork = owner.fork(id, {
        id: forkId,
        provider: forkProvider,
        point: { kind: "run", requestId },
      })
      if (!fork.control.ancestry.nativeFork)
        throw new Error("Native fork point missing")
      if (fork.session.nativeId)
        throw new Error("Fork allocated before first send")
      const continuation = randomUUID()
      owner.submit(
        forkId,
        continuation,
        "What exact fixture value did I just ask you to remember? Reply with that value only."
      )
      const completed = await waitFor(forkId, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === continuation && request.status === "completed"
        )
      )
      const reply = completed.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (!reply.includes(proof) || reply.includes(laterProof))
        throw new Error(
          "Native fork lost the selected turn or included a later turn"
        )
      if (completed.session.nativeId === source.session.nativeId)
        throw new Error("Fork reused source native ID")
      if ((await nativeCheckpoint(sourcePath)) !== sourceCheckpoint)
        throw new Error("Native fork modified its source transcript")
      if (
        completed.requests[0].context.some((manifest) => manifest.includesBase)
      )
        throw new Error(
          "Native fork test accidentally supplied portable history"
        )
      results.push({
        flow: "native-fork",
        provider: forkProvider,
        status: "passed",
        source: source.session.nativeId,
        fork: completed.session.nativeId,
        proof,
      })
      console.log("Real native fork passed without portable history")
      await writeFile(
        join(root, "fork.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
      owner.close(id)
      owner.close(forkId)
    }
    if (process.argv.includes("--flows")) {
      const cwd = join(root, "transfer-fixture")
      await mkdir(cwd)
      const proof = randomUUID()
      await writeFile(join(cwd, "proof.txt"), proof)
      const id = randomUUID()
      await owner.start("claude", cwd, {
        conversationId: id,
        title: "Mako real transfer fixture",
      })
      await waitFor(id, (snapshot) => snapshot?.session.status === "ready")
      const initial = randomUUID()
      owner.submit(
        id,
        initial,
        "Read proof.txt and report its exact value. Do not modify anything."
      )
      await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) => request.id === initial && request.status === "completed"
        )
      )
      await unlink(join(cwd, "proof.txt"))
      for (const provider of ["codex", "claude"]) {
        const previous = owner.snapshot(id)
        const requestId = randomUUID()
        owner.transfer(id, {
          id: requestId,
          provider,
          text: "What exact fixture value did the preceding provider report? Read the supplied context and return that value only. The original file has been deleted.",
          attachments: [],
        })
        const completed = await waitFor(id, (snapshot) =>
          snapshot?.requests.some(
            (request) =>
              request.id === requestId && request.status === "completed"
          )
        )
        const added = completed.blocks.slice(previous.blocks.length)
        const reply = added
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
        if (!reply.includes(proof))
          throw new Error(
            `${provider} failed to recover the value through transferred context`
          )
        const result = {
          flow: "real-transfer",
          provider,
          status: "passed",
          conversationId: id,
          nativeId: completed.session.nativeId,
          proof,
          tools: added
            .filter((block) => block.type === "tool")
            .map((block) => block.title),
        }
        results.push(result)
        console.log(JSON.stringify(result))
        await writeFile(
          join(root, "transfer.json"),
          JSON.stringify(completed, null, 2)
        )
      }
      const beforeMcp = owner.snapshot(id).blocks.length
      const mcpRequest = randomUUID()
      owner.submit(
        id,
        mcpRequest,
        "Call the mako_conversation_capabilities MCP tool now. Return the provider IDs it reports. This is an explicitly authorized integration check."
      )
      const completed = await waitFor(id, (snapshot) =>
        snapshot?.requests.some(
          (request) =>
            request.id === mcpRequest && request.status === "completed"
        )
      )
      const calls = completed.blocks
        .slice(beforeMcp)
        .filter((block) => block.type === "tool")
      if (!JSON.stringify(calls).includes("mako_conversation_capabilities"))
        throw new Error(
          "The model did not invoke the real conversation MCP tool"
        )
      results.push({
        flow: "model-mcp-call",
        status: "passed",
        tools: calls.map((block) => block.title),
      })
      console.log("Actual model MCP call passed")
      await writeFile(
        join(root, "transfer.json"),
        JSON.stringify(completed, null, 2)
      )
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    await writeFile(
      join(root, "results.json"),
      JSON.stringify(results, null, 2)
    )
    console.log(`Evidence: ${root}`)
    process.exitCode = results.some((result) => result.status === "failed")
      ? 1
      : 0
  } finally {
    for (const summary of owner.summaries()) {
      const snapshot = owner.snapshot(summary.session.id)
      if (snapshot)
        await writeFile(
          join(root, `snapshot-${summary.session.id}.json`),
          JSON.stringify(snapshot, null, 2)
        )
    }
    console.log(`Evidence retained: ${root}`)
    owner.stop()
    stopAcp()
    stopCodexApps()
    if (controlMode) {
      stopCuaEmbedded()
      await rm(cuaRoot, { recursive: true, force: true })
    }
    mcp.close()
    control.close()
    controlFixture?.stop()
    // A fixture ran in the user's real provider store, so the session it
    // created is deleted through that provider before the run ends. Pass
    // --keep-native to inspect a session in its own app afterwards.
    if (!process.argv.includes("--keep-native")) {
      const refs = await catalog.scan()
      for (const result of results) {
        if (!result.nativeId) continue
        const owned = refs.filter(
          (ref) =>
            ref.harness === result.provider && ref.nativeId === result.nativeId
        )
        for (const ref of owned) {
          const removed = await catalog.remove(ref.path).catch((error) => {
            console.error(
              `Fixture cleanup failed for ${ref.path}: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
          })
          result.nativeCleanup = removed
            ? "removed"
            : "left in place: the provider store keeps no removable form"
          console.log(
            JSON.stringify({
              provider: result.provider,
              nativeId: result.nativeId,
              nativeCleanup: result.nativeCleanup,
            })
          )
        }
        if (!owned.length) result.nativeCleanup = "not found in the catalog"
      }
      await writeFile(
        join(root, "results.json"),
        JSON.stringify(results, null, 2)
      )
    }
    await catalog.stop()
    app.exit(process.exitCode ?? 0)
  }
}
