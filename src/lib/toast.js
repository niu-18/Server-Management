/** 极简 toast：任何组件都能调 toast('已复制')，不用层层传 props。 */
const listeners = new Set()

export function toast(message, kind = 'info') {
  const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, message, kind }
  for (const fn of listeners) fn(item)
}

export function subscribeToast(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
