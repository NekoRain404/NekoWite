import { describe, expect, it } from 'vitest'
import { roundTrip } from './serialize'

/**
 * Save-path robustness corpus.
 *
 * `roundTrip` is what every Ctrl+S ultimately runs, so any input it is not
 * idempotent on is a save-time corruption risk: the second save of an
 * unmodified document would differ from the first. Rather than asserting a
 * specific canonical form (which pins intended canonicalizations as failures),
 * these cases assert the ONE property that must always hold:
 *
 *     roundTrip(roundTrip(x)) === roundTrip(x)
 *
 * A separate table then checks that the content a reader would notice — words,
 * numbers, urls, code — survives the trip in the form the author typed.
 */

/** Documents that exercise a distinct parsing or serialization path. */
const CORPUS: Array<[string, string]> = [
  ['empty', ''],
  ['whitespace only', '   \n\n\t\n'],
  ['plain paragraph', 'just some words\n'],
  ['no trailing newline', 'no newline at the end'],
  ['crlf', 'a\r\n\r\nb\r\n'],
  ['setext h1', 'Title\n=====\n\nbody\n'],
  ['setext h2', 'Title\n-----\n\nbody\n'],
  ['atx with closing hashes', '## Heading ##\n'],
  ['heading with emphasis', '# *em* and **strong**\n'],
  ['heading levels 1-6', '# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f\n'],
  ['emphasis variants', '*a* _b_ **c** __d__ ***e*** ___f___\n'],
  ['intraword underscores', 'foo_bar_baz and snake_case_name\n'],
  ['escaped emphasis', '\\*not em\\* and \\_not em\\_\n'],
  ['strikethrough', '~~gone~~\n'],
  ['inline code with backtick', 'a ``code with ` tick`` b\n'],
  ['inline code with spaces', '` padded `\n'],
  ['hard break by spaces', 'line one  \nline two\n'],
  ['hard break by backslash', 'line one\\\nline two\n'],
  ['bullet list', '- a\n- b\n'],
  ['star list', '* a\n* b\n'],
  ['plus list', '+ a\n+ b\n'],
  ['ordered list', '1. a\n2. b\n'],
  ['ordered list paren', '1) a\n2) b\n'],
  ['ordered start offset', '3. a\n4. b\n'],
  ['loose list', '- a\n\n- b\n'],
  ['nested list', '- a\n  - b\n    - c\n'],
  ['nested ordered in bullet', '- a\n  1. one\n  2. two\n'],
  ['item with two paragraphs', '- first\n\n  second\n'],
  ['item with code block', '- item\n\n  ```js\n  const a = 1\n  ```\n'],
  ['task list', '- [x] done\n- [ ] todo\n'],
  ['task list nested', '- [x] a\n  - [ ] b\n'],
  ['blockquote', '> quoted\n> more\n'],
  ['nested blockquote', '> outer\n>\n> > inner\n'],
  ['blockquote with list', '> - a\n> - b\n'],
  ['thematic break', 'a\n\n---\n\nb\n'],
  ['thematic break stars', 'a\n\n***\n\nb\n'],
  ['fenced code', '```js\nconst a = 1\n```\n'],
  ['fenced code tildes', '~~~js\nconst a = 1\n~~~\n'],
  ['fenced code no lang', '```\nraw\n```\n'],
  ['fenced code containing fence', '````\n```\n````\n'],
  ['indented code', '    indented code\n'],
  ['table', '| a | b |\n| - | - |\n| 1 | 2 |\n'],
  ['table alignment', '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n'],
  ['table escaped pipe', '| a | b |\n| - | - |\n| x \\| y | 2 |\n'],
  ['table with empty cells', '| a | b |\n| - | - |\n|  |  |\n'],
  ['link inline', '[text](https://x.test/a)\n'],
  ['link with title', '[text](https://x.test "Title")\n'],
  ['link with angle url', '[text](<https://x.test/a b>)\n'],
  ['link with emphasis inside', '[**bold** link](https://x.test)\n'],
  ['reference link', '[text][ref]\n\n[ref]: https://x.test "T"\n'],
  ['collapsed reference link', '[ref][]\n\n[ref]: https://x.test\n'],
  ['shortcut reference link', '[ref]\n\n[ref]: https://x.test\n'],
  ['autolink', '<https://x.test/a>\n'],
  ['image', '![alt](https://x.test/a.png)\n'],
  ['image with title', '![alt](https://x.test/a.png "T")\n'],
  ['image with dimensions', '![alt](https://x.test/a.png){width=320}\n'],
  ['wikilink', 'see [[Other Note]] here\n'],
  ['wikilink alias', 'see [[Other Note|alias]] here\n'],
  ['highlight', 'a ==marked== b\n'],
  ['inline math', 'text $a^2$ more\n'],
  ['display math', '$$\nE = mc^2\n$$\n'],
  ['footnote', 'Note[^1]\n\n[^1]: The definition\n'],
  ['citation', 'claim [@smith2020]\n'],
  ['html block', '<div class="x">\nfoo\n</div>\n'],
  ['inline html', 'a <span style="color: red">x</span> b\n'],
  ['entity', 'AT&amp;T and &copy; 2026\n'],
  ['mdx self-closing', '<Callout type="info" />\n'],
  ['mdx with children', '<Callout title="Note">\n\nbody\n\n</Callout>\n'],
  ['mdx expression prop', '<Chart data={[1, 2, 3]} />\n'],
  ['mdx unquoted prop', '<Callout type=info />\n'],
  ['mdx prop with gt', '<Callout hint="a > b" />\n'],
  ['frontmatter only', '---\ntitle: T\n---\n'],
  ['frontmatter and body', '---\ntitle: T\ntags:\n  - a\n  - b\n---\n\n# H\n'],
  ['frontmatter with colon value', '---\ntitle: "a: b"\n---\n\nbody\n'],
  ['cjk text', '这是一段中文文本，包含标点。\n'],
  ['emoji', 'a 🐱 b 🎉\n'],
  ['combining marks', 'e\u0301 cafe\u0301\n'],
  ['lone dollar', 'Cost is $5 and $19.99\n'],
  ['backslash heavy', 'a \\\\ b \\* c\n'],
  ['long line', 'x'.repeat(5000) + '\n'],
  ['many blank lines', 'a\n\n\n\n\nb\n'],
  ['trailing spaces', 'a   \n'],
  ['windows path in code', '```\nC:\\Users\\a\\b.txt\n```\n'],
  ['nested emphasis in list', '- *a* and **b**\n'],
  ['full document', [
    '---',
    'title: Full',
    '---',
    '',
    '# Heading',
    '',
    'Body with *em*, **strong**, `code`, a [link](https://x.test/a) and $x^2$.',
    '',
    '- [x] done',
    '- item',
    '',
    '> quoted',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
  ].join('\n')],
]

