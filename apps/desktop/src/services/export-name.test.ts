import { describe, expect, it } from 'vitest'
import { exportBaseName } from './export-name'

describe('exportBaseName', () => {
  it('derives base name from path', () => {
    expect(exportBaseName('/vault/notes/hello.md')).toBe('hello')
    expect(exportBaseName('hello.mdx')).toBe('hello')
    expect(exportBaseName(null)).toBe('untitled')
  })
})