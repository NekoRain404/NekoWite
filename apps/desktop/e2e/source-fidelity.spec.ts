import { expect, test, type Page } from '@playwright/test'
import { diskFiles, openNote, showSource, sourceDoc } from './support/editorHarness'

/**
 * What an open → save round trip does to the bytes on disk.
 *
 * The rendered editor is authoritative for the document text: opening a note
 * loads the file into the ProseMirror model and the tab adopts the model's
 * Markdown. That is why the source pane can show a form that differs from the
 * file. Two consequences are pinned here, because both are the kind of thing
 * that is only ever noticed after it has changed:
 *
 *  1. PRESERVED — for these constructs the file is byte-identical after a
 *     no-op save, so opening and reflexively pressing Ctrl+S is safe.
 *  2. CANONICALIZED — for these the app rewrites the file into its canonical
 *     spelling even though nothing was edited. No content is lost in any of
 *     them (verified case by case), but the bytes change. These are recorded as
 *     the CURRENT contract rather than asserted away, so a change in the
 *     normalizer surfaces here instead of in someone's notes.
 *
 * "Keep the original bytes until the user actually edits" is a different, much
 * larger change: it needs the raw text kept alongside the model and a rule for
 * partial preservation. It is deliberately not attempted here.
 */

const NOTE = 'test-fixtures/welcome.md'

async function save(page: Page): Promise<void> {
  await page.keyboard.press('Control+s')
  await expect
    .poll(
      async () => page.locator('.tab.active .save-dot').getAttribute('data-state'),
      { timeout: 5000 },
    )
    .toBe('saved')
}

const PRESERVED: Array<[string, string]> = [
  ['frontmatter and body', '---\ntitle: T\ntags:\n  - a\n---\n\n# H\n\nbody\n'],
  ['frontmatter with colon value', '---\ntitle: "a: b"\n---\n\nbody\n'],
  ['bold link', '[**bold** link](https://x.test)\n'],
  ['task list', '- [x] done\n- [ ] todo\n'],
  ['footnote', 'Note[^1]\n\n[^1]: The definition\n'],
  ['jsx in a heading', '# Title <Callout />\n\nbody\n'],
  ['jsx inline in emphasis', 'alpha *em <Callout />* bravo\n'],
  ['math', 'inline $a^2$ and\n\n$$\nE = mc^2\n$$\n'],
  ['cjk and emoji', '中文 🐱 混合 English\n'],
  ['fenced code with a language', '```js\nconst a = 1\n```\n'],
  ['nested list', '- a\n  - b\n'],
  ['blockquote', '> quoted\n'],
  ['autolink', '<https://x.test/a>\n'],
  ['image', '![alt](https://x.test/a.png)\n'],
  ['wikilink', 'see [[Other Note|alias]] here\n'],
  ['highlight', 'a ==marked== b\n'],
  ['citation', 'claim [@smith2020]\n'],
]

const CANONICALIZED: Array<[string, string, string]> = [
  ['star bullets become dash bullets', '* a\n* b\n', '- a\n- b\n'],
  // [label, input, bytes on disk after a no-op save]
  ['hard break by trailing spaces becomes a backslash break', 'line one  \nline two\n', 'line one\\\nline two\n'],
  ['extra blank lines collapse', 'a\n\n\n\nb\n', 'a\n\nb\n'],
  ['indented code becomes a fenced block', '    a\tb\n', '```\na\tb\n```\n'],
  ['tilde fence becomes a backtick fence', '~~~js\nconst a = 1\n~~~\n', '```js\nconst a = 1\n```\n'],
  ['setext heading becomes an ATX heading', 'Title\n=====\n\nbody\n', '# Title\n\nbody\n'],
  [
    'reference link is inlined and its definition consumed',
    '[text][ref]\n\n[ref]: https://x.test "T"\n',
    '[text](https://x.test "T")\n',
  ],
  ['a missing final newline is added', 'no newline at the end', 'no newline at the end\n'],
  [
    'an empty table cell gains the empty-paragraph marker',
    '| a | b |\n| - | - |\n|  |  |\n',
    '| a      | b      |\n| ------ | ------ |\n| <br /> | <br /> |\n',
  ],
  [
    'table columns are re-padded, alignment preserved',
    '| a | b |\n|:--|--:|\n| 1 | 2 |\n',
    '| a  |  b |\n| :- | -: |\n| 1  |  2 |\n',
  ],
]

test.describe('source pane fidelity', () => {
  for (const [label, doc] of PRESERVED) {
    test(`shows the file unchanged: ${label}`, async ({ page }) => {
      await openNote(page, { doc })
      await showSource(page)
      await expect.poll(() => sourceDoc(page)).toBe(doc)
    })
  }

  for (const [label, doc, expected] of CANONICALIZED) {
    test(`canonicalizes on open: ${label}`, async ({ page }) => {
      await openNote(page, { doc })
      await showSource(page)
      // The source pane shows the model's canonical Markdown, not the file.
      await expect.poll(() => sourceDoc(page)).toBe(expected)
      // ... and a save writes exactly that.
      await save(page)
      expect((await diskFiles(page))[NOTE]).toBe(expected)
    })
  }
})

test.describe('a no-op save does not rewrite a preserved document', () => {
  for (const [label, doc] of PRESERVED) {
    test(`bytes survive Ctrl+S: ${label}`, async ({ page }) => {
      await openNote(page, { doc })
      await showSource(page)
      await save(page)
      expect((await diskFiles(page))[NOTE]).toBe(doc)
    })
  }
})