describe('roundTrip is idempotent over the save-path corpus', () => {
  it('reports every non-idempotent case at once', () => {
    const unstable: Array<{ name: string; once: string; twice: string }> = []
    for (const [name, md] of CORPUS) {
      let once: string
      try {
        once = roundTrip(md)
      } catch (e) {
        unstable.push({ name, once: `THREW: ${String(e)}`, twice: '' })
        continue
      }
      let twice: string
      try {
        twice = roundTrip(once)
      } catch (e) {
        unstable.push({ name, once, twice: `THREW: ${String(e)}` })
        continue
      }
      if (twice !== once) unstable.push({ name, once, twice })
    }
    expect(unstable).toEqual([])
  })
})

/**
 * Content that must survive: the check is written per-case because "survives"
 * means something different for a table row than for a code fence.
 */
const PRESERVED: Array<[string, string, string[]]> = [
  ['plain paragraph', 'alpha beta gamma\n', ['alpha beta gamma']],
  ['heading text', '# The Heading\n', ['The Heading']],
  ['task list state', '- [x] done\n- [ ] todo\n', ['[x]', '[ ]', 'done', 'todo']],
  ['inline math latex', 'text $a^2 + b^2$ more\n', ['$a^2 + b^2$']],
  ['display math latex', '$$\nE = mc^2\n$$\n', ['$$', 'E = mc^2']],
  ['footnote label and body', 'Note[^1]\n\n[^1]: The definition\n', ['[^1]', 'The definition']],
  ['wikilink target', 'see [[Other Note|alias]]\n', ['[[Other Note|alias]]']],
  ['highlight delimiters', 'a ==marked== b\n', ['==marked==']],
  ['citation key', 'claim [@smith2020]\n', ['@smith2020']],
  ['table cell values', '| a | b |\n| - | - |\n| 1 | 2 |\n', ['| a | b |', '| 1 | 2 |']],
  // remark-stringify re-spaces a table delimiter row; the alignment itself
  // (`:-` left / `-:` right) is what must survive, not the original padding.
  ['aligned table separators', '| a | b |\n|:--|--:|\n| 1 | 2 |\n', [':-', '-:']],
  ['fenced code body', '```js\nconst a = 1\n```\n', ['```js', 'const a = 1']],
  ['tilde fence body', '~~~js\nconst a = 1\n~~~\n', ['const a = 1']],
  ['reference definition', '[text][ref]\n\n[ref]: https://x.test "T"\n', ['[ref]: https://x.test', 'T']],
  ['autolink', '<https://x.test/a>\n', ['https://x.test/a']],
  ['image alt and url', '![alt text](https://x.test/a.png)\n', ['alt text', 'https://x.test/a.png']],
  ['image dimensions', '![alt](https://x.test/a.png){width=320}\n', ['width=320']],
  ['frontmatter keys', '---\ntitle: T\ntags:\n  - a\n---\n\nbody\n', ['title: T', '- a', 'body']],
  ['mdx props', '<Callout type="info" hint="a > b" />\n', ['Callout', 'type="info"', 'hint="a > b"']],
  ['mdx children', '<Callout title="Note">\n\nbody\n\n</Callout>\n', ['<Callout title="Note">', 'body', '</Callout>']],
  ['inline code content', 'a `x < y` b\n', ['x < y']],
  ['html block', '<div class="x">\nfoo\n</div>\n', ['<div class="x">', 'foo', '</div>']],
  // An entity is decoded and re-escaped as its backslash form, which renders as
  // the same `&` and is stable on re-save (checked by the idempotence cases).
  ['entity', 'AT&amp;T\n', ['AT\\&T']],
  ['cjk', '这是中文\n', ['这是中文']],
  ['emoji', 'a 🐱 b\n', ['🐱']],
  ['escaped asterisks', '\\*not em\\*\n', ['\\*not em\\*']],
  // Underscores that GFM would not treat as emphasis are escaped on output;
  // the rendered text is unchanged and the escaped form is stable.
  ['intraword underscore', 'foo_bar_baz\n', ['foo\\_bar\\_baz']],
  ['hard break backslash', 'a\\\nb\n', ['a\\']],
  ['nested list depth', '- a\n  - b\n    - c\n', ['- a', '- b', '- c']],
  ['ordered start', '3. a\n4. b\n', ['3.', '4.']],
  ['blockquote', '> quoted\n', ['> quoted']],
  ['link title', '[t](https://x.test "T")\n', ['https://x.test', 'T']],
  ['wide unicode', '\u{1f1e8}\u{1f1f3} flag\n', ['\u{1f1e8}\u{1f1f3}']],
]

describe('roundTrip preserves the content the author typed', () => {
  it('reports every dropped fragment at once', () => {
    const missing: Array<{ name: string; out: string; fragment: string }> = []
    for (const [name, md, fragments] of PRESERVED) {
      let out: string
      try {
        out = roundTrip(md)
      } catch (e) {
        missing.push({ name, out: `THREW: ${String(e)}`, fragment: '(no output)' })
        continue
      }
      for (const fragment of fragments) {
        if (!out.includes(fragment)) missing.push({ name, out, fragment })
      }
    }
    expect(missing).toEqual([])
  })
})
