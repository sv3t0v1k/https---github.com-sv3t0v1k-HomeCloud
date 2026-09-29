import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ActionMenu } from './ActionMenu'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('ActionMenu keyboard exit', () => {
  it.each([
    { shift: false, destination: 'После меню' },
    { shift: true, destination: 'До меню' },
  ])('moves focus to $destination when tabbing out of the menu', async ({ shift, destination }) => {
    render(<>
      <button type="button">До меню</button>
      <ActionMenu label="Действия" items={[
        { label: 'Просмотр', icon: 'file', onSelect: vi.fn() },
        { label: 'Скачать', icon: 'download', onSelect: vi.fn() },
      ]} />
      <button type="button">После меню</button>
    </>)
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'Действия' })
    await user.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Просмотр' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Скачать' })).toHaveFocus()

    await user.tab({ shift })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: destination })).toHaveFocus()
  })
})


describe('ActionMenu viewport positioning', () => {
  it('opens above a bottom-edge trigger and follows scrolling and resizing', async () => {
    vi.stubGlobal('innerWidth', 375)
    vi.stubGlobal('innerHeight', 812)
    let anchorTop = 752
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'menu') return { top: 0, left: 0, right: 216, bottom: 340, width: 216, height: 340 } as DOMRect
      return { top: anchorTop, left: 327, right: 367, bottom: anchorTop + 40, width: 40, height: 40 } as DOMRect
    })
    render(<ActionMenu label="Действия" items={[{ label: 'Скачать', icon: 'download', onSelect: vi.fn() }]} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Действия' }))
    const menu = screen.getByRole('menu')
    expect(menu.style.position).toBe('fixed')
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(anchorTop)
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8)
    expect(Number.parseFloat(menu.style.top) + 340).toBeLessThanOrEqual(804)
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8)
    expect(Number.parseFloat(menu.style.left) + 216).toBeLessThanOrEqual(367)

    anchorTop = 80
    fireEvent.scroll(window)
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(anchorTop + 40)
    vi.stubGlobal('innerHeight', 240)
    fireEvent.resize(window)
    expect(menu.style.maxHeight).toBe('224px')
    expect(Number.parseFloat(menu.style.top) + 224).toBeLessThanOrEqual(232)
  })
})
