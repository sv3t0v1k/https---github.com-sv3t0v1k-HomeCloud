export interface TreeEntry { path: string; kind: 'folder' | 'file'; file?: File }
const MAX_ENTRIES = 1000

/** Materialize logical parents before any write; never decode or interpret storage paths. */
export function manifest(entries: TreeEntry[]): TreeEntry[] {
  const nodes = new Map<string, TreeEntry>()
  const origins = new Map<string, string>()
  const explicit = new Set<string>()
  for (const entry of entries) {
    if (!entry.path || /^[\\/]|^[a-z]:/i.test(entry.path)) throw new Error('Путь должен быть относительным.')
    const parts = entry.path.split('/').map((part) => {
      const name = part.normalize('NFC').trim()
      if (!name || name === '.' || name === '..' || name.length > 255 || /[\\/]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159))) throw new Error('Недопустимое имя в дереве.')
      return name
    })
    const path = parts.join('/')
    if (parts.length > 32 || new TextEncoder().encode(path).length > 4096) throw new Error('Предел дерева: 32 уровня и 4096 байт пути.')
    if (explicit.has(path)) throw new Error('Неоднозначные или повторяющиеся пути в дереве.')
    explicit.add(path)
    for (let i = 1; i <= parts.length; i++) {
      const key = parts.slice(0, i).join('/')
      const node: TreeEntry = i === parts.length ? { ...entry, path } : { path: key, kind: 'folder' }
      const raw = entry.path.split('/').slice(0, i).join('/')
      if (origins.has(key) && origins.get(key) !== raw) throw new Error('Неоднозначные имена родительских папок.')
      origins.set(key, raw)
      const prior = nodes.get(key)
      if (prior && (prior.kind !== 'folder' || node.kind !== 'folder')) throw new Error('Файл используется как папка или путь повторяется.')
      nodes.set(key, node)
      if (nodes.size > MAX_ENTRIES) throw new Error('Можно выбрать не более 1000 файлов и папок за раз.')
    }
  }
  return [...nodes.values()].sort((a, b) => a.path.split('/').length - b.path.split('/').length)
}

interface DirectoryHandle { kind: string; name: string; values(): AsyncIterable<DirectoryHandle>; getFile(): Promise<File> }

/** Supported Chromium picker preserves explicit empty directories. */
export async function pickDirectory(): Promise<TreeEntry[] | null> {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<DirectoryHandle> }).showDirectoryPicker
  if (!picker) return null
  const root = await picker.call(window)
  const entries: TreeEntry[] = []
  async function walk(handle: DirectoryHandle, path: string) {
    entries.push(handle.kind === 'directory' ? { kind: 'folder', path } : { kind: 'file', path, file: await handle.getFile() })
    manifest(entries) // Bound traversal before collecting another entry/file handle.
    if (handle.kind === 'directory') for await (const child of handle.values()) await walk(child, `${path}/${child.name}`)
  }
  await walk(root, root.name)
  return manifest(entries)
}

export function inputEntries(files: FileList | File[]): TreeEntry[] {
  return manifest(Array.from(files).map((file) => ({ kind: 'file', path: file.webkitRelativePath || file.name, file })))
}

/** Capture webkit entries synchronously while DataTransfer is still readable. */
export async function droppedEntries(items: DataTransferItemList, files: FileList): Promise<TreeEntry[]> {
  const roots = Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry)
  if (!roots.length) return inputEntries(files)
  const entries: TreeEntry[] = []
  async function walk(entry: FileSystemEntry, path: string): Promise<void> {
    if (entry.isDirectory) {
      entries.push({ kind: 'folder', path }); manifest(entries)
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!batch.length) break
        for (const child of batch) await walk(child, `${path}/${child.name}`)
      }
    } else {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      entries.push({ kind: 'file', path, file }); manifest(entries)
    }
  }
  for (const root of roots) await walk(root, root.name)
  return manifest(entries)
}
