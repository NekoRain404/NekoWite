import { test } from '@playwright/test'
import { openNote } from './support/editorHarness'

test('PROBE: where the transition classes land', async ({ page }) => {
  await openNote(page)
  await page.locator('.status-btn').last().click()
  await page.locator('.settings-overlay').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(900)

  await page.evaluate(() => {
    const samples: Array<Record<string, unknown>> = []
    ;(window as unknown as { __samples: typeof samples }).__samples = samples
    const tick = () => {
      const el = document.querySelector<HTMLElement>('.settings-overlay')
      samples.push({
        overlay: el?.className ?? null,
        overlayOpacity: el ? getComputedStyle(el).opacity : null,
        body: document.body.className,
        bodyOpacity: getComputedStyle(document.body).opacity,
        bodyAria: document.body.getAttribute('aria-hidden'),
      })
      if (samples.length < 45) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  const samples = await page.evaluate(
    () => (window as unknown as { __samples: Array<Record<string, unknown>> }).__samples,
  )
  const changes = samples.filter(
    (s, i) => i === 0 || JSON.stringify(s) !== JSON.stringify(samples[i - 1]),
  )
  console.log('SAMPLED ' + samples.length + ' changes ' + JSON.stringify(changes, null, 1))
})
