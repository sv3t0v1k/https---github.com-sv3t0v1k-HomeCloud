import { describe, expect, it } from 'vitest'
import { manifest, droppedEntries } from './publicTree'

describe('public tree manifest', () => {
  it('adds parents, preserves empty directories, sorts ancestors first and retains file references', () => {
    const file = new File(['bytes'], 'x')
    const result = manifest([{ path: 'a/b/c/d/e/x', kind: 'file', file }, { path: 'empty', kind: 'folder' }])
    expect(result.map((entry) => entry.path)).toEqual(['a', 'empty', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e', 'a/b/c/d/e/x'])
    expect(result.slice(-1)[0]?.file).toBe(file)
  })
  it.each(['/a', 'C:/a', '../a', 'a//b', 'a/../b', 'a\\b', 'a/\u0080', './a'])('rejects unsafe path %s', (path) => {
    expect(() => manifest([{ path, kind: 'folder' }])).toThrow()
  })
  it('rejects normalized aliases, file-as-parent, depth and total bounds', () => {
    expect(() => manifest([{ path: 'a/é', kind: 'folder' }, { path: 'a/e\u0301', kind: 'folder' }])).toThrow()
    expect(() => manifest([{ path: ' a /one', kind: 'file' }, { path: 'a/two', kind: 'file' }])).toThrow()
    expect(() => manifest([{ path: 'a', kind: 'file' }, { path: 'a/b', kind: 'file' }])).toThrow()
    expect(() => manifest([{ path: Array(33).fill('x').join('/'), kind: 'folder' }])).toThrow()
    expect(() => manifest(Array.from({ length: 1001 }, (_, i) => ({ path: `x${i}`, kind: 'folder' })))).toThrow()
  })
  it('does not decode literal encoded names', () => expect(manifest([{ path: '%2e%2e', kind: 'folder' }])[0].path).toBe('%2e%2e'))
  it('drains every readEntries batch and retains empty directories', async () => {
    const empty = { name: 'empty', isDirectory: true, createReader: () => ({ readEntries: (done: (items: unknown[]) => void) => done([]) }) }
    let call = 0
    const root = { name: 'root', isDirectory: true, createReader: () => ({ readEntries: (done: (items: unknown[]) => void) => done(call++ === 0 ? [empty] : []) }) }
    const items = [{ webkitGetAsEntry: () => root }] as unknown as DataTransferItemList
    expect((await droppedEntries(items, [] as unknown as FileList)).map((node) => node.path)).toEqual(['root', 'root/empty'])
    expect(call).toBe(2)
  })
})
