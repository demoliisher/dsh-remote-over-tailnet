import type { Translate } from './client-locale.js'
import { en, localeNamespace, zh } from './client-locale.js'
import { unwrapControlResult } from './client/control-result.js'
import { createRemotePluginOptions } from './client/settings.js'
import { installStyle } from './client/shell.js'
import type {
  ClientReact,
  ControlResult,
  PortalRenderer,
  RemoteStatus,
  SidebarEntryPreference,
  SidebarEntryStyle,
} from './client/types.js'
import { createRemoteWorkspaceAction } from './client/workspaces.js'
import { CONTROL_RPC_PREFIX, STATUS_STREAM_PATH } from './control-route.js'
import type { StatusFeed } from './status-stream.js'
import { createStatusFeed } from './status-stream.js'

declare global {
  interface Window {
    __ModuleLoader__: {
      load(input: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
    }
    __DS_HARNESS_REMOTE_CLIENT_ACTIVE__?: boolean
  }
}

declare const DSH_REMOTE_CLIENT_MODULE_ID: string | undefined

const clientModuleId = typeof DSH_REMOTE_CLIENT_MODULE_ID === 'string'
  ? DSH_REMOTE_CLIENT_MODULE_ID
  : 'dsh-remote-over-tailnet'

window.__ModuleLoader__.load({
  id: clientModuleId,
  factory: require => {
    const module = { exports: {} as Record<string, unknown> }
    const React = require('react') as ClientReact
    // Share the host renderer for floating panels and the Compact sidebar entry.
    const portal = (() => {
      try {
        const reactDom = require('react-dom') as { createPortal?: PortalRenderer }
        return typeof reactDom.createPortal === 'function' ? reactDom.createPortal.bind(reactDom) : undefined
      } catch {
        return undefined
      }
    })()
    const RemotePluginOptions = createRemotePluginOptions(React)
    // Detail-page action beside the official Uninstall/Enable controls. The
    // 0.2.2 bundle page renders the official README before the configuration
    // section, so this jumps straight to the Remote card instead of requiring a
    // scroll through the whole document.
    function RemotePluginSettingsAction(props: { t: Translate; subject?: unknown }): unknown {
      if (pluginSubjectPackageName(props.subject) !== 'dsh-remote-over-tailnet') return null
      const label = props.t('openPluginSettings')
      return React.createElement('button', {
        type: 'button',
        className: 'dshRemoteDetailSettingsAction',
        'aria-label': label,
        onClick: (event: Event) => {
          const button = event.currentTarget as Element | null
          const page = button?.closest('[data-plugin-detail],[data-plugin-row-detail]') ?? document
          const target = page.querySelector('[data-dsh-remote-settings]')
          target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        },
      }, label)
    }
    const RemoteWorkspaceAction = createRemoteWorkspaceAction(React, portal)
    const inject = ['connection', 'slots', 'locale']

    function apply(ctx: {
      connection: { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<ControlResult> } }
      effect(effect: () => (() => void), label: string): void
      get<T = unknown>(name: string): T | undefined
      locale: {
        bind(namespace: string): Translate
        getLocale(): { active: 'zh' | 'en' }
        register(namespace: string, dictionaries: { zh: typeof zh; en: typeof en }): () => void
      }
      slots: {
        inject(name: string, factory: () => unknown): void
        register(options: Record<string, unknown>, component: unknown): unknown
      }
    }): void {
      if (window.__DS_HARNESS_REMOTE_CLIENT_ACTIVE__) return
      window.__DS_HARNESS_REMOTE_CLIENT_ACTIVE__ = true
      ctx.effect(() => () => { window.__DS_HARNESS_REMOTE_CLIENT_ACTIVE__ = false }, 'ds-harness-remote: client singleton')

      const t = ctx.locale.bind(localeNamespace)
      // Entry style shared by the settings page and the sidebar entry, so the
      // toggle moves the entry without a reload.
      let sidebarEntryStyle: SidebarEntryStyle = 'standard'
      const sidebarEntryListeners = new Set<() => void>()
      const sidebarEntry: SidebarEntryPreference = {
        read: () => sidebarEntryStyle,
        subscribe: (listener) => {
          sidebarEntryListeners.add(listener)
          return () => { sidebarEntryListeners.delete(listener) }
        },
        publish: (style) => {
          if (style === sidebarEntryStyle) return
          sidebarEntryStyle = style
          for (const listener of sidebarEntryListeners) listener()
        },
      }
      const control = async <T,>(endpoint: string, payload: unknown = {}): Promise<T> => {
        const result = await ctx.connection.rpc.call(CONTROL_RPC_PREFIX, endpoint, payload)
        return unwrapControlResult(result, t('remoteRequestFailed')) as T
      }
      // One pushed status stream feeds every Host-status render in this page.
      // Hosts without the event stream keep answering the unary status control
      // call, which the feed itself polls at the interval this replaced.
      const statusFeed = createStatusFeed<RemoteStatus>({
        url: STATUS_STREAM_PATH.slice(1),
        readStatus: () => control<RemoteStatus>('status'),
        onFallback: reason => {
          console.warn('ds-harness-remote: status event stream unavailable, polling status instead:', reason)
        },
      })
      ctx.effect(() => () => statusFeed.close(), 'ds-harness-remote: status stream')
      ctx.effect(() => ctx.locale.register(localeNamespace, { zh, en }), 'ds-harness-remote: dictionaries')
      ctx.effect(() => installStyle(clientModuleId), 'ds-harness-remote: client styles')
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'ds-harness-remote-workspace',
        order: -20,
        locale: localeNamespace,
        inject: () => ({
          control,
          statusFeed,
          sidebarEntry,
          portal,
        }),
      }, RemoteWorkspaceAction))
      // rc.1 Plugins-page configuration surfaces. `plugins.item` is reserved
      // for the official settings companion packages (the Plugins page renders
      // its registrants inside the Official group, so a third-party card there
      // reads as an official plugin) — a bundle's configuration belongs in the
      // two config slots below instead.
      // Row-scoped: keyed `<package>#<row id>` from the bundle's own patch
      // (`cordis.patch.yml` row `dsh-remote-over-tailnet`).
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-remote-over-tailnet#dsh-remote-over-tailnet',
        locale: localeNamespace,
        inject: () => ({
          control,
          statusFeed,
          sidebarEntry,
        }),
      }, RemotePluginOptions))
      // Bundle-scoped: installed-bundle details resolve configuration by
      // package name.
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-remote-over-tailnet',
        locale: localeNamespace,
        inject: () => ({
          control,
          statusFeed,
          sidebarEntry,
        }),
      }, RemotePluginOptions))
      // Top-of-page shortcut to the configuration card. Reused on a bundle's
      // and a single row's page (the bundle's README moved the card far down).
      ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
        name: 'plugins.detail.actions',
        id: 'ds-harness-remote-settings-link',
        order: 30,
        locale: localeNamespace,
        inject: () => ({}),
      }, RemotePluginSettingsAction))
    }

    function pluginSubjectPackageName(subject: unknown): string | undefined {
      if (typeof subject !== 'object' || subject === null) return undefined
      const pkg = (subject as { pkg?: unknown }).pkg
      if (typeof pkg !== 'object' || pkg === null) return undefined
      const name = (pkg as { name?: unknown }).name
      return typeof name === 'string' ? name : undefined
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
