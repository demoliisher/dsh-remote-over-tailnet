import { describe, expect, it, vi } from 'vitest'
import { createRemotePluginOptions } from '../src/client/settings.js'
import type { ClientReact, PluginSettingsView } from '../src/client/types.js'

function createTestHarness() {
  let stateSlots: any[] = []
  let stateIndex = 0
  let prevDeps: any[][] = []
  let effectCleanups: (((() => void) | void))[] = []
  let effectIndex = 0

  const React: ClientReact = {
    Fragment: Symbol('Fragment'),
    createElement(type: any, props: any, ...children: any[]) {
      return { type, props: props || {}, children }
    },
    useEffect(effect: any, deps?: any[]) {
      const slot = effectIndex++
      const oldDeps = prevDeps[slot]
      const hasChanged = !oldDeps || !deps || deps.some((d, i) => !Object.is(d, oldDeps[i]))
      if (hasChanged) {
        if (typeof effectCleanups[slot] === 'function') {
          effectCleanups[slot]!()
        }
        prevDeps[slot] = deps || []
        effectCleanups[slot] = effect()
      }
    },
    useCallback(cb: any) { return cb },
    useMemo(factory: any) { return factory() },
    useRef(initial: any) {
      const slot = stateIndex++
      if (stateSlots[slot] === undefined) stateSlots[slot] = { current: initial }
      return stateSlots[slot]
    },
    useState(initial: any) {
      const slot = stateIndex++
      if (stateSlots[slot] === undefined) {
        stateSlots[slot] = typeof initial === 'function' ? initial() : initial
      }
      const setState = (val: any) => {
        stateSlots[slot] = typeof val === 'function' ? val(stateSlots[slot]) : val
      }
      return [stateSlots[slot], setState]
    },
    useSyncExternalStore(subscribe: any, getSnapshot: any) {
      return typeof getSnapshot === 'function' ? getSnapshot() : undefined
    },
  }

  const unmount = () => {
    for (const cleanup of effectCleanups) {
      if (typeof cleanup === 'function') cleanup()
    }
    effectCleanups = []
  }

  const resetRender = () => {
    stateIndex = 0
    effectIndex = 0
  }

  return { React, resetRender, unmount }
}

const findElement = (node: any, predicate: (n: any) => boolean): any => {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  if (node.children) {
    for (const child of node.children) {
      const found = findElement(child, predicate)
      if (found) return found
    }
  }
  return null
}


