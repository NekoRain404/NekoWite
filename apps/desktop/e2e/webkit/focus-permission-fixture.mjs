import { until } from './webdriver.mjs'
import { clickSelector, typeInto } from './agent-scroll-driver.mjs'

/** An isolated focus run must not depend on the earlier scroll probe's permission request. */
export async function ensureFocusPermission(wd) {
  if (await wd.execute("return Boolean(document.querySelector('.agent-perm-args'))")) {
    return { alreadyOpen: true }
  }
  let runId = await wd.execute('return window.__NEKO_AGENT__.runId()')
  if (runId === null) {
    const typed = await typeInto(wd, '.agent-composer-field', 'focus probe')
    if (!typed.ok) throw new Error(`could not start permission fixture: ${typed.why}`)
    await clickSelector(wd, '.agent-composer [data-action="send"]')
    await until(() => wd.execute('return window.__NEKO_AGENT__.runId() !== null'), {
      timeout: 10_000, what: 'the focus fixture turn to start',
    })
    runId = await wd.execute('return window.__NEKO_AGENT__.runId()')
  }
  await wd.execute(
    "return window.__nkwAskPermission({ requestId: 'focus-permission', prefix: 'focus', runId: arguments[0] })",
    [runId],
  )
  await until(() => wd.execute("return Boolean(document.querySelector('.agent-perm-args'))"), {
    timeout: 5000, what: 'permission arguments for the focus probe',
  })
  return { runId, mounted: true }
}
