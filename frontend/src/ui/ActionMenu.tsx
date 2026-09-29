import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from 'react'
import { Icon } from './Icon'

interface MenuItem { label: string; icon: ComponentProps<typeof Icon>['name']; disabled?: boolean; danger?: boolean; onSelect(): void }

export function ActionMenu({ label, disabled, items }: { label: string; disabled?: boolean; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', right: 'auto', maxHeight: 'calc(100dvh - 16px)', maxWidth: 'calc(100vw - 16px)' })
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const id = useId()
  function close() { setOpen(false); trigger.current?.focus() }
  useLayoutEffect(() => {
    if (!open) return
    function updatePosition() {
      if (!trigger.current || !menu.current) return
      const anchor = trigger.current.getBoundingClientRect()
      const bounds = menu.current.getBoundingClientRect()
      const margin = 8
      const gap = 4
      const maxHeight = Math.max(0, window.innerHeight - margin * 2)
      const maxWidth = Math.max(0, window.innerWidth - margin * 2)
      const contentHeight = bounds.height + Math.max(0, menu.current.scrollHeight - menu.current.clientHeight)
      const height = Math.min(contentHeight, maxHeight)
      const width = Math.min(bounds.width, maxWidth)
      const below = anchor.bottom + gap
      const preferredTop = below + height <= window.innerHeight - margin ? below : anchor.top - gap - height
      setPosition({
        position: 'fixed', right: 'auto',
        top: Math.max(margin, Math.min(preferredTop, window.innerHeight - margin - height)),
        left: Math.max(margin, Math.min(anchor.right - width, window.innerWidth - margin - width)),
        maxHeight, maxWidth,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    function outside(event: PointerEvent) { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div className="action-menu" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button aria-controls={open ? id : undefined} aria-expanded={open} aria-haspopup="menu" aria-label={label} className="icon-button" aria-disabled={disabled || undefined} onClick={() => { if (!disabled) setOpen((value) => !value) }} onKeyDown={(event) => { if (disabled) return; if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }} ref={trigger} type="button"><Icon name="more" /></button>
    {open ? <div aria-label={label} className="action-menu-popover" id={id} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if (event.key === 'Tab') { close(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[index]?.focus()
    }} ref={menu} role="menu" style={position}>{items.map((item) => <button className={item.danger ? 'action-menu-item is-danger' : 'action-menu-item'} disabled={item.disabled} key={item.label} onClick={() => { close(); item.onSelect() }} role="menuitem" tabIndex={-1} type="button"><Icon name={item.icon} />{item.label}</button>)}</div> : null}
  </div>
}