describe('RemotePluginOptions inline sign-in suite', () => {
  it('toggles inline sign-in with accessible attributes without invoking props.onSignIn', async () => {
    const { React, resetRender, unmount } = createTestHarness()
    const onSignInSpy = vi.fn()
    const controlSpy = vi.fn(async (endpoint: string) => {
      if (endpoint === 'settings.get') {
        return {
          config: { serverUrl: 'https://relay.example.test' },
          deviceName: 'test-device',
          writable: true,
          applies: 'restart',
          associations: {},
        } as PluginSettingsView
      }
      if (endpoint === 'status') {
        return { mode: 'local', available: false, hostAuthorizationAvailable: true }
      }
      return {}
    })

    const statusFeed = { subscribe: vi.fn(() => () => {}), close: vi.fn(), getSnapshot: () => undefined } as any
    const t = (k: string) => k
    const Component = createRemotePluginOptions(React) as any
    const render = () => {
      resetRender()
      return Component({ control: controlSpy, statusFeed, onSignIn: onSignInSpy, t, view: 'page' })
    }

    render()
    await new Promise(r => setTimeout(r, 10))
    let tree = render()

    const toggleBtn = findElement(tree, (n: any) => n.props?.['aria-controls'] === 'dsh-remote-inline-signin')
    expect(toggleBtn).not.toBeNull()
    expect(toggleBtn.props['aria-expanded']).toBe(false)
    expect(toggleBtn.children[0]).toBe('signInAccount')

    // Click toggle button
    toggleBtn.props.onClick()
    expect(onSignInSpy).not.toHaveBeenCalled()

    tree = render()
    await new Promise(r => setTimeout(r, 10))
    tree = render()

    const openBtn = findElement(tree, (n: any) => n.props?.['aria-controls'] === 'dsh-remote-inline-signin')
    expect(openBtn.props['aria-expanded']).toBe(true)
    expect(openBtn.children[0]).toBe('close')

    const inlineSection = findElement(tree, (n: any) => n.props?.id === 'dsh-remote-inline-signin')
    expect(inlineSection).not.toBeNull()

    // Clicking close button folds it back
    openBtn.props.onClick()
    expect(onSignInSpy).not.toHaveBeenCalled()

    tree = render()
    const closedBtn = findElement(tree, (n: any) => n.props?.['aria-controls'] === 'dsh-remote-inline-signin')
    expect(closedBtn.props['aria-expanded']).toBe(false)
    expect(findElement(tree, (n: any) => n.props?.id === 'dsh-remote-inline-signin')).toBeNull()

    unmount()
  })

  it('completes account & password sign-in flow inline', async () => {
    const { React, resetRender, unmount } = createTestHarness()
    const controlSpy = vi.fn(async (endpoint: string, payload?: any) => {
      if (endpoint === 'settings.get') {
        return {
          config: { serverUrl: 'https://relay.example.test' },
          deviceName: 'test-device',
          writable: true,
          applies: 'restart',
          associations: {},
        } as PluginSettingsView
      }
      if (endpoint === 'status') {
        return { mode: 'local', available: false, hostAuthorizationAvailable: true }
      }
      if (endpoint === 'settings.configure') {
        return {
          status: 'authorized',
          role: 'client',
          settings: {
            config: { serverUrl: 'https://relay.example.test' },
            deviceName: 'test-device',
            writable: true,
            applies: 'restart',
            associations: { client: { method: 'account', account: 'tester@example.com' } },
          },
        }
      }
      return {}
    })

    const statusFeed = { subscribe: vi.fn(() => () => {}), close: vi.fn(), getSnapshot: () => undefined } as any
    const Component = createRemotePluginOptions(React) as any
    const render = () => {
      resetRender()
      return Component({ control: controlSpy, statusFeed, t: (k: string) => k, view: 'page' })
    }

    render()
    await new Promise(r => setTimeout(r, 10))
    let tree = render()

    const toggleBtn = findElement(tree, (n: any) => n.props?.['aria-controls'] === 'dsh-remote-inline-signin')
    toggleBtn.props.onClick()

    tree = render()
    await new Promise(r => setTimeout(r, 10))
    tree = render()

    const inline = findElement(tree, (n: any) => n.props?.id === 'dsh-remote-inline-signin')
    const emailInput = findElement(inline, (n: any) => n.props?.type === 'email')
    const passwordInput = findElement(inline, (n: any) => n.props?.type === 'password')

    emailInput.props.onChange({ target: { value: 'tester@example.com' } })
    passwordInput.props.onChange({ target: { value: 'mypassword' } })

    tree = render()
    const activeInline = findElement(tree, (n: any) => n.props?.id === 'dsh-remote-inline-signin')
    const submitBtn = findElement(activeInline, (n: any) => n.type === 'button' && n.children?.[0] === 'startSignIn')

    submitBtn.props.onClick()
    await new Promise(r => setTimeout(r, 10))

    expect(controlSpy).toHaveBeenCalledWith('settings.configure', {
      role: 'client',
      serverUrl: 'https://relay.example.test',
      email: 'tester@example.com',
      password: 'mypassword',
    })

    tree = render()
    expect(findElement(tree, (n: any) => n.props?.className?.includes('dshRemoteAssociation'))).not.toBeNull()
    expect(findElement(tree, (n: any) => n.props?.id === 'dsh-remote-inline-signin')).toBeNull()

    unmount()
  })

})
