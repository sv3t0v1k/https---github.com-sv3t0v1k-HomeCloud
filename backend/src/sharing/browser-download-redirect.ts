export function browserDownloadErrorLocation(token: string, code: string): string {
  return `/share/${encodeURIComponent(token)}?downloadError=${code}`;
}
