import { describe, expect, it } from 'vitest'
import { EXPORT_EXTENSIONS, exportBaseName, exportFileName, forceExportExtension } from './export-name'

describe('exportBaseName', () => {
  it('derives base name from path', () => {
    expect(exportBaseName('/vault/notes/hello.md')).toBe('hello')
    expect(exportBaseName('hello.mdx')).toBe('hello')
    expect(exportBaseName(null)).toBe('untitled')
  })

  it('keeps a CJK note name', () => {
    expect(exportBaseName('/vault/笔记/长篇导出测试.md')).toBe('长篇导出测试')
  })
})

describe('exportFileName', () => {
  it('follows the format rather than a constant', () => {
    expect(exportFileName('notes/alpha.md', 'html')).toBe('alpha.html')
    expect(exportFileName('notes/alpha.md', 'pdf')).toBe('alpha.pdf')
    expect(exportFileName('notes/alpha.md', 'txt')).toBe('alpha.txt')
    expect(exportFileName('notes/alpha.md', 'csv')).toBe('alpha.csv')
    expect(exportFileName('notes/alpha.md', 'png')).toBe('alpha.png')
  })

  it('writes JPG as .jpg, which is the spelling the user asked for', () => {
    expect(EXPORT_EXTENSIONS.jpeg).toBe('jpg')
    expect(exportFileName('notes/alpha.md', 'jpeg')).toBe('alpha.jpg')
  })

  it('still names an untitled buffer', () => {
    expect(exportFileName(null, 'png')).toBe('untitled.png')
  })
})

describe('forceExportExtension', () => {
  it('replaces an extension the user typed', () => {
    expect(forceExportExtension('/vault/notes/alpha.png', 'jpeg')).toBe('/vault/notes/alpha.jpg')
  })

  it('adds one where there was none', () => {
    expect(forceExportExtension('/vault/notes/alpha', 'csv')).toBe('/vault/notes/alpha.csv')
  })

  it('normalises a doubled suffix rather than appending to it', () => {
    expect(forceExportExtension('/vault/notes/alpha.md', 'txt')).toBe('/vault/notes/alpha.txt')
  })

  it('keeps the directory and the dot in a dotted name', () => {
    expect(forceExportExtension('/vault/notes/v1.2.final.md', 'html')).toBe('/vault/notes/v1.2.final.html')
  })

  it('handles a bare name with no directory at all', () => {
    expect(forceExportExtension('alpha.md', 'png')).toBe('alpha.png')
  })

  it('handles a Windows separator', () => {
    expect(forceExportExtension('C:\\vault\\notes\\alpha.md', 'png')).toBe('C:\\vault\\notes\\alpha.png')
  })

  it('never returns a nameless file', () => {
    expect(forceExportExtension('/vault/notes/.md', 'png')).toBe('/vault/notes/untitled.png')
  })
})
