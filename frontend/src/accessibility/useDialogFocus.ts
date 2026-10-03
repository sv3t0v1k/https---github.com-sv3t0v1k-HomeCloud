import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useDialogFocus(
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const dialog = dialogRef.current
    const initialFocus = initialFocusRef?.current ?? focusableElements(dialog)[0] ?? dialog
    initialFocus?.focus()

    function keepFocusInside(event: FocusEvent) {
      const currentDialog = dialogRef.current
      if (currentDialog && event.target instanceof Node && !currentDialog.contains(event.target)) {
        const fallback = initialFocusRef?.current ?? focusableElements(currentDialog)[0] ?? currentDialog
        fallback.focus()
      }
    }

    let focusRepairTimer: ReturnType<typeof setTimeout> | undefined
    function repairLostFocus() {
      clearTimeout(focusRepairTimer)
      // Safari completes native focus transfer after the focusout microtask checkpoint.
      focusRepairTimer = setTimeout(() => {
        const currentDialog = dialogRef.current
        if (currentDialog?.isConnected && !currentDialog.contains(document.activeElement)) {
          const fallback = initialFocusRef?.current ?? focusableElements(currentDialog)[0] ?? currentDialog
          fallback.focus()
        }
      }, 0)
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const currentDialog = dialogRef.current
      const focusable = focusableElements(currentDialog)
      if (focusable.length === 0) {
        event.preventDefault()
        currentDialog?.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!currentDialog?.contains(document.activeElement)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('focusin', keepFocusInside)
    document.addEventListener('focusout', repairLostFocus)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      clearTimeout(focusRepairTimer)
      document.removeEventListener('focusin', keepFocusInside)
      document.removeEventListener('focusout', repairLostFocus)
      document.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [initialFocusRef])

  return dialogRef
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  return container
    ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    : []
}
