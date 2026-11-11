import { createServerNotice } from './server-notice.js'
import type { LocalizedMessage, Translate } from '../client-locale.js'
import type { StatusFeed } from '../status-stream.js'
import {
  connectionErrorMessage,
  connectionStatusClass,
  connectionStatusLabel,
  formatLocalTime,
  messageOf,
  startupErrorMessage,
} from './presentation.js'
import type {
  ClientReact,
  PluginSettingsView,
  RemoteStatus,
  SidebarEntryPreference,
  SidebarEntryStyle,
  TailnetCredentialsView,
  TailnetView,
} from './types.js'

const sidebarEntryChoices: ReadonlyArray<{ value: SidebarEntryStyle; label: 'sidebarEntryStandard' | 'sidebarEntryCompact' }> = [
  { value: 'standard', label: 'sidebarEntryStandard' },
  { value: 'compact', label: 'sidebarEntryCompact' },
]

export function createRemotePluginOptions(React: ClientReact) {
  const ServerNotice = createServerNotice(React)

  function RemotePluginOptions(props: {
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    statusFeed: StatusFeed<RemoteStatus>
    sidebarEntry?: SidebarEntryPreference
    t: Translate
    view?: 'summary' | 'page'
  }): unknown {
    const { t } = props
    const subscribeStatus = typeof props.statusFeed?.subscribe === 'function'
      ? props.statusFeed.subscribe
      : () => () => {}
    const getStatusSnapshot = typeof props.statusFeed?.getSnapshot === 'function'
      ? props.statusFeed.getSnapshot
      : () => undefined
    const status = React.useSyncExternalStore(subscribeStatus, getStatusSnapshot, getStatusSnapshot)
    const [open, setOpen] = React.useState(props.view === 'page')
    const [settingsView, setSettingsView] = React.useState<PluginSettingsView | undefined>(undefined)
    const [loaded, setLoaded] = React.useState(false)
    const [writable, setWritable] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [terminalEnabled, setTerminalEnabled] = React.useState(false)
    const [terminalBusy, setTerminalBusy] = React.useState(false)
    const [debugLogging, setDebugLogging] = React.useState(false)
    const [debugBusy, setDebugBusy] = React.useState(false)
    const [sidebarEntry, setSidebarEntry] = React.useState<SidebarEntryStyle>(() => props.sidebarEntry?.read?.() ?? 'standard')
    const [sidebarEntryBusy, setSidebarEntryBusy] = React.useState(false)
    const [reconnectBusy, setReconnectBusy] = React.useState(false)
    const [tailnetView, setTailnetView] = React.useState<TailnetView | undefined>(undefined)
    const [tailnetBusy, setTailnetBusy] = React.useState(false)
    const [tailnetSecret, setTailnetSecret] = React.useState<TailnetCredentialsView | undefined>(undefined)
    const [tailnetSecretBusy, setTailnetSecretBusy] = React.useState(false)
    const [tailnetSecretVisible, setTailnetSecretVisible] = React.useState(false)
    const [tailnetCopied, setTailnetCopied] = React.useState<string | undefined>(undefined)
    const [notice, setNotice] = React.useState<LocalizedMessage | undefined>(undefined)
    const [error, setError] = React.useState<string | undefined>(undefined)
    const identityKey = React.useRef<string | undefined>(undefined)

    const applyView = (view: PluginSettingsView): void => {
      setSettingsView(view)
      setTerminalEnabled(view.config.terminal?.enabled ?? true)
      setDebugLogging(view.config.logLevel === 'debug')
      setSidebarEntry(view.config.sidebar?.entry ?? 'standard')
      props.sidebarEntry?.publish(view.config.sidebar?.entry ?? 'standard')
      setWritable(view.writable)
      setLoaded(true)
    }

    React.useEffect(() => {
      void props.control<PluginSettingsView>('settings.get')
        .then(applyView)
        .catch(reason => setError(messageOf(reason, t)))
    }, [])

    // The pushed status is the only source for the Host identity and the
    // connection row; the settings snapshot is re-read only when the identity
    // changes, so ordinary connection frames do not refetch it.
    React.useEffect(() => {
      setTailnetView(status?.tailnet ?? undefined)
      const key = JSON.stringify([
        status?.deviceName,
        status?.host?.deviceId,
        status?.host?.authorized,
        status?.host?.account,
        status?.startupError?.code,
      ])
      if (identityKey.current === undefined) {
        identityKey.current = key
        return
      }
      if (identityKey.current === key) return
      identityKey.current = key
      void props.control<PluginSettingsView>('settings.get')
        .then(applyView)
        .catch(reason => setError(messageOf(reason, t)))
    }, [status])

    const reconnectHost = async (): Promise<void> => {
      setReconnectBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        await props.control<RemoteStatus>('host.reconnect')
        setNotice({ key: 'reconnectStarted' })
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setReconnectBusy(false)
      }
    }

    const setRemoteService = async (enabled: boolean): Promise<void> => {
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        await props.control<RemoteStatus>('service.set', { enabled })
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const setTerminalRemote = async (enabled: boolean): Promise<void> => {
      const previous = terminalEnabled
      setTerminalEnabled(enabled)
      setTerminalBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        applyView(await props.control<PluginSettingsView>('settings.development.set', { terminalEnabled: enabled }))
        setNotice({ key: 'terminalSaved' })
      } catch (reason) {
        setTerminalEnabled(previous)
        setError(messageOf(reason, t))
      } finally {
        setTerminalBusy(false)
      }
    }

    const setSidebarEntryStyle = async (entry: SidebarEntryStyle): Promise<void> => {
      if (entry === sidebarEntry) return
      const previous = sidebarEntry
      setSidebarEntry(entry)
      setSidebarEntryBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        applyView(await props.control<PluginSettingsView>('settings.appearance.set', { sidebarEntry: entry }))
        setNotice({ key: 'sidebarEntrySaved' })
      } catch (reason) {
        setSidebarEntry(previous)
        setError(messageOf(reason, t))
      } finally {
        setSidebarEntryBusy(false)
      }
    }

    const setDebug = async (enabled: boolean): Promise<void> => {
      if (debugBusy) return
      setDebugBusy(true)
      setError(undefined)
      try {
        applyView(await props.control<PluginSettingsView>('settings.development.set', { debugLogging: enabled }))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setDebugBusy(false)
      }
    }

    const refreshTailnet = async (): Promise<void> => {
      if (tailnetBusy) return
      setTailnetBusy(true)
      setError(undefined)
      try {
        setTailnetView((await props.control<TailnetView | null>('tailnet.status')) ?? undefined)
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setTailnetBusy(false)
      }
    }

    const revealTailnetSecret = async (): Promise<void> => {
      if (tailnetSecret !== undefined) {
        setTailnetSecretVisible(current => !current)
        return
      }
      setTailnetSecretBusy(true)
      setError(undefined)
      try {
        setTailnetSecret(await props.control<TailnetCredentialsView>('tailnet.credentials'))
        setTailnetSecretVisible(true)
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setTailnetSecretBusy(false)
      }
    }

    const copyTailnet = async (value: string, tag: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(value)
      } catch (reason) {
        setError(messageOf(reason, t))
        return
      }
      setTailnetCopied(tag)
      setTimeout(() => setTailnetCopied(current => (current === tag ? undefined : current)), 2_000)
    }

    const tailnetStep = (label: string, step: { ok: boolean | null; detail: string }) =>
      React.createElement('div', { className: 'dshRemoteTailnetStep' },
        React.createElement('span', {
          className: 'dshRemoteTailnetDot' + (step.ok === true ? ' isOk' : step.ok === false ? ' isFail' : ''),
          'aria-hidden': true,
        }),
        React.createElement('div', null,
          React.createElement('strong', null, label),
          React.createElement('p', null, step.detail)))

    const tailnetField = (label: string, value: string, tag: string) =>
      React.createElement('div', { className: 'dshRemoteTailnetField' },
        React.createElement('span', null, label),
        React.createElement('code', null, value),
        React.createElement('button', {
          type: 'button',
          className: 'dshRemoteDiscard',
          onClick: () => void copyTailnet(value, tag),
        }, t(tailnetCopied === tag ? 'tailnetCopied' : 'tailnetCopy')))

    const tailnetPasswordField = tailnetView?.enabled !== true || tailnetView.account === undefined
      ? null
      : tailnetSecret === undefined
        ? React.createElement('div', { className: 'dshRemoteTailnetField' },
          React.createElement('span', null, t('tailnetPassword')),
          React.createElement('code', null, '••••••••••••'),
          React.createElement('button', {
            type: 'button',
            className: 'dshRemoteDiscard',
            disabled: tailnetSecretBusy,
            onClick: () => void revealTailnetSecret(),
          }, t(tailnetSecretBusy ? 'tailnetPending' : 'tailnetShowSecret')))
        : React.createElement('div', { className: 'dshRemoteTailnetField' },
          React.createElement('span', null, t('tailnetPassword')),
          React.createElement('code', null, tailnetSecretVisible ? tailnetSecret.password : '••••••••••••'),
          React.createElement('button', {
            type: 'button',
            className: 'dshRemoteDiscard',
            disabled: tailnetSecretBusy,
            onClick: () => void revealTailnetSecret(),
          }, t(tailnetSecretVisible ? 'tailnetHideSecret' : 'tailnetShowSecret')),
          React.createElement('button', {
            type: 'button',
            className: 'dshRemoteDiscard',
            onClick: () => void copyTailnet(tailnetSecret.password, 'password'),
          }, t(tailnetCopied === 'password' ? 'tailnetCopied' : 'tailnetCopy')))

    const tailnetSetting = tailnetView === undefined
      ? null
      : React.createElement('section', { className: 'dshRemoteTailnetSettings' },
        React.createElement('div', { className: 'dshRemoteTailnetHeading' },
          React.createElement('strong', null, t('tailnetTitle')),
          React.createElement('p', null, t('tailnetHint'))),
        tailnetView.enabled && tailnetView.publicUrl !== undefined
          ? tailnetField(t('tailnetServerAddress'), tailnetView.publicUrl, 'address')
          : null,
        React.createElement('div', { className: 'dshRemoteTailnetSteps' },
          tailnetStep(t('tailnetStepTailscale'), tailnetView.steps.tailscale),
          tailnetStep(t('tailnetStepRelay'), tailnetView.steps.relay),
          tailnetStep(t('tailnetStepServe'), tailnetView.steps.serve),
          tailnetStep(t('tailnetStepAuthorize'), tailnetView.steps.authorize)),
        tailnetView.enabled && tailnetView.account !== undefined
          ? tailnetField(t('tailnetAccount'), tailnetView.account, 'account')
          : null,
        tailnetPasswordField,
        tailnetView.error === undefined
          ? null
          : React.createElement('p', { className: 'dshRemoteError', role: 'alert' },
            tailnetView.error.message,
            tailnetView.error.actionUrl === undefined ? null : React.createElement('a', {
              href: tailnetView.error.actionUrl, target: '_blank', rel: 'noreferrer',
            }, t('openInBrowser'))),
        React.createElement('div', { className: 'dshRemoteTailnetFooter' },
          React.createElement('button', {
            type: 'button',
            className: 'dshRemoteDiscard',
            disabled: tailnetBusy,
            onClick: () => void refreshTailnet(),
          }, t(tailnetBusy ? 'tailnetPending' : 'tailnetRefresh'))))

    const developmentSetting = React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
        React.createElement('div', null,
          React.createElement('strong', null, t('debugLogging')),
          React.createElement('p', null, t('debugLoggingHint'))),
        React.createElement('input', {
          type: 'checkbox', role: 'switch', checked: debugLogging,
          disabled: busy || debugBusy || !writable, 'aria-label': t('debugLogging'),
          onChange: (event: Event) => void setDebug((event.target as HTMLInputElement).checked),
        })),
      React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
        React.createElement('div', null,
          React.createElement('strong', null, t('terminalRemote')),
          React.createElement('p', null, t('terminalRemoteHint'))),
        React.createElement('input', {
          type: 'checkbox', role: 'switch', checked: terminalEnabled,
          disabled: busy || terminalBusy || !writable, 'aria-label': t('terminalRemote'),
          onChange: (event: Event) => void setTerminalRemote((event.target as HTMLInputElement).checked),
        })))

    // The entry style is presentation only, so it lives beside the development
    // switches instead of inside the Host-facing settings block.
    const sidebarEntrySetting = React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
      React.createElement('div', null,
        React.createElement('strong', null, t('sidebarEntry')),
        React.createElement('p', null, t('sidebarEntryHint'))),
      React.createElement('div', {
        className: 'dshRemoteEntryStyleChoices',
        role: 'radiogroup',
        'aria-label': t('sidebarEntry'),
      }, sidebarEntryChoices.map(choice => React.createElement('button', {
        key: choice.value,
        type: 'button',
        role: 'radio',
        'aria-checked': sidebarEntry === choice.value,
        className: sidebarEntry === choice.value ? 'isSelected' : undefined,
        disabled: sidebarEntryBusy || !writable,
        onClick: () => void setSidebarEntryStyle(choice.value),
      }, t(choice.label)))))

    const host = status?.host
    const hostName = status?.deviceName ?? ''
    const hostDeviceId = host?.deviceId ?? ''
    const connectedClients = host?.connectedClients ?? []
    const badgeLabel = host === undefined
      ? t('checkingConnection')
      : host.enabled === false
        ? t('serviceStopped')
        : host.online
          ? t('online')
          : host.accountRequired
            ? t('accountRequired')
            : t('offline')
    const startupErrorBanner = settingsView?.startupError !== undefined
      ? React.createElement('p', { className: 'dshRemoteError', role: 'alert' },
        startupErrorMessage(settingsView.startupError, t))
      : null

    if (props.view === 'summary') return React.createElement('span', null, t('pluginDescription'))

    const logPath = tailnetView?.logPath
    const settingsBody = !loaded
      ? React.createElement('p', { className: 'dshRemoteSettingsState' }, error ?? t('loadingSettings'))
      : React.createElement('div', { className: 'dshRemoteSettings' },
        startupErrorBanner,
        React.createElement('div', { className: 'dshRemoteHostIdentity' },
          React.createElement('div', null,
            React.createElement('span', null, t('hostName')),
            React.createElement('strong', null, hostName || '—')),
          React.createElement('div', null,
            React.createElement('span', null, t('deviceId')),
            React.createElement('code', null, hostDeviceId || '—'))),
        React.createElement('div', { className: 'dshRemoteAuthorizationSetting' },
          React.createElement('div', null,
            React.createElement('strong', null, t('remoteService')),
            React.createElement('p', null, t('remoteServiceHint'))),
          status?.serviceAvailable
            ? React.createElement('input', {
              type: 'checkbox', role: 'switch', disabled: busy,
              'aria-label': t('remoteService'),
              checked: host?.enabled === true,
              onChange: (event: Event) => void setRemoteService((event.target as HTMLInputElement).checked),
            })
            : null),
        React.createElement('div', { className: 'dshRemoteConnection', 'aria-live': 'polite' },
          React.createElement('div', { className: 'dshRemoteConnectionSummary' },
            React.createElement('span', null, t('connection')),
            React.createElement('strong', null,
              React.createElement('span', {
                className: `dshRemoteConnectionDot${connectionStatusClass(host)}`,
                'aria-hidden': true,
              }),
              connectionStatusLabel(host, t)),
            React.createElement('p', null, host === undefined
              ? t('checkingConnection')
              : host.lastActiveAt === undefined
                ? t('neverConnected')
                : t('lastActive', { time: formatLocalTime(host.lastActiveAt) }))),
          React.createElement('button', {
            type: 'button',
            className: 'dshRemoteReconnect',
            disabled: reconnectBusy || host?.enabled === false,
            onClick: () => void reconnectHost(),
          }, t(reconnectBusy ? 'reconnectingAction' : 'reconnect'))),
        host?.authorized && !host.accountRequired ? React.createElement(ServerNotice, {
          offline: !host.online && host.reconnecting,
          linked: connectedClients.length > 0,
          expiresAt: host.recoveryExpiresAt, t,
        }) : null,
        host?.error === undefined || host.online || (host.reconnecting && host.error === 'CONNECTION_FAILED')
          ? null
          : React.createElement('p', { className: 'dshRemoteConnectionIssue', role: 'status' },
            connectionErrorMessage(host.error, t)),
        tailnetSetting,
        React.createElement('section', { className: 'dshRemoteSettingsGroup' },
          React.createElement('strong', { className: 'dshRemoteGroupTitle' }, t('diagnosticsTitle')),
          developmentSetting,
          sidebarEntrySetting,
          logPath === undefined
            ? null
            : React.createElement('div', { className: 'dshRemoteTailnetField' },
              React.createElement('span', null, t('tailnetLogPath')),
              React.createElement('code', null, logPath),
              React.createElement('button', {
                type: 'button',
                className: 'dshRemoteDiscard',
                onClick: () => void copyTailnet(logPath, 'logPath'),
              }, t(tailnetCopied === 'logPath' ? 'tailnetCopied' : 'tailnetCopy')))),
        !writable ? React.createElement('p', { className: 'dshRemoteError' }, t('readOnly')) : null,
        React.createElement('div', { className: 'dshRemoteSettingsFooter' },
          React.createElement('p', {
            className: error !== undefined ? 'dshRemoteError' : 'dshRemoteNotice',
            role: error !== undefined ? 'alert' : 'status',
          }, error ?? (notice === undefined ? '' : t(notice.key, notice.params)))))

    return React.createElement(props.view === 'page' ? 'div' : 'li', {
      className: `dshRemotePluginCard${open ? ' isOpen' : ''}${props.view === 'page' ? ' dshRemotePluginModern' : ''}`,
      ...(props.view === 'page' ? { 'data-dsh-remote-settings': '' } : {}),
    },
      React.createElement('div', { className: 'dshRemotePluginCardHeader' },
        React.createElement('button', {
          type: 'button',
          className: 'dshRemotePluginCardToggle',
          'aria-expanded': open,
          'aria-label': t(open ? 'collapseSettings' : 'expandSettings', { name: t('pluginTitle') }),
          onClick: () => setOpen(current => !current),
        },
          React.createElement('span', { className: 'dshRemotePluginCardHeading' },
            React.createElement('strong', null, t('pluginTitle')),
            React.createElement('span', null, t('pluginDescription'))),
          React.createElement('span', {
            className: `dshRemotePluginCardStatus${connectionStatusClass(host)}`,
          }, badgeLabel),
          React.createElement('span', { className: 'dshRemotePluginCardChevron', 'aria-hidden': true }, '⌄'))),
      !open ? null : React.createElement('div', { className: 'dshRemotePluginCardBody' }, settingsBody))
  }

  return RemotePluginOptions
}
