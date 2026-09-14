export function exportBaseName(path: string | null | undefined): string {
  if (!path) return 'untitled'
  const base = path.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.[^.]+$/, '') || 'untitled'
}
