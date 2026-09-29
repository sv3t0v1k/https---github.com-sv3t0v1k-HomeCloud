import type { ReactNode, SVGProps } from 'react'

type IconName = 'cloud' | 'home' | 'menu' | 'trash' | 'user' | 'folder' | 'file' | 'image' | 'text' | 'more' | 'upload' | 'download' | 'plus' | 'close' | 'chevron' | 'check' | 'link' | 'copy' | 'edit' | 'move' | 'grid' | 'list'

const paths: Record<IconName, ReactNode> = {
  folder: <path d="M3 7V5h6l2 2h10v13H3Z"/>,
  file: <path d="M14 3H5v18h14V8ZM14 3v5h5"/>,
  image: <path d="M3 3h18v18H3ZM3 17l5-5 4 4 4-6 5 7M8 7h.01"/>,
  text: <path d="M14 3H5v18h14V8ZM14 3v5h5M8 12h8M8 16h6"/>,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01"/>,
  upload: <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>,
  download: <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  link: <path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>,
  copy: <path d="M8 8h13v13H8ZM16 8V3H3v13h5"/>,
  edit: <path d="m4 16 12-12 4 4L8 20H4Zm10-10 4 4"/>,
  move: <path d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4m10-8 4 4-4 4"/>,
  grid: <path d="M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z"/>,
  list: <path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>,
  cloud: <path d="M7 18h10a4 4 0 0 0 .3-8A6 6 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z"/>,
  home: <><path d="m3 11 9-8 9 8"/><path d="M5 10v11h14V10M9 21v-7h6v7"/></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
}

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20" {...props} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">{paths[name]}</svg>
}
