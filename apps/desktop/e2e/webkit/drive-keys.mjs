/**
 * The keyboard shortcuts the guide documents, on the shipping engine.
 *
 * `Ctrl+S` is read by the save stage. The other one with an observable effect is `Ctrl+K`: the command palette,
 * the app's main navigation affordance. A binding that a webview or a focus scope swallows looks exactly like a
 * key nobody pressed, and the palette is the one documented shortcut whose *effect* is a real search over the
 * vault, so it can be read rather than only observed.
 *
 * **The query is the file name, and that is the app's contract rather than a convenience.** `fileEntryOf`
 * labels a file row with the basename and offers the directory as its hint and its other keyword
 * (`command-palette-logic.ts`), so the palette searches paths while the note tree shows the note's *title* (its
 * H1). The first version of this stage typed the title and read 「无匹配结果」 — the app behaving as written and
 * the probe expecting the wrong thing. Both readings are taken now: the file name is asserted, the title is
 * recorded, so a future palette that does search titles changes a reading instead of failing an assertion
 * nobody asked for.
 *
 * Split out of `drive-app.mjs`, which owns the session and supplies the driver calls and the keyboard.
 */
import { until } from './webdriver.mjs'

/**
 * Open the palette, find the open file by name, ask the same question with the title, and close it again.
 *
 * `pressKey` and `typeText` come from the probe that owns the session, so every key here is a real key event.
 */
export async function checkDocumentedShortcuts({ run, script, typeText, pressKey, readings, noteTitle, fileName }) {
  await pressKey('k', { ctrl: true })
  readings.paletteOpened = await until(
    async () =>
      (await run('POST', '/execute/sync', script('return document.querySelector(".palette-overlay.is-open") ? true : null')).catch(
        () => null,
      ))
        ? true
        : null,
    { timeout: 8_000, what: 'the command palette to open on Ctrl+K' },
  ).catch(() => false)
  // The palette owns the keyboard while it is open.
  readings.paletteFocused = await run(
    'POST',
    '/execute/sync',
    script('return Boolean(document.activeElement && document.activeElement.classList.contains("palette-input"))'),
  ).catch(() => false)

  const paletteState = () =>
    run(
      'POST',
      '/execute/sync',
      script(`const input = document.querySelector('.palette-input')
        const palette = document.querySelector('.palette')
        return {
          typed: input ? input.value : null,
          text: (palette ? palette.innerText : '').replace(/\\s+/g, ' ').slice(0, 200),
        }`),
    ).catch((e) => ({ unreadable: String(e?.message ?? e).slice(0, 140) }))

  await typeText(fileName)
  readings.paletteFileNameSearch = await until(
    async () => {
      const seen = await paletteState()
      return String(seen?.typed ?? '') === fileName && String(seen?.text ?? '').includes(fileName) ? seen.text : null
    },
    { timeout: 8_000, what: 'the palette to find the open file by its name' },
  ).catch(() => null)

  // Cleared with real backspaces and re-queried with the title, so the difference is the query alone.
  for (let i = 0; i < fileName.length; i += 1) await pressKey('\uE003')
  await typeText(noteTitle)
  readings.paletteTitleSearch = await until(
    async () => {
      const seen = await paletteState()
      return String(seen?.typed ?? '') === noteTitle ? seen.text : null
    },
    { timeout: 8_000, what: 'the palette to answer the title query' },
  ).catch(() => null)

  await pressKey('\uE00C')
  readings.paletteClosed = await until(
    async () =>
      (await run('POST', '/execute/sync', script('return document.querySelector(".palette-overlay.is-open") ? null : true')).catch(
        () => null,
      ))
        ? true
        : null,
    { timeout: 8_000, what: 'the palette to close on Esc' },
  ).catch(() => false)
}
