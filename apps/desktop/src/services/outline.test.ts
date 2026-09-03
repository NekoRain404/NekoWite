import { describe, expect, it } from 'vitest'
import { parseOutline } from './outline'

describe('parseOutline', () => {
  it('parses multi-level ATX headings with lines and ordinals', () => {
    const md = [
      '# 一级',
      '',
      '正文',
      '## 二级',
      '### 三级',
      '#### 四级',
      '##### 五级',
      '###### 六级',
    ].join('\n')
    const items = parseOutline(md)
    expect(items).toHaveLength(6)
    expect(items[0]).toMatchObject({ level: 1, text: '一级', line: 0, index: 0 })
    expect(items[1]).toMatchObject({ level: 2, text: '二级', line: 3, index: 1 })
    expect(items[2]).toMatchObject({ level: 3, text: '三级', line: 4, index: 2 })
    expect(items[5]).toMatchObject({ level: 6, text: '六级', line: 7, index: 5 })
  })

  it('ignores hash lines inside fenced code blocks', () => {
    const md = [
      '# 标题',
      '```',
      '# 不是标题',
      '## 也不是',
      '```',
      '## 标题二',
    ].join('\n')
    const items = parseOutline(md)
    expect(items.map((i) => i.text)).toEqual(['标题', '标题二'])
    expect(items[1]).toMatchObject({ line: 5, index: 1 })
  })

  it('tracks fence info strings and matching close fences', () => {
    const md = [
      '```js',
      'const s = "# fake"',
      '# 仍然不是标题',
      '```',
      '# 真标题',
      '~~~',
      '# tilde 内不算',
      '~~~',
      '## 结尾',
    ].join('\n')
    const items = parseOutline(md)
    expect(items.map((i) => i.text)).toEqual(['真标题', '结尾'])
    expect(items[0].line).toBe(4)
  })

  it('skips everything after an unclosed fence', () => {
    const md = ['# 开头', '```', '# 被吞掉', '## 也被吞掉'].join('\n')
    expect(parseOutline(md)).toHaveLength(1)
  })

  it('does not treat # without a space as a heading', () => {
    expect(parseOutline('#标签\n##标题')).toEqual([])
  })

  it('strips closing hash sequences and trims text', () => {
    const items = parseOutline('##  标题 ##  ')
    expect(items).toEqual([{ level: 2, text: '标题', line: 0, index: 0 }])
  })

  it('keeps inline hashes and supports empty headings', () => {
    const items = parseOutline('# C# 入门\n###')
    expect(items[0].text).toBe('C# 入门')
    expect(items[1]).toMatchObject({ level: 3, text: '' })
  })

  it('ignores setext headings by design', () => {
    // 说明：Setext 风格（标题下写 === 或 ---）按需求可忽略；此处确认不会
    // 被误判为 ATX 标题，也不会把 --- 当标题。大纲只收录 # 到 ######。
    const md = ['Setext 标题', '===', '普通段', '---', '# Atx'].join('\n')
    const items = parseOutline(md)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ level: 1, text: 'Atx', line: 4 })
  })

  it('ignores headings indented four spaces (indented code)', () => {
    expect(parseOutline('    # 代码不是标题\n# 标题')).toEqual([
      { level: 1, text: '标题', line: 1, index: 0 },
    ])
  })

  it('handles CRLF and empty input', () => {
    expect(parseOutline('# A\r\n## B\r\n')).toEqual([
      { level: 1, text: 'A', line: 0, index: 0 },
      { level: 2, text: 'B', line: 1, index: 1 },
    ])
    expect(parseOutline('')).toEqual([])
  })
})
