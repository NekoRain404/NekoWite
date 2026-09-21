import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebDriver, freePort, sleep, until } from './webkit/webdriver.mjs'

// Run from any directory: BIN=/absolute/fresh/nekowite node apps/desktop/e2e/native-beta-smoke.mjs
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const binary = await realpath(process.env.BIN || join(root, 'apps/desktop/src-tauri/target/release/nekowite'))
await access(binary, constants.X_OK)
const outputRoot = join(root, 'test-results/native-beta-smoke')
await mkdir(outputRoot, { recursive: true })
const scratch = await mkdtemp(join(outputRoot, 'run-'))
// Unix socket paths are limited to 107 bytes; deeply nested artifact paths
// prevented desktop portals from starting even when the editor smoke passed.
await mkdir(join(root, 'target'), { recursive: true })
const profile = await mkdtemp(join(root, 'target/n.'))
const env = { ...process.env, GDK_BACKEND: 'x11', WEBKIT_DISABLE_DMABUF_RENDERER: '1' }
for (const [key, directory] of Object.entries({
  XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache',
  XDG_STATE_HOME: 'state', XDG_RUNTIME_DIR: 'r', TMPDIR: 'tmp',
})) {
  env[key] = join(profile, directory)
  await mkdir(env[key])
}
await chmod(env.XDG_RUNTIME_DIR, 0o700)
const vault = join(scratch, 'vault')
await mkdir(vault)
const seed = join(vault, 'seed.md')
await writeFile(seed, '# Native smoke seed\n')
const port = await freePort()
const nativePort = await freePort()
assert.ok(port && nativePort && port !== nativePort, 'Two distinct free ports are required')
const driver = spawn('dbus-run-session', ['--', 'xvfb-run', '-a', '-s', '-screen 0 1280x820x24',
  process.env.TAURI_DRIVER || 'tauri-driver', '--port', String(port), '--native-port', String(nativePort),
  '--native-driver', '/usr/bin/WebKitWebDriver'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let driverLog = ''
driver.stdout.on('data', (chunk) => { driverLog += chunk })
driver.stderr.on('data', (chunk) => { driverLog += chunk })
let spawnError
driver.on('error', (error) => { spawnError = error })
const wd = new WebDriver(port)
const elementKey = 'element-6066-11e4-a52e-4f735466cecf'
let phase = 'start session'

async function element(css) {
  return until(async () => {
    const result = await wd.execute('return document.querySelector(arguments[0])', [css])
    return result?.[elementKey]
  }, { what: css })
}

async function click(css) { await wd.clickElement(await element(css)) }

async function selectMainWindow() {
  // The desktop pet may become WebKit's initial automation window.
  const endpoint = `http://127.0.0.1:${port}/session/${wd.sessionId}`
  await until(async () => {
    const response = await fetch(`${endpoint}/window/handles`)
    const { value: handles } = await response.json()
    assert.ok(response.ok && Array.isArray(handles), 'Cannot list native windows')
    for (const handle of handles) {
      const switched = await fetch(`${endpoint}/window`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle }),
      })
      assert.ok(switched.ok, 'Cannot switch native window')
      if (await wd.execute('return !!document.querySelector(".tab-bar")')) return true
    }
    return false
  }, { what: 'main application window' })
}

async function clickText(css, text) {
  const id = await until(async () => {
    const result = await wd.execute('return [...document.querySelectorAll(arguments[0])].find(e => e.textContent.trim() === arguments[1])', [css, text])
    return result?.[elementKey]
  }, { what: `${css}: ${text}` })
  await wd.clickElement(id)
}

async function save() {
  await wd.performActions([{ type: 'key', id: 'keyboard', actions: [
    { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: 's' },
    { type: 'keyUp', value: 's' }, { type: 'keyUp', value: '\uE009' },
  ] }])
  await wd.releaseActions()
}

const source = '[data-testid="source-pane"] .cm-content'
const note = join(vault, 'native-smoke.md')
const marker = `native-smoke-${Date.now()}`
try {
  if (spawnError) throw spawnError
  await wd.session({ 'tauri:options': { application: binary, args: [seed] } })
  await selectMainWindow()
  phase = 'open seed through native launch argument'
  await element('.pane.rendered .ProseMirror')
  assert.equal(await wd.execute('return typeof window.__TAURI_INTERNALS__.invoke'), 'function')
  phase = 'create note through file tree'
  await clickText('.nav-item', '文件夹')
  await click('.tree-tool[title="新建文件"]')
  await wd.typeInto(await element('.tree-inline-input'), 'native-smoke.md\uE007')
  await until(() => wd.execute('return document.querySelector(".tab.active .tab-name")?.textContent === "native-smoke.md"'), { what: 'created note active' })
  phase = 'edit and save through native input'
  await clickText('.switch-option', '源码')
  await wd.typeInto(await element(source), marker)
  await save()
  await until(async () => {
    try { return (await readFile(note, 'utf8')).includes(marker) } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }, { what: 'saved bytes on real filesystem' })
  const saved = await readFile(note, 'utf8')
  phase = 'close and reopen saved note'
  await click('.tab.active .tab-close')
  await until(() => wd.execute('return ![...document.querySelectorAll(".tab-name")].some(e => e.textContent === "native-smoke.md")'), { what: 'note tab closed' })
  await click(`.tree-name[title=${JSON.stringify(note)}]`)
  await clickText('.switch-option', '源码')
  await until(() => wd.execute('return document.querySelector(arguments[0])?.textContent.includes(arguments[1])', [source, marker]), { what: 'reopened editor contains saved bytes' })
  assert.equal(await readFile(note, 'utf8'), saved)
  phase = 'restart application and read saved note from disk'
  await wd.quit()
  await wd.session({ 'tauri:options': { application: binary, args: [note] } })
  await selectMainWindow()
  await until(() => wd.execute('return document.querySelector(".tab.active .tab-name")?.textContent === "native-smoke.md"'), { what: 'restarted application opened saved note' })
  await clickText('.switch-option', '源码')
  await until(() => wd.execute('return document.querySelector(arguments[0])?.textContent.includes(arguments[1])', [source, marker]), { what: 'restarted editor contains saved bytes' })
  assert.equal(await readFile(note, 'utf8'), saved)
  phase = 'capture screenshot'
  const png = await wd.screenshot()
  assert.ok(png, 'Native WebDriver must provide a screenshot')
  await writeFile(join(scratch, 'saved-reopened.png'), Buffer.from(png, 'base64'))
  assert.ok(!driverLog.includes('exceeds 108 bytes'), 'Native runtime socket path exceeds Linux limit')
  const report = { status: 'PASS', binary, binaryMtime: (await stat(binary)).mtime.toISOString(), scratch, profile, note, marker, saved, applicationRestart: true }
  await writeFile(join(scratch, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  const png = await wd.screenshot()
  if (png) await writeFile(join(scratch, 'failure.png'), Buffer.from(png, 'base64'))
  console.error(`FAIL during ${phase}; artifacts: ${scratch}`, error)
  process.exitCode = 1
} finally {
  await wd.quit()
  // Only this detached process group belongs to the probe; never match app names.
  if (driver.pid) {
    try { process.kill(-driver.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await Promise.race([once(driver, 'exit'), sleep(1000)])
    try { process.kill(-driver.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await writeFile(join(scratch, 'driver.log'), driverLog)
  await writeFile(join(scratch, 'webdriver.json'), JSON.stringify(wd.log, null, 2))
}
