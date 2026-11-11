import { renderBodyPortal } from './portal.js'
import type { LocaleKey, Translate } from '../client-locale.js'
import type { StatusFeed } from '../status-stream.js'
import { connectedClientModeLabel, formatPlatform, messageOf, startupErrorMessage } from './presentation.js'
import type {
  ClientReact,
  PluginSettingsView,
  PortalRenderer,
  RemoteStatus,
  SidebarEntryPreference,
  SidebarEntryStyle,
  TailnetCredentialsView,
  TailnetView,
} from './types.js'

const tailnetPhaseKeys: Record<TailnetView['phase'], LocaleKey> = {
  disabled: 'tailnetPhaseDisabled',
  probing: 'tailnetPhaseProbing',
  starting: 'tailnetPhaseStarting',
  ready: 'tailnetPhaseReady',
  error: 'tailnetPhaseError',
}

export function createRemoteWorkspaceAction(React: ClientReact, portal?: PortalRenderer) {
  /**
   * Renders the Compact entry at the end of the host account row. The host
   * exposes no slot there, so the button is portalled into the settings row; the
   * Standard entry stays in place until that row exists, so nothing is lost when
   * the sidebar is collapsed.
   */
  function RemoteAccountEntry(props: {
    portal: PortalRenderer | undefined
    fallback: unknown
    children: unknown
  }): unknown {
    const [container, setContainer] = React.useState<Element | null>(null)
    const { portal } = props
    React.useEffect(() => {
      if (portal === undefined) return undefined
      let attempt = 0
      let timer: number | undefined
      let host: HTMLElement | undefined
      let observer: MutationObserver | undefined
      const attach = (): void => {
        const row = document.querySelector('[class*="settingsArea"] [class*="triggerRow"]')
        if (row === null) {
          // The row mounts with the footer area; give the host a moment before
          // settling for the Standard entry.
          if (attempt < 40) {
            attempt += 1
            timer = window.setTimeout(attach, 50)
          }
          return
        }
        host = document.createElement('span')
        // The host re-renders its row without React knowing about this node, so
        // put it back whenever it is dropped.
        observer = new MutationObserver(() => {
          if (host !== undefined && !host.isConnected) row.append(host)
        })
        observer.observe(row, { childList: true })
        row.append(host)
        setContainer(host)
      }
      attach()
      return () => {
        if (timer !== undefined) window.clearTimeout(timer)
        observer?.disconnect()
        host?.remove()
      }
    }, [portal])
    if (typeof portal !== 'function' || container === null) return props.fallback
    // The Compact entry is portalled into a host-owned row, so a stale or
    // detached container must not blank the sidebar; fall back in place.
    try {
      return portal(props.children, container)
    } catch {
      return props.fallback
    }
  }

  function RemoteWorkspaceAction(props: {
    wide: boolean
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    statusFeed: StatusFeed<RemoteStatus>
    sidebarEntry: SidebarEntryPreference
    portal?: PortalRenderer
    t: Translate
  }): unknown {
    const { t } = props
    const [open, setOpen] = React.useState(false)
    const [status, setStatus] = React.useState<RemoteStatus | undefined>(undefined)
    const [busy, setBusy] = React.useState(false)
    // 中继账号密码按需读取：状态推送里不带密码，面板打开时才向 Host 要。
    const [relayCredentials, setRelayCredentials] = React.useState<TailnetCredentialsView | undefined>(undefined)
    const [relayAccountDraft, setRelayAccountDraft] = React.useState('')
    const [relayPasswordDraft, setRelayPasswordDraft] = React.useState('')
    const [relaySecretVisible, setRelaySecretVisible] = React.useState(false)
    const [relayCopied, setRelayCopied] = React.useState('')
    const [relaySaved, setRelaySaved] = React.useState(false)
    const pageRef = React.useRef<HTMLElement | null>(null)
    const [error, setError] = React.useState<string | undefined>(undefined)
    const [sidebarEntry, setSidebarEntry] = React.useState<SidebarEntryStyle>(() => props.sidebarEntry.read())

    // The settings page publishes the saved style, so the entry moves without a
    // reload; the first fetch below seeds it for a fresh page.
    React.useEffect(
      () => props.sidebarEntry.subscribe(() => setSidebarEntry(props.sidebarEntry.read())),
      [props.sidebarEntry],
    )
    React.useEffect(() => {
      void props.control<PluginSettingsView>('settings.get')
        .then(view => props.sidebarEntry.publish(view.config.sidebar?.entry ?? 'standard'))
        .catch(() => undefined)
    }, [props.control, props.sidebarEntry])

    React.useEffect(() => {
      if (!open) return
      const frame = window.requestAnimationFrame(() => pageRef.current?.focus())
      return () => window.cancelAnimationFrame(frame)
    }, [open])

    React.useEffect(() => {
      if (!open) return
      const closeOnEscape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return
        setOpen(false)
      }
      window.addEventListener('keydown', closeOnEscape)
      return () => window.removeEventListener('keydown', closeOnEscape)
    }, [open])

    // The pushed status drives the sidebar badge and the open panel alike; the
    // feed replays the latest status to a new subscriber.
    React.useEffect(() => props.statusFeed.subscribe(setStatus), [props.statusFeed])

    // 打开面板时取一次本机中继账号；没有本地中继时接口失败，保留空输入。
    React.useEffect(() => {
      if (!open) return undefined
      let cancelled = false
      void props.control<TailnetCredentialsView | null>('tailnet.credentials')
        .then(credentials => {
          if (cancelled || credentials === null) return
          setRelayCredentials(credentials)
        })
        .catch(() => undefined)
      return () => { cancelled = true }
    }, [open, props.control])

    React.useEffect(() => {
      if (relayCredentials === undefined) return
      setRelayAccountDraft(relayCredentials.account)
      setRelayPasswordDraft(relayCredentials.password)
    }, [relayCredentials])

    const refreshRemote = async (): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        const nextStatus = await props.control<RemoteStatus>('status')
        setStatus(nextStatus)
        if (nextStatus.startupError !== undefined) setError(startupErrorMessage(nextStatus.startupError, t))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const show = async (): Promise<void> => {
      setOpen(true)
      await refreshRemote()
    }

    const copyRelayValue = async (value: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(value)
      } catch {
        return
      }
      setRelayCopied(value)
      window.setTimeout(() => setRelayCopied(current => (current === value ? '' : current)), 2000)
    }

    const relayDraftUnchanged = relayCredentials !== undefined
      && relayAccountDraft.trim() === relayCredentials.account
      && relayPasswordDraft === relayCredentials.password
    // 保存后 Host 用新凭据重启中继并重新登录本机，客户端要重连一次。
    const saveRelayCredentials = async (): Promise<void> => {
      if (relayAccountDraft.trim() === '' || relayPasswordDraft === '') return
      if (relayDraftUnchanged) return
      setBusy(true)
      setError(undefined)
      setRelaySaved(false)
      try {
        const nextCredentials = { account: relayAccountDraft.trim(), password: relayPasswordDraft }
        await props.control('tailnet.credentials.update', nextCredentials)
        setRelayCredentials(nextCredentials)
        setStatus(await props.control<RemoteStatus>('status'))
        setRelaySaved(true)
        window.setTimeout(() => setRelaySaved(false), 2500)
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const setHostAuthorization = async (enabled: boolean): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        setStatus(await props.control<RemoteStatus>('host.authorization.set', { enabled }))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const remoteLabel = t('remoteEntry')
    const computerIcon = React.createElement('svg', {
      className: 'dshRemoteComputerIcon',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
      React.createElement('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }),
      React.createElement('path', { d: 'M8 21h8M12 17v4' }))
    const entry = React.createElement('div', {
      className: `dshRemoteSidebarEntry${props.wide ? ' isWide' : ' isRail'}`,
    },
      React.createElement('button', {
        type: 'button',
        className: 'dshRemoteModeButton',
        title: remoteLabel,
        'aria-label': remoteLabel,
        onClick: () => void show(),
      }, computerIcon, props.wide
        ? React.createElement('span', { className: 'dshRemoteSidebarLabel' }, remoteLabel)
        : null))
    // The Compact style drops the label and lives in the account row.
    const accountEntry = React.createElement('div', { className: 'dshRemoteAccountEntry' },
      React.createElement('button', {
        type: 'button',
        className: 'dshRemoteAccountEntryButton',
        title: remoteLabel,
        'aria-label': remoteLabel,
        onClick: () => void show(),
      }, computerIcon))
    const compact = sidebarEntry === 'compact' && props.wide && props.portal !== undefined

    const tailnet = status?.tailnet
    // 中继对外地址：Tailscale 组网就绪后是 HTTPS 域名，未就绪时没有可抄的地址。
    const serviceAddress = tailnet?.publicUrl
    const relayPhaseLabel = tailnet === undefined || tailnet === null
      ? t('tailnetPhaseDisabled')
      : t(tailnetPhaseKeys[tailnet.phase])
    const relayAddressBar = serviceAddress === undefined ? null : React.createElement('p', { className: 'dshRemoteRelayAddress' },
      React.createElement('span', { className: 'dshRemoteRelayAddressLabel' }, t('tailnetServerAddress')),
      React.createElement('a', { href: serviceAddress, target: '_blank', rel: 'noreferrer' }, serviceAddress),
      React.createElement('button', {
        type: 'button',
        className: 'dshRemoteRelayCopy',
        onClick: () => void copyRelayValue(serviceAddress),
      }, t(relayCopied === serviceAddress ? 'tailnetCopied' : 'tailnetCopy')))
    // 中继连接信息：地址、账号、密码放在一起，方便直接抄给其他客户端。
    const relayAccessPanel = React.createElement('section', {
      className: 'dshRemoteRelayAccess',
      'aria-label': t('tailnetAccessTitle'),
    },
      React.createElement('div', { className: 'dshRemoteRelayAccessHeading' },
        React.createElement('strong', null, t('tailnetAccessTitle')),
        React.createElement('p', null, t('tailnetAccessHint'))),
      relayAddressBar,
      React.createElement('p', { className: 'dshRemoteRelayStatus' },
        React.createElement('strong', null, t('tailnetTitle')),
        React.createElement('span', null, relayPhaseLabel)),
      React.createElement('div', { className: 'dshRemoteRelayFields' },
        React.createElement('label', null, t('tailnetAccount'),
          React.createElement('input', {
            type: 'email',
            value: relayAccountDraft,
            autoComplete: 'username',
            onChange: (event: Event) => setRelayAccountDraft((event.target as HTMLInputElement).value),
          })),
        React.createElement('label', null, t('tailnetPassword'),
          React.createElement('div', { className: 'dshRemoteRelayPasswordRow' },
            React.createElement('input', {
              type: relaySecretVisible ? 'text' : 'password',
              value: relayPasswordDraft,
              autoComplete: 'current-password',
              onChange: (event: Event) => setRelayPasswordDraft((event.target as HTMLInputElement).value),
            }),
            React.createElement('button', {
              type: 'button',
              className: 'dshRemoteRelayCopy',
              onClick: () => setRelaySecretVisible(visible => !visible),
            }, t(relaySecretVisible ? 'tailnetHideSecret' : 'tailnetShowSecret')),
            React.createElement('button', {
              type: 'button',
              className: 'dshRemoteRelayCopy',
              onClick: () => void copyRelayValue(relayPasswordDraft),
            }, t(relayCopied === relayPasswordDraft ? 'tailnetCopied' : 'tailnetCopy'))))),
      React.createElement('div', { className: 'dshRemoteRelayActions' },
        React.createElement('button', {
          type: 'button',
          disabled: busy || relayAccountDraft.trim() === '' || relayPasswordDraft === '' || relayDraftUnchanged,
          onClick: () => void saveRelayCredentials(),
        }, t(busy ? 'saving' : 'tailnetSaveCredentials')),
        relaySaved ? React.createElement('span', { className: 'dshRemoteRelaySaved' }, t('tailnetCredentialsSaved')) : null))

    const host = status?.host
    const hostStateLabel = host === undefined
      ? t('checkingConnection')
      : host.online
        ? t('online')
        : host.reconnecting
          ? t('connecting')
          : t('offline')
    const connectedClients = host?.connectedClients ?? []
    const hostControlPanel = React.createElement('section', { className: 'dshRemoteHostControl' },
      React.createElement('div', { className: 'dshRemoteSectionHeading' },
        React.createElement('div', { className: 'dshRemoteSectionTitle' },
          React.createElement('strong', null, t('thisMachineHost')),
          status?.hostAuthorizationAvailable
            ? React.createElement('label', { className: 'dshRemoteHostControlToggle' },
              React.createElement('span', null, t('allowControlCurrentDevice')),
              React.createElement('input', {
                type: 'checkbox',
                role: 'switch',
                'aria-label': t('allowControlCurrentDevice'),
                checked: host?.enabled === true,
                onChange: (event: Event) => void setHostAuthorization((event.target as HTMLInputElement).checked),
              }))
            : null)),
      React.createElement('p', { className: 'dshRemoteHostState' },
        status?.deviceName === undefined
          ? hostStateLabel
          : React.createElement(React.Fragment, null,
            React.createElement('span', null, status.deviceName),
            React.createElement('span', { className: 'dshRemoteHostStateDot' }, '·'),
            React.createElement('span', null, hostStateLabel))),
      React.createElement('div', { className: 'dshRemoteSectionHeading' },
        React.createElement('div', { className: 'dshRemoteSectionTitle' },
          React.createElement('strong', null, t('currentConnectedDevices')),
          React.createElement('span', null, t('connectedClientCount', { count: connectedClients.length })))),
      React.createElement('div', { className: 'dshRemoteClientList', 'aria-label': t('currentConnectedDevices') },
        ...connectedClients.map(client => React.createElement('div', {
          key: client.deviceId,
          className: 'dshRemoteClientRow',
        },
          React.createElement('span', { className: 'dshRemoteHostNameLine' },
            React.createElement('strong', null, client.name.trim() === '' ? t('unknownDevice') : client.name),
            React.createElement('small', null, [
              client.platform === undefined ? undefined : formatPlatform(client.platform),
              connectedClientModeLabel(client.mode, t),
            ].filter(value => value !== undefined).join(' · '))),
          React.createElement('small', { className: 'dshRemoteClientOnline' }, t('connected'))))))

    const errorNotice = error === undefined
      ? null
      : React.createElement('p', { className: 'dshRemoteError', role: 'alert' }, error)

    return React.createElement(React.Fragment, null,
      compact
        ? React.createElement(RemoteAccountEntry, { portal: props.portal, fallback: entry }, accountEntry)
        : entry,
      !open
        ? null
        : renderBodyPortal(portal, React.createElement('div', {
          className: 'dshRemoteBackdrop',
          role: 'presentation',
          onMouseDown: (event: MouseEvent) => {
            if (event.target === event.currentTarget) setOpen(false)
          },
        }, React.createElement('section', {
          className: 'dshRemotePage',
          role: 'dialog',
          'aria-modal': true,
          'aria-label': t('remoteTitle'),
          tabIndex: -1,
          ref: pageRef,
        },
          React.createElement('header', { className: 'dshRemotePageHeader' },
            React.createElement('div', { className: 'dshRemotePageIntro' },
              React.createElement('div', { className: 'dshRemotePageTitleRow' },
                React.createElement('strong', null, t('remoteTitle')),
                React.createElement('a', {
                  className: 'dshRemoteStarLink',
                  href: 'https://github.com/liguobao/ds-harness-remote',
                  target: '_blank',
                  rel: 'noreferrer',
                }, t('starProject'))),
              React.createElement('p', null, t('remoteDescription'))),
            React.createElement('div', { className: 'dshRemotePageActions' },
              React.createElement('button', {
                type: 'button',
                className: 'dshRemotePageRefresh',
                disabled: busy,
                title: t('refreshRemote'),
                'aria-label': t('refreshRemote'),
                onClick: () => void refreshRemote(),
              }, t('refreshRemoteShort')),
              React.createElement('button', {
                type: 'button',
                className: 'dshRemotePageClose',
                'aria-label': t('close'),
                onClick: () => setOpen(false),
              }, '×'))),
          React.createElement('main', { className: 'dshRemotePageBody' },
            errorNotice,
            relayAccessPanel,
            hostControlPanel)))))
  }

  return RemoteWorkspaceAction
}
