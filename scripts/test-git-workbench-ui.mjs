import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = await mkdtemp(join(tmpdir(), "mako-git-workbench-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    server: { host: "127.0.0.1", port: 0, watch: null },
  })
  await server.listen()
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mako-git-workbench-check",
      main: fileURLToPath(import.meta.url),
    })
  )
  const env = {
    ...process.env,
    MAKO_GIT_CHECK_ROOT: root,
    MAKO_GIT_CHECK_URL: server.resolvedUrls.local[0],
    MAKO_GIT_REAL_URL: process.argv[2] ?? "",
    MAKO_GIT_REAL_CWD: process.argv[3] ?? "",
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Git workbench evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_GIT_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const fixture = (code) =>
    evaluate(
      `import('/src/dev/git-workbench-check.tsx').then(m => { ${code} })`
    )
  const capture = async (name, sidebar = false) => {
    await evaluate(
      "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))"
    )
    const rectangle = sidebar ? await evaluate("(() => { const aside=document.querySelector('aside'); const r=aside.getBoundingClientRect(); const last=aside.querySelector('fieldset')?.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(Math.min(r.height,(last?.bottom ?? r.bottom)-r.y+8))} })()") : undefined
    await writeFile(join(root, name), (await page.capturePage(rectangle)).toPNG())
  }
  const until = async (code) => {
    const end = Date.now() + 15000
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png")
        throw new Error(`Timed out: ${code}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const click = async (selector) => {
    await evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    const point = await evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if(!el)throw new Error('Missing target'); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`
    )
    for (const type of ["mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        ...point,
      })
  }
  const timer = setTimeout(() => app.exit(1), 90000)
  try {
    await window.loadURL(
      `${process.env.MAKO_GIT_CHECK_URL}scripts/git-workbench.html`
    )
    await until(
      "document.querySelector('[data-change-list]')?.dataset.rowCount === '13000'"
    )
    assert.ok(
      await evaluate(
        "document.querySelectorAll('[data-change-row]').length < 80"
      )
    )
    assert.equal(
      await fixture("return m.calls.diffs"),
      0,
      "Opening Changes must not eagerly load a file"
    )
    await capture("large-changes.png")
    await evaluate(
      "document.querySelector('[data-change-list]').scrollTop = 13000 * 24"
    )
    await until(
      "Boolean(document.querySelector('[aria-label=\"Stage file-12999.ts\"]'))"
    )
    await click('[aria-label="Stage file-12999.ts"]')
    await until(
      "document.querySelector('[aria-label=\"Unstage file-12999.ts\"]')?.getAttribute('aria-busy') === 'false'"
    )
    assert.equal(await fixture("return m.calls.stages"), 1)
    await capture("last-file-staged.png")
    const frames = await evaluate(
      "new Promise(resolve => { let last=performance.now(), worst=0, count=0; const tick=()=>{const now=performance.now();worst=Math.max(worst,now-last);last=now;if(++count===15)resolve(worst);else requestAnimationFrame(tick)};requestAnimationFrame(tick) })"
    )
    assert.ok(
      frames < 150,
      `Renderer stalled with a large change list: ${frames}ms`
    )
    assert.equal(
      await evaluate(
        "document.querySelectorAll('[data-push-control] button[aria-label=\"Push to main\"]').length"
      ),
      1
    )
    assert.equal(
      await evaluate(
        "document.querySelectorAll('button[aria-label=\"Push to main\"]').length"
      ),
      1
    )
    assert.ok(
      await evaluate(
        "document.querySelector('[aria-label=\"Commit message\"]').getBoundingClientRect().height >= 64"
      )
    )
    await click('[aria-label="Push to main"]')
    await until(
      "document.querySelector('[data-push-state=pushing]')?.disabled === true"
    )
    assert.equal(await fixture("return m.calls.pushes"), 1)
    await capture("pushing.png")
    await fixture("m.finishPush('/fixture/large', true)")
    await until(
      "document.querySelector('[data-push-control]')?.textContent.includes('Pushed')"
    )
    await capture("pushed.png")
    await fixture("m.resolveHistory('/fixture/large')")
    await until(
      "document.querySelector('[data-history-panel]')?.textContent.includes('Commit from /fixture/large')"
    )
    await fixture("m.startSwitch('/fixture/second')")
    await until("document.querySelectorAll('.git-loading').length >= 2")
    assert.equal(
      await evaluate(
        "document.querySelector('[data-history-panel]').textContent.includes('Commit from /fixture/large')"
      ),
      false
    )
    await capture("switching-project.png")
    await fixture("m.finishSwitch('/fixture/second', 4)")
    await until(
      "document.querySelector('[data-change-list]')?.dataset.rowCount === '4'"
    )
    assert.equal(
      await evaluate(
        "document.querySelector('[data-history-panel]').textContent.includes('Commit from /fixture/large')"
      ),
      false
    )
    await fixture("m.resolveHistory('/fixture/second')")
    await until(
      "document.querySelector('[data-history-panel]').textContent.includes('Commit from /fixture/second')"
    )
    await click('[aria-label="Push to main"]')
    await until("Boolean(document.querySelector('[data-push-state=pushing]'))")
    await fixture("m.selectProject('/fixture/third', 3)")
    assert.equal(
      await evaluate(
        "Boolean(document.querySelector('[data-push-state=pushing]'))"
      ),
      false,
      "A push must not paint another project's button"
    )
    await fixture("m.finishPush('/fixture/second', false)")
    await fixture("m.selectProject('/fixture/second', 4)")
    await until(
      "document.querySelector('[data-push-control]')?.textContent.includes('Push 2')"
    )
    await capture("push-failed.png")
    assert.equal(await evaluate("document.body.textContent.includes('Retry push')"), false)
    await fixture("m.incoming('/fixture/second')")
    await until("Boolean(document.querySelector('[aria-label=\"Pull and merge 3 incoming commits\"]'))")
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Push to main\"]').disabled"), true)
    window.setContentSize(1200, 400)
    await capture("pull-before-push.png", true)
    window.setContentSize(1200, 900)
    await click('[aria-label="Pull and merge 3 incoming commits"]')
    await until("document.querySelector('[data-push-control]')?.textContent.includes('Push 3')")
    await capture("merged-ready-to-push.png", true)
    await click('[aria-label="Push to main"]')
    await until("Boolean(document.querySelector('[data-push-state=pushing]'))")
    await page.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    })
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('[data-push-state=pushing] > svg')).animationName"
      ),
      "none"
    )
    await fixture("m.finishPush('/fixture/second', true)")
    await until(
      "document.querySelector('[data-push-control]')?.textContent.includes('Pushed')"
    )
    await fixture("m.selectProject('/fixture/commit', 3)")
    await until(
      "Boolean(document.querySelector('[aria-label=\"Commit message\"]'))"
    )
    await click('[aria-label="Commit message"]')
    await page.debugger.sendCommand("Input.insertText", {
      text: "Keep the full change set",
    })
    const submit = await evaluate(
      "[...document.querySelectorAll('[data-commit-box] button')].find(b=>b.textContent.startsWith('Commit all'))?.outerHTML"
    )
    assert.ok(submit)
    await evaluate(
      "[...document.querySelectorAll('[data-commit-box] button')].find(b=>b.textContent.startsWith('Commit all')).setAttribute('data-test-commit','')"
    )
    await click("[data-test-commit]")
    await until(
      "document.querySelector('[data-commit-box]').textContent.includes('Committing')"
    )
    await until(
      "document.querySelector('[aria-label=\"Commit message\"]')?.placeholder === 'Nothing to commit' && document.querySelector('[aria-label=\"Commit message\"]').disabled"
    )
    assert.equal(await fixture("return m.calls.commits"), 1)
    await capture("committed.png")
    window.setContentSize(1200, 360)
    await fixture("m.incoming('/fixture/commit', true)")
    await until("document.body.textContent.includes('Continue merge')")
    assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Continue merge').disabled"), true)
    await capture("merge-conflicts.png", true)
    window.setContentSize(1200, 560)
    await fixture("m.selectMultiRepositoryProject()")
    await until("document.querySelectorAll('section > button[aria-expanded]').length === 2")
    assert.equal(await evaluate("document.body.textContent.includes('Repositories')"), false)
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Changes in mako\"] [data-change-list]')?.dataset.rowCount"), "12")
    assert.equal(await evaluate("document.querySelectorAll('[data-commit-box]').length"), 1)
    assert.ok(await evaluate("document.querySelector('button[aria-label=mako-backend]').getBoundingClientRect().top < 650"), "The next repository follows content instead of being pushed to the panel bottom")
    await capture("repositories-app.png", true)
    await click('button[aria-label="mako"]')
    await until("document.querySelector('button[aria-label=mako]').getAttribute('aria-expanded') === 'false'")
    assert.equal(await evaluate("document.querySelectorAll('[data-commit-box]').length"), 1)
    await click('button[aria-label="mako"]')
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '12'")
    await click('button[aria-label="mako-backend"]')
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '1'")
    assert.equal(await fixture("return m.calls.selections"), 1)
    assert.equal(await evaluate("import('/src/state/session.ts').then(m=>m.store.get().meta.cwd)"), "/fixture/mono")
    assert.equal(await evaluate("document.querySelector('button[aria-label=mako-backend]').getAttribute('aria-expanded') === 'true'"), true)
    assert.equal(await evaluate("document.querySelectorAll('[data-commit-box]').length"), 1)
    await capture("repositories-backend.png", true)
    await click('button[aria-label="mako"]')
    await until("document.querySelector('[data-change-list]')?.dataset.rowCount === '12'")
    assert.equal(await evaluate("import('/src/state/session.ts').then(m=>m.store.get().meta.cwd)"), "/fixture/mono")
    console.log("Repository selection: switches both ways, keeps the workspace, and shows one shared commit box")
    console.log(
      "Git UI: 13,000 files with bounded DOM, last-file staging, frame responsiveness, one Push control, pending/success/failure with counts, pull/merge/conflicts, project isolation, history skeletons, commit feedback and reduced motion passed; fixture transport only, no remote pushes"
    )
    if (process.env.MAKO_GIT_REAL_URL && process.env.MAKO_GIT_REAL_CWD) {
      await window.loadURL(process.env.MAKO_GIT_REAL_URL)
      await until("Boolean(document.querySelector('.composer-input'))")
      const started = Date.now()
      await evaluate(
        `import('/src/state/session.ts').then(({actions}) => actions.openWorkspace(${JSON.stringify(process.env.MAKO_GIT_REAL_CWD)}))`
      )
      if (
        await evaluate(
          "Boolean(document.querySelector('[aria-label=\"Show the right sidebar\"]'))"
        )
      )
        await click('[aria-label="Show the right sidebar"]')
      await click('[data-surface-id="changes"]')
      await until("Boolean(document.querySelector('[data-change-list]'))")
      const metrics = await evaluate(
        "({rows:Number(document.querySelector('[data-change-list]').dataset.rowCount), mounted:document.querySelectorAll('[data-change-row]').length})"
      )
      assert.ok(metrics.mounted < 100)
      console.log(
        JSON.stringify({ realProjectMs: Date.now() - started, ...metrics })
      )
      await capture("real-project-changes.png")
      await evaluate(
        "document.querySelector('[data-change-list]').scrollTop = document.querySelector('[data-change-list]').scrollHeight"
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok(
        await evaluate(
          "document.querySelectorAll('[data-change-row]').length < 100"
        )
      )
      await capture("real-project-last-files.png")
      const repositories = await evaluate("import('/src/state/session.ts').then(m => m.store.get().git?.repositories ?? [])")
      for (const repository of [...repositories].reverse()) {
        const selector = `button[aria-label=${JSON.stringify(repository.label)}]`
        await click(selector)
        await until(`import('/src/state/session.ts').then(m => m.store.get().git?.root === ${JSON.stringify(repository.root)} && Boolean(document.querySelector('[data-change-list]')))`)
        const selected = await evaluate("import('/src/state/session.ts').then(m => ({cwd:m.store.get().git?.cwd,root:m.store.get().git?.root,files:m.store.get().git?.files.length}))")
        assert.equal(selected.root, repository.root)
        assert.equal(selected.cwd, process.env.MAKO_GIT_REAL_CWD)
        assert.equal(await evaluate("document.querySelectorAll('[data-commit-box]').length"), 1)
        assert.equal(await evaluate("document.body.textContent.includes('Choose a repository in the current workspace')"), false)
        await capture(`real-repository-${repository.label}.png`)
        console.log(JSON.stringify({realRepository: repository.label, ...selected}))
      }
      console.log(
        "Real project inspected read-only: no staging, committing or pushing"
      )
    }
  } finally {
    clearTimeout(timer)
    app.quit()
  }
}
