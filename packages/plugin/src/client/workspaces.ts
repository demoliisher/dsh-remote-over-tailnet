import { createServerNotice } from './server-notice.js'
import { renderBodyPortal } from './portal.js'
import type { Translate } from '../client-locale.js'
import type { StatusFeed } from '../status-stream.js'
import { compareVersions } from '../version-compare.js'
import { connectedClientModeLabel, connectionErrorMessage, displayRemoteAccount, formatPlatform, messageOf, startupErrorMessage } from './presentation.js'
import type {
  ClientReact,
  RemoteStatus,
  PluginSettingsView,
  PortalRenderer,
  SidebarEntryPreference,
  SidebarEntryStyle,
  TailnetCredentialsView,
} from './types.js'

export function createRemoteWorkspaceAction(React: ClientReact, portal?: PortalRenderer) {
  const ServerNotice = createServerNotice(React)

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
    subscribeOpen: (listener: () => void) => () => void
    sidebarEntry: SidebarEntryPreference
    portal?: PortalRenderer
    t: Translate
    openSettings?: () => void
  }): unknown {
    const { t } = props
    const connectionErrorMessageFor = (reason: unknown, translate: Translate): string => {
      if (typeof reason === 'object' && reason !== null && 'code' in reason) {
        const code = (reason as { code?: unknown }).code
        if (typeof code === 'string') return connectionErrorMessage(code, translate)
      }
      return messageOf(reason, translate)
    }
    const [open, setOpen] = React.useState(false)
    const [status, setStatus] = React.useState<RemoteStatus | undefined>(undefined)
    const [devicesOpen, setDevicesOpen] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    // Remain undecided until local credentials or an explicit auth rejection
    // establish that login is required. Network failures are not sign-outs.
    const [needsAuthorization, setNeedsAuthorization] = React.useState<boolean | undefined>(undefined)
    const [email, setEmail] = React.useState('')
    const [password, setPassword] = React.useState('')
    const [loginSecretVisible, setLoginSecretVisible] = React.useState(false)
    // 本机中继的账号密码：打开面板时读取，登录表单与「主机」页共用这组值。
    const [relayCredentials, setRelayCredentials] = React.useState<TailnetCredentialsView | undefined>(undefined)
    const [relayAccountDraft, setRelayAccountDraft] = React.useState('')
    const [relayPasswordDraft, setRelayPasswordDraft] = React.useState('')
    const [relaySecretVisible, setRelaySecretVisible] = React.useState(false)
    const [relayCopied, setRelayCopied] = React.useState('')
    const [relaySaved, setRelaySaved] = React.useState(false)
    const autoSignInAttempted = React.useRef(false)
    const [hostEmail, setHostEmail] = React.useState('')
    const [hostPassword, setHostPassword] = React.useState('')
    const [hostRegistrationCode, setHostRegistrationCode] = React.useState('')
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
      if (!open) {
        setDevicesOpen(false)
        setBusy(false)
      }
    }, [open])

    React.useEffect(() => {
      if (!open) return
      const frame = window.requestAnimationFrame(() => pageRef.current?.focus())
      return () => window.cancelAnimationFrame(frame)
    }, [open])

    React.useEffect(() => {
      if (!open) return
      const closeOnEscape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return
        if (devicesOpen) {
          event.stopPropagation()
          setDevicesOpen(false)
          return
        }
        setOpen(false)
      }
      window.addEventListener('keydown', closeOnEscape)
      return () => window.removeEventListener('keydown', closeOnEscape)
    }, [open, devicesOpen])

    React.useEffect(() => {
      if (!devicesOpen) return
      const closeOnPointer = (event: MouseEvent): void => {
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest('.dshRemoteConnectedMenu') !== null) return
        setDevicesOpen(false)
      }
      window.addEventListener('mousedown', closeOnPointer)
      return () => window.removeEventListener('mousedown', closeOnPointer)
    }, [devicesOpen])

    React.useEffect(() => {
      if ((status?.host?.connectedClients?.length ?? 0) === 0) setDevicesOpen(false)
    }, [status?.host?.connectedClients?.length])

    React.useEffect(() => {
      void props.control<RemoteStatus>('status').then(setStatus).catch(() => undefined)
    }, [])

    const copyRelayValue = async (value: string): Promise<void> => {
      try { await navigator.clipboard.writeText(value) } catch { return }
      setRelayCopied(value)
      window.setTimeout(() => setRelayCopied(current => current === value ? '' : current), 2000)
    }

    // Tailscale 组网可用时，用本机中继账号直接完成客户端登录，不再要求手填。
    // 登录只走 client.account.login，不改插件角色，避免重启后中继被当成客户端停掉。
    const autoSignIn = async (view: RemoteStatus | undefined): Promise<boolean> => {
      if (view?.tailnet?.phase !== 'ready' || view.tailnet.publicUrl === undefined) return false
      try {
        const credentials = await props.control<TailnetCredentialsView | null>('tailnet.credentials').catch(() => null)
        if (credentials === null) return false
        setRelayCredentials(credentials)
        setEmail(credentials.account)
        setPassword(credentials.password)
        await props.control('client.account.login', { email: credentials.account, password: credentials.password })
        setStatus(await props.control<RemoteStatus>('status'))
        setNeedsAuthorization(false)
        setPassword('')
        return true
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
        return false
      }
    }

    // 取本机中继账号：登录表单与「主机」页的凭据面板共用。取不到说明当前没有
    // 本地中继（客户端模式或 Tailscale 组网关闭），保留空输入由用户手填。
    React.useEffect(() => {
      if (!open) return undefined
      let cancelled = false
      void props.control<TailnetCredentialsView | null>('tailnet.credentials')
        .then(credentials => {
          if (cancelled || credentials === null) return
          setRelayCredentials(credentials)
          if (needsAuthorization !== true) return
          setEmail(previous => previous === '' ? credentials.account : previous)
          setPassword(previous => previous === '' ? credentials.password : previous)
        })
        .catch(() => undefined)
      return () => { cancelled = true }
    }, [open, needsAuthorization, props.control])

    React.useEffect(() => {
      if (relayCredentials === undefined) return
      setRelayAccountDraft(relayCredentials.account)
      setRelayPasswordDraft(relayCredentials.password)
    }, [relayCredentials])

    // 面板打开且确实需要登录时自动登录一次；主动退出登录后保持未登录状态。
    React.useEffect(() => {
      if (!open) {
        autoSignInAttempted.current = false
        return
      }
      if (needsAuthorization !== true || status?.tailnet?.phase !== 'ready' || autoSignInAttempted.current) return
      autoSignInAttempted.current = true
      void autoSignIn(status)
    }, [open, needsAuthorization, status?.tailnet?.phase, props.control])

    React.useEffect(() => {
      const remoteActive = status?.mode === 'remote'
      document.documentElement.classList.toggle('dshRemoteTargetActive', remoteActive)
      return () => {
        if (remoteActive) document.documentElement.classList.remove('dshRemoteTargetActive')
      }
    }, [status?.mode])

    const refreshRemote = async (): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        const nextStatus = await props.control<RemoteStatus>('status')
        setStatus(nextStatus)
        if (nextStatus.controlUnavailable) {
          setNeedsAuthorization(undefined)
          setError(t('remoteControlUnavailable'))
          return
        }
        if (nextStatus.startupError !== undefined) {
          setNeedsAuthorization(undefined)
          setError(startupErrorMessage(nextStatus.startupError, t))
          return
        }
        if (nextStatus.host?.pairingHostOnly) {
          // Host credentials establish an inbound-only signed-in view. Never
          // query a Client identity here.
          setNeedsAuthorization(!nextStatus.host.authorized || nextStatus.host.accountRequired)
          return
        }
        if (!nextStatus.available) {
          setNeedsAuthorization(false)
          return
        }
        try {
          if (nextStatus.clientAuthRequired) {
            throw Object.assign(new Error('Sign in again.'), { code: 'AUTH_INVALID' })
          }
          const authorization = await props.control<{ hasCredentials: boolean }>('client.authorization.status')
          if (!authorization.hasCredentials) {
            throw Object.assign(new Error('Remote account authorization is required.'), { code: 'ACCOUNT_AUTH_REQUIRED' })
          }
          // Local credentials establish the signed-in view even when the relay
          // is unreachable. The Host status remains authoritative.
          setNeedsAuthorization(false)
        } catch (reason) {
          // A transient relay outage is not a sign-out. Only an explicit auth
          // failure switches the page back to the login form.
          const code = typeof reason === 'object' && reason !== null && 'code' in reason
            ? String((reason as { code: unknown }).code)
            : ''
          if (['ACCOUNT_AUTH_REQUIRED', 'AUTH_INVALID', 'AUTH_REQUIRED', 'TOKEN_EXPIRED', 'DEVICE_REVOKED', 'DEVICE_OWNERSHIP_REQUIRED'].includes(code)) {
            setNeedsAuthorization(true)
          } else {
            setError(messageOf(reason, t))
          }
        }
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const show = async (): Promise<void> => {
      setOpen(true)
      await refreshRemote()
    }

    React.useEffect(() => props.subscribeOpen(() => { void show() }), [props.subscribeOpen, show])

    React.useEffect(() => {
      // The pushed status drives the sidebar entry (update badge, remote mode)
      // and the open modal alike; the subscription replays the latest status
      // immediately, so the entry reflects the startup registry check without
      // waiting for the modal to be opened.
      return props.statusFeed.subscribe(next => {
        setStatus(next)
        if (next.host?.pairingHostOnly) {
          setNeedsAuthorization(!next.host.authorized || next.host.accountRequired)
        }
      })
    }, [props.statusFeed])

    const signInClient = async (): Promise<void> => {
      if (email.trim() === '' || password === '') return
      setBusy(true)
      setError(undefined)
      try {
        // 面板上的账号密码就是本机中继的账号密码：改过就先写回中继并让 Host 重新授权，
        // 这样客户端与桌面端始终用同一套凭据。
        if (relayCredentials !== undefined && (email.trim() !== relayCredentials.account || password !== relayCredentials.password)) {
          await props.control('tailnet.credentials.update', { account: email.trim(), password })
          setRelayCredentials({ account: email.trim(), password })
        }
        await props.control('client.account.login', { email: email.trim(), password })
        setStatus(await props.control<RemoteStatus>('status'))
        setNeedsAuthorization(false)
        setPassword('')
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
      } finally {
        setBusy(false)
      }
    }

    // 「主机」页的凭据面板：改邮箱或密码后写回中继，并用新凭据重新登录客户端。
    const saveRelayCredentials = async (): Promise<void> => {
      if (relayAccountDraft.trim() === '' || relayPasswordDraft === '') return
      if (relayCredentials !== undefined && relayAccountDraft.trim() === relayCredentials.account && relayPasswordDraft === relayCredentials.password) return
      setBusy(true)
      setError(undefined)
      setRelaySaved(false)
      try {
        const next = { account: relayAccountDraft.trim(), password: relayPasswordDraft }
        await props.control('tailnet.credentials.update', next)
        setRelayCredentials(next)
        await props.control('client.account.login', { email: next.account, password: next.password })
        setStatus(await props.control<RemoteStatus>('status'))
        setRelaySaved(true)
        window.setTimeout(() => setRelaySaved(false), 2500)
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const authorizeHost = async (kind: 'account' | 'code'): Promise<void> => {
      if (kind === 'account' && (hostEmail.trim() === '' || hostPassword === '')) return
      if (kind === 'code' && hostRegistrationCode.trim() === '') return
      setBusy(true)
      setError(undefined)
      try {
        if (kind === 'account') {
          await props.control('host.account.login', { email: hostEmail.trim(), password: hostPassword })
          setHostPassword('')
        } else {
          await props.control('host.registration-code.submit', { code: hostRegistrationCode.trim() })
          setHostRegistrationCode('')
        }
        setStatus(await props.control<RemoteStatus>('status'))
      } catch (reason) {
        setError(connectionErrorMessageFor(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const setCurrentDeviceControl = async (enabled: boolean): Promise<void> => {
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

    const logoutRemote = async (): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        await props.control('client.logout')
        autoSignInAttempted.current = true
        setPassword('')
        setNeedsAuthorization(true)
        setStatus(await props.control<RemoteStatus>('status'))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setBusy(false)
      }
    }

    const remoteLabel = status?.clientAuthRequired === true ? t('clientSignInAgain') : t('remoteEntry')
    // The status payload crosses the loopback SSE wire; a malformed update
    // field reads as "no update info" rather than feeding render-time parsing.
    const rawUpdate = status?.update
    const updateInfo = rawUpdate !== undefined
      && typeof rawUpdate.currentVersion === 'string'
      && typeof rawUpdate.latestVersion === 'string'
      ? rawUpdate
      : undefined
    const localUpdateAvailable = updateInfo !== undefined
      && compareVersions(updateInfo.currentVersion, updateInfo.latestVersion) < 0
    const updateNotice = updateInfo !== undefined && localUpdateAvailable
      ? t('updateAvailable', { latest: updateInfo.latestVersion, current: updateInfo.currentVersion })
      : undefined
    const connectedClients = status?.host?.connectedClients ?? []
    const connectedCount = connectedClients.length
    const connectedCountLabel = t('connectedClientCount', { count: connectedCount })
    const connectedMenu = !needsAuthorization && status?.hostAuthorizationAvailable === true
      ? React.createElement('div', {
        className: `dshRemoteConnectedMenu${devicesOpen ? ' isOpen' : ''}`,
      },
        React.createElement('a', {
          href: connectedCount > 0 ? '#connected-devices' : undefined,
          className: `dshRemoteConnectedCount${connectedCount > 0 ? ' isOnline isInteractive' : ''}`,
          'aria-expanded': connectedCount > 0 ? devicesOpen : undefined,
          'aria-haspopup': connectedCount > 0 ? 'dialog' : undefined,
          title: connectedCountLabel,
          'aria-label': connectedCountLabel,
          onClick: (event: Event) => {
            event.preventDefault()
            if (connectedCount === 0) return
            setDevicesOpen(current => !current)
          },
        }, connectedCountLabel),
        devicesOpen && connectedCount > 0
          ? React.createElement('div', {
            className: 'dshRemoteConnectedPanel',
            id: 'connected-devices',
            role: 'dialog',
            'aria-label': t('currentConnectedDevices'),
          },
            React.createElement('div', { className: 'dshRemoteConnectedPanelHeader' },
              React.createElement('strong', { className: 'dshRemoteConnectedPanelTitle' }, t('currentConnectedDevices')),
              React.createElement(ServerNotice, {
                countdownOnly: true,
                offline: status?.host?.online === false && status.host.reconnecting,
                linked: connectedCount > 0, expiresAt: status?.host?.recoveryExpiresAt, t,
              })),
            React.createElement(
              'div',
              { className: 'dshRemoteClientList', 'aria-label': t('currentConnectedDevices') },
              ...connectedClients.map(client => React.createElement('div', {
                key: client.deviceId,
                className: 'dshRemoteClientRow',
              },
                React.createElement('span', null,
                  React.createElement('span', { className: 'dshRemoteHostNameLine' },
                    React.createElement('strong', null, client.name.trim() === '' ? t('unknownDevice') : client.name),
                    null),
                  React.createElement('small', null, [
                    client.platform === undefined ? undefined : formatPlatform(client.platform),
                    connectedClientModeLabel(client.mode, t),
                  ].filter(Boolean).join(' · '))),
                React.createElement('small', { className: 'dshRemoteClientOnline' }, t('connected')))),
            ))
          : null)
      : null

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
    // Wide entry: the button stretches full width and carries the update suffix
    // in the host's own update-indicator look. Rail/Compact entries are
    // icon-only, so they get the official 6px brand dot instead.
    const updateSuffix = localUpdateAvailable && props.wide
      ? React.createElement('span', {
        className: 'dshRemoteUpdateSuffix',
        title: updateNotice, 'aria-hidden': true,
      }, t('updateShort', { version: updateInfo?.latestVersion ?? '' }))
      : null
    const updateDot = localUpdateAvailable
      ? React.createElement('span', { className: 'dshRemoteUpdateDot', title: t('updateBadge'), 'aria-hidden': true })
      : null
    const entry = React.createElement('div', { className: `dshRemoteSidebarEntry${props.wide ? ' isWide' : ' isRail'}${localUpdateAvailable ? ' hasUpdate' : ''}` },
      React.createElement('button', {
        type: 'button',
        disabled: busy,
        onClick: () => void show(),
        className: 'dshRemoteModeButton',
        title: remoteLabel,
        'aria-label': remoteLabel,
      }, computerIcon, props.wide
        ? React.createElement('span', { className: 'dshRemoteSidebarLabel' }, remoteLabel)
        : null, props.wide ? updateSuffix : updateDot))
    // The Compact style drops the label and lives in the account row.
    const accountEntry = React.createElement('div', { className: 'dshRemoteAccountEntry' },
      React.createElement('button', {
        type: 'button',
        className: 'dshRemoteAccountEntryButton',
        disabled: busy,
        title: remoteLabel,
        'aria-label': remoteLabel,
        onClick: () => void show(),
      }, computerIcon, updateDot))
    const compact = sidebarEntry === 'compact' && props.wide && props.portal !== undefined
    // 客户端要填的服务地址：优先 Tailscale 对外域名；没有组网时退回当前服务器地址。
    const serviceAddress = status?.tailnet?.publicUrl ?? status?.serverUrl
    const relayAddressBar = serviceAddress === undefined ? null : React.createElement('div', { className: 'dshRemoteRelayAddress' },
      React.createElement('span', { className: 'dshRemoteRelayAddressLabel' }, t('tailnetServerAddress')),
      React.createElement('a', { href: serviceAddress, target: '_blank', rel: 'noreferrer' }, serviceAddress),
      React.createElement('button', {
        type: 'button',
        className: 'dshRemoteRelayCopy',
        onClick: () => void copyRelayValue(serviceAddress),
      }, t(relayCopied === serviceAddress ? 'tailnetCopied' : 'tailnetCopy')))
    // 登录成功后「主机」页顶部的连接信息：服务地址、邮箱、密码三项放在一起，
    // 方便直接抄给其他客户端；只有邮箱与密码可以改，改完写回中继并重新登录。
    const relayAccessPanel = status?.tailnet?.publicUrl === undefined ? null : React.createElement('section', {
      className: 'dshRemoteRelayAccess',
      'aria-label': t('tailnetAccessTitle'),
    },
      React.createElement('div', { className: 'dshRemoteRelayAccessHeading' },
        React.createElement('strong', null, t('tailnetAccessTitle')),
        React.createElement('p', null, t('tailnetAccessHint'))),
      relayAddressBar,
      React.createElement('div', { className: 'dshRemoteRelayFields' },
        React.createElement('label', null, t('tailnetAccount'),
          React.createElement('input', {
            type: 'email', value: relayAccountDraft, disabled: busy, autoComplete: 'username',
            onChange: (event: Event) => setRelayAccountDraft((event.target as HTMLInputElement).value),
          })),
        React.createElement('label', null, t('tailnetPassword'),
          React.createElement('div', { className: 'dshRemoteRelayPasswordRow' },
            React.createElement('input', {
              type: relaySecretVisible ? 'text' : 'password', value: relayPasswordDraft, disabled: busy,
              autoComplete: 'current-password',
              onChange: (event: Event) => setRelayPasswordDraft((event.target as HTMLInputElement).value),
            }),
            React.createElement('button', {
              type: 'button', className: 'dshRemoteRelayCopy', disabled: busy,
              onClick: () => setRelaySecretVisible(visible => !visible),
            }, t(relaySecretVisible ? 'tailnetHideSecret' : 'tailnetShowSecret')),
            React.createElement('button', {
              type: 'button', className: 'dshRemoteRelayCopy', disabled: busy,
              onClick: () => void copyRelayValue(relayPasswordDraft),
            }, t(relayCopied === relayPasswordDraft ? 'tailnetCopied' : 'tailnetCopy'))))),
      React.createElement('div', { className: 'dshRemoteRelayActions' },
        React.createElement('button', {
          type: 'button',
          disabled: busy || relayAccountDraft.trim() === '' || relayPasswordDraft === ''
            || (relayCredentials !== undefined
              && relayAccountDraft.trim() === relayCredentials.account
              && relayPasswordDraft === relayCredentials.password),
          onClick: () => void saveRelayCredentials(),
        }, t(busy ? 'saving' : 'tailnetSaveCredentials')),
        relaySaved ? React.createElement('span', { className: 'dshRemoteRelaySaved' }, t('tailnetCredentialsSaved')) : null))

    return React.createElement(React.Fragment, null,
      compact
        ? React.createElement(RemoteAccountEntry, { portal: props.portal, fallback: entry }, accountEntry)
        : entry,
      !open ? null : renderBodyPortal(portal, React.createElement('div', {
        className: 'dshRemoteBackdrop',
        role: 'presentation',
        onMouseDown: (event: MouseEvent) => { if (event.target === event.currentTarget) setOpen(false) },
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
            React.createElement('p', null, t(status?.host?.pairingHostOnly ? 'pairingHostOnly' : 'remoteDescription'))),
          React.createElement('div', { className: 'dshRemotePageActions' },
            React.createElement('button', {
              type: 'button',
              className: 'dshRemotePageRefresh',
              disabled: busy,
              title: t('refreshRemote'),
              'aria-label': t('refreshRemote'),
              onClick: () => void refreshRemote(),
            }, t('refreshRemoteShort')),
            React.createElement('button', { type: 'button', className: 'dshRemotePageClose', onClick: () => setOpen(false), 'aria-label': t('close') }, '×'))),
        React.createElement('main', { className: 'dshRemotePageBody' },
          React.createElement(React.Fragment, null,
            needsAuthorization === undefined && busy
              ? React.createElement('p', null, t('checkingConnection')) : null,
            needsAuthorization ? React.createElement('section', { className: 'dshRemoteEnable' },
              React.createElement('div', { className: 'dshRemoteLoginHeading' },
                React.createElement('a', {
                  href: 'https://github.com/liguobao/ds-harness-remote',
                  target: '_blank', rel: 'noopener noreferrer',
                },
                  React.createElement('strong', { className: 'dshRemoteLoginTitle' }, t('signInClient')),
                  React.createElement('span', null, t('signInClientDescription')))),
              React.createElement('div', { className: 'dshRemoteClientLogin' },
                relayAddressBar,
                React.createElement('input', {
                  type: 'email', value: email, disabled: busy, autoComplete: 'username', placeholder: t('account'),
                  'aria-label': t('account'), onChange: (event: Event) => setEmail((event.target as HTMLInputElement).value),
                }),
                React.createElement('input', {
                  type: loginSecretVisible ? 'text' : 'password', value: password, disabled: busy, autoComplete: 'current-password', placeholder: t('password'),
                  'aria-label': t('password'), onChange: (event: Event) => setPassword((event.target as HTMLInputElement).value),
                }),
                React.createElement('button', {
                  type: 'button', className: 'dshRemoteSecretToggle', disabled: busy,
                  onClick: () => setLoginSecretVisible(visible => !visible),
                }, t(loginSecretVisible ? 'tailnetHideSecret' : 'tailnetShowSecret')),
                React.createElement('button', { type: 'button', disabled: busy || email.trim() === '' || password === '', onClick: () => void signInClient() }, t(busy ? 'signingIn' : 'startSignIn')),
                React.createElement('p', { className: 'dshRemotePasswordHint' }, t('passwordHint')))) : null,
            needsAuthorization !== false ? null : React.createElement(React.Fragment, null,
              React.createElement('section', { className: 'dshRemoteHosts', 'aria-label': t('chooseHost') },
                relayAccessPanel,
                status?.hostAuthorizationAvailable && status.host?.accountRequired
                  ? React.createElement('section', { className: 'dshRemoteHostAccount' },
                    React.createElement('strong', null, t('thisMachineHost')),
                    React.createElement('p', null, t('hostSignInHint')),
                    React.createElement('div', { className: 'dshRemoteLogin' },
                      React.createElement('input', { type: 'email', value: hostEmail, disabled: busy, autoComplete: 'username', placeholder: t('serverAccountEmail'), 'aria-label': t('serverAccountEmail'), onChange: (event: Event) => setHostEmail((event.target as HTMLInputElement).value) }),
                      React.createElement('input', { type: 'password', value: hostPassword, disabled: busy, autoComplete: 'current-password', placeholder: t('serverAccountPassword'), 'aria-label': t('serverAccountPassword'), onChange: (event: Event) => setHostPassword((event.target as HTMLInputElement).value) }),
                      React.createElement('button', { type: 'button', disabled: busy || hostEmail.trim() === '' || hostPassword === '', onClick: () => void authorizeHost('account') }, t(busy ? 'signingIn' : 'signInRegisterHost')),
                      React.createElement('input', { value: hostRegistrationCode, disabled: busy, autoComplete: 'one-time-code', placeholder: t('hostRegistrationCode'), 'aria-label': t('hostRegistrationCode'), onChange: (event: Event) => setHostRegistrationCode((event.target as HTMLInputElement).value) }),
                      React.createElement('button', { type: 'button', disabled: busy || hostRegistrationCode.trim() === '', onClick: () => void authorizeHost('code') }, t(busy ? 'registering' : 'useRegistrationCode'))))
                  : null,
                React.createElement('div', { className: 'dshRemoteSectionHeading' },
                  React.createElement('div', { className: 'dshRemoteSectionTitle' },
                    React.createElement('strong', null, t(status?.host?.pairingHostOnly ? 'thisMachineHost' : 'chooseHost')),
                    status?.hostAuthorizationAvailable ? React.createElement('div', { className: 'dshRemoteHostControlToggle' },
                      React.createElement('span', null, t('allowControlDevice')),
                      React.createElement('input', {
                        type: 'checkbox', role: 'switch', disabled: busy,
                        'aria-label': t('allowControlDevice'),
                        checked: status.host?.authorized === true,
                        onChange: (event: Event) => void setCurrentDeviceControl((event.target as HTMLInputElement).checked),
                      })) : null,
                    connectedMenu)),
              React.createElement('footer', { className: 'dshRemoteAccountFooter' },
                React.createElement('span', { className: 'dshRemoteHostNameLine' },
                  React.createElement('span', null, status?.target?.name ?? status?.deviceName ?? (status?.host?.account === undefined ? t('account') : displayRemoteAccount(status.host.account))),
                  React.createElement(ServerNotice, {
                    offline: status?.host?.online === false && status.host.reconnecting,
                    linked: connectedCount > 0 || status?.connected === true,
                    expiresAt: status?.host?.recoveryExpiresAt ?? status?.network?.recoveryExpiresAt, t,
                  })),
                updateNotice === undefined ? null : React.createElement('a', {
                  className: 'dshRemoteAccountUpdate',
                  href: 'https://github.com/liguobao/ds-harness-remote/releases',
                  target: '_blank',
                  rel: 'noreferrer',
                  title: updateNotice,
                }, t('updateAvailableShort', { version: updateInfo?.latestVersion ?? '' })),
                props.openSettings === undefined ? null : React.createElement('button', {
                  type: 'button', className: 'dshRemoteAccountSettings',
                  onClick: props.openSettings,
                  'aria-label': t('settings'), title: t('settings'),
                }, t('settings')),
                React.createElement('button', {
                  type: 'button', className: 'dshRemoteAccountExit', disabled: busy,
                  onClick: () => void logoutRemote(),
                }, t('exitRemoteAccount')))),
            error === undefined ? null : React.createElement('p', { className: 'dshRemoteError', role: 'alert' }, error))))))))
  }

  return RemoteWorkspaceAction
}
