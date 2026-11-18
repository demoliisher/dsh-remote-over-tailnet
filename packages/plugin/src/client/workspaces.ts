import { renderBodyPortal } from './portal.js'
import type { Translate } from '../client-locale.js'
import type { StatusFeed } from '../status-stream.js'
import { messageOf, startupErrorMessage } from './presentation.js'
import { SSH_LISTEN_PORT, SYSTEM_SSH_PORT } from '../embedded-ports.js'
import type {
  ClientReact,
  PluginSettingsView,
  PortalRenderer,
  RemoteStatus,
  SidebarEntryPreference,
  SidebarEntryStyle,
  TailnetCredentialsView,
} from './types.js'

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
    const [saving, setSaving] = React.useState(false)
    const [serviceBusy, setServiceBusy] = React.useState(false)
    const [tailnetEnabled, setTailnetEnabled] = React.useState(true)
    const [tailnetBusy, setTailnetBusy] = React.useState(false)
    // 组网模式与系统客户端、扩展下载状态；模式切换与各端点都走控制接口。
    const [networkMode, setNetworkMode] = React.useState<'system' | 'embedded'>('system')
    const [modeBusy, setModeBusy] = React.useState(false)
    const [extensionBusy, setExtensionBusy] = React.useState(false)
    const [refreshing, setRefreshing] = React.useState(false)
    // 中继账号密码按需读取：状态推送里不带密码，面板打开时才向 Host 要。
    const [relayCredentials, setRelayCredentials] = React.useState<TailnetCredentialsView | undefined>(undefined)
    const [relayAccountDraft, setRelayAccountDraft] = React.useState('')
    const [relayPasswordDraft, setRelayPasswordDraft] = React.useState('')
    const [relaySecretVisible, setRelaySecretVisible] = React.useState(false)
    // 地址呈现方式：同一个节点既有 ts.net 域名也有 tailnet IPv4，两者同时可用。
    const [addressKind, setAddressKind] = React.useState<'domain' | 'ip'>('domain')
    // SSH 服务的开关与登录信息，与中继账号一样按需读取。
    const [sshEnabled, setSshEnabled] = React.useState(false)
    const [sshBusy, setSshBusy] = React.useState(false)
    const [sshToken, setSshToken] = React.useState('')
    // Host 早于 SSH 模式时 settings.get 不返回 ssh 字段，面板要如实说明，不能留一个点不动的开关。
    const [sshSupported, setSshSupported] = React.useState(true)
    const [sshError, setSshError] = React.useState<string | undefined>(undefined)
    // 已固定的端口记在配置里；SSH 未监听时用这份记录继续显示原来的数值。
    const [sshPinnedSavedPort, setSshPinnedSavedPort] = React.useState<number | undefined>(undefined)
    const [savedSection, setSavedSection] = React.useState<'connection' | 'relay' | undefined>(undefined)
    const [deviceNameDraft, setDeviceNameDraft] = React.useState('')
    const pageRef = React.useRef<HTMLElement | null>(null)
    // 状态推送每秒都会触发重渲染，父组件可能顺手换掉 control 的函数身份；
    // 打开面板时的读取只该跑一次，所以经 ref 取最新函数，不把它放进依赖。
    const controlRef = React.useRef(props.control)
    controlRef.current = props.control
    const [error, setError] = React.useState<string | undefined>(undefined)
    const [sidebarEntry, setSidebarEntry] = React.useState<SidebarEntryStyle>(() => props.sidebarEntry.read())

    // The settings page publishes the saved style, so the entry moves without a
    // reload; the first fetch below seeds it for a fresh page.
    React.useEffect(
      () => props.sidebarEntry.subscribe(() => setSidebarEntry(props.sidebarEntry.read())),
      [props.sidebarEntry],
    )
    React.useEffect(() => {
      void controlRef.current<PluginSettingsView>('settings.get')
        .then(view => props.sidebarEntry.publish(view.config.sidebar?.entry ?? 'standard'))
        .catch(() => undefined)
    }, [props.sidebarEntry])

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

    // 账号密码由 DSH Remote 与 SSH 共用，内嵌节点一运行就要读出来。
    const serviceEnabled = status?.host?.enabled
    // 凭据在节点启动时生成，节点就绪后再读一次，避免面板早于节点打开时留下空字段。
    const tailnetReady = status?.tailnet?.phase === 'ready'
    React.useEffect(() => {
      if (!open || !tailnetReady) return undefined
      let cancelled = false
      void controlRef.current<TailnetCredentialsView | null>('tailnet.credentials')
        .then(credentials => {
          if (cancelled || credentials === null) return
          setRelayCredentials(credentials)
        })
        .catch(() => { if (!cancelled) setRelayCredentials(undefined) })
      return () => { cancelled = true }
    }, [open, tailnetReady])

    React.useEffect(() => {
      if (relayCredentials === undefined) return
      setRelayAccountDraft(relayCredentials.account)
      setRelayPasswordDraft(relayCredentials.password)
    }, [relayCredentials])

    // 打开面板时读一次 SSH 配置，开关以已保存的值为准。
    React.useEffect(() => {
      if (!open) return undefined
      let cancelled = false
      void controlRef.current<PluginSettingsView>('settings.get')
        .then(view => {
          if (cancelled) return
          setSshSupported(view.config.ssh !== undefined)
          setSshEnabled(view.config.ssh?.enabled ?? false)
          setSshPinnedSavedPort(view.config.ssh?.pinnedPort)
          setTailnetEnabled(view.config.tailnet?.enabled ?? true)
          setNetworkMode(view.config.tailnet?.mode ?? 'system')
        })
        .catch(() => undefined)
      return () => { cancelled = true }
    }, [open])

    // SSH 监听就绪后取一次登录令牌；账号密码走上面共享卡片。
    const sshListeningPort = status?.tailnet?.ssh?.port
    React.useEffect(() => {
      if (!open || sshListeningPort === undefined) {
        setSshToken('')
        return undefined
      }
      let cancelled = false
      void controlRef.current<{ token?: string }>('tailnet.ssh.credentials')
        .then(value => {
          if (!cancelled) setSshToken(value.token ?? '')
        })
        .catch(() => { if (!cancelled) setSshToken('') })
      return () => { cancelled = true }
    }, [open, sshListeningPort])

    // 状态推送只在名称真的变化时覆盖输入框，用户正在编辑的内容不会被重连事件冲掉。
    React.useEffect(() => {
      if (!open) return
      setDeviceNameDraft(status?.deviceName ?? '')
    }, [open, status?.deviceName])

    const refreshRemote = async (): Promise<void> => {
      setRefreshing(true)
      setError(undefined)
      try {
        const nextStatus = await props.control<RemoteStatus>('status')
        setStatus(nextStatus)
        if (nextStatus.startupError !== undefined) setError(startupErrorMessage(nextStatus.startupError, t))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setRefreshing(false)
      }
    }

    const show = async (): Promise<void> => {
      setOpen(true)
      await refreshRemote()
    }

    const relayDraftUnchanged = relayCredentials !== undefined
      && relayAccountDraft.trim() === relayCredentials.account
      && relayPasswordDraft === relayCredentials.password
    const trimmedDeviceName = deviceNameDraft.trim()
    const deviceNameChanged = trimmedDeviceName !== (status?.deviceName ?? '')
    const deviceNameValid = trimmedDeviceName !== '' && trimmedDeviceName.length <= 80
    // 名称随时可改；账号密码与 SSH 共用，中继服务或 SSH 任一开启时后端都拒绝改动，面板同步锁住。
    const credentialsChanged = !relayDraftUnchanged && relayAccountDraft.trim() !== '' && relayPasswordDraft !== ''
    const credentialsLocked = serviceEnabled !== false || sshEnabled
    const flashSaved = (section: 'connection' | 'relay'): void => {
      setSavedSection(section)
      window.setTimeout(() => setSavedSection(undefined), 2500)
    }

    const saveDeviceName = async (): Promise<void> => {
      if (!deviceNameValid || !deviceNameChanged) return
      setSaving(true)
      setError(undefined)
      try {
        const nextStatus = await props.control<RemoteStatus>('settings.deviceName.set', { deviceName: trimmedDeviceName })
        setStatus(nextStatus)
        setDeviceNameDraft(nextStatus.deviceName ?? trimmedDeviceName)
        flashSaved('relay')
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setSaving(false)
      }
    }

    const saveSharedCredentials = async (): Promise<void> => {
      if (credentialsLocked || !credentialsChanged) return
      setSaving(true)
      setError(undefined)
      try {
        const nextCredentials = { account: relayAccountDraft.trim(), password: relayPasswordDraft }
        await props.control('tailnet.credentials.save', nextCredentials)
        setRelayCredentials(nextCredentials)
        flashSaved('connection')
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setSaving(false)
      }
    }

    const switchMode = async (mode: 'system' | 'embedded'): Promise<void> => {
      if (mode === networkMode) return
      setModeBusy(true)
      setError(undefined)
      try {
        setStatus(await props.control<RemoteStatus>('tailnet.mode.set', { mode }))
        setNetworkMode(mode)
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setModeBusy(false)
      }
    }

    const refreshSystem = async (): Promise<void> => {
      setModeBusy(true)
      setError(undefined)
      try {
        setStatus(await props.control<RemoteStatus>('tailnet.system.refresh'))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setModeBusy(false)
      }
    }

    const downloadComponent = async (): Promise<void> => {
      setExtensionBusy(true)
      setError(undefined)
      try {
        setStatus(await props.control<RemoteStatus>('tailnet.extension.download'))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setExtensionBusy(false)
      }
    }

    const removeComponent = async (): Promise<void> => {
      setExtensionBusy(true)
      setError(undefined)
      try {
        setStatus(await props.control<RemoteStatus>('tailnet.extension.remove'))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setExtensionBusy(false)
      }
    }
    // 组网模式区块：系统/内嵌切换、系统客户端状态、扩展下载、对外端口。
    const tail = status?.tailnet
    const activeMode = tail?.mode ?? networkMode
    const extension = tail?.extension
    const systemInfo = tail?.system
    const extensionInstalled = extension?.state === 'installed'
    const systemStateLabel = systemInfo === undefined ? undefined
      : systemInfo.state === 'running' ? t('systemRunning')
        : systemInfo.state === 'not-logged-in' ? t('systemNotLoggedIn')
          : systemInfo.state === 'not-installed' ? t('systemNotInstalled') : t('systemStopped')
    const modeChoices = [
      { value: 'system' as const, label: t('modeSystem') },
      { value: 'embedded' as const, label: t('modeEmbedded') },
    ]
    const modeButtons = React.createElement('div', {
      className: 'dshRemoteEntryStyleChoices', role: 'radiogroup', 'aria-label': t('networkMode'),
    }, modeChoices.map(choice => React.createElement('button', {
      key: choice.value, type: 'button', role: 'radio',
      'aria-checked': activeMode === choice.value,
      className: activeMode === choice.value ? 'isSelected' : undefined,
      disabled: modeBusy || tailnetBusy || serviceEnabled === true || sshEnabled
        || (choice.value === 'embedded' && !extensionInstalled),
      title: choice.value === 'embedded' && !extensionInstalled ? t('extensionAbsent') : undefined,
      onClick: () => void switchMode(choice.value),
    }, choice.label)))
    const systemChildren: unknown[] = [
      React.createElement('div', { className: 'dshRemoteRelayFields' },
        React.createElement('label', { className: 'dshRemoteRelayFieldWide' },
          React.createElement('span', { className: 'dshRemoteRelayFieldLabel' }, t('systemStatus')),
          React.createElement('input', { type: 'text', value: systemStateLabel ?? '', readOnly: true })),
        systemInfo?.dnsName === undefined ? null : React.createElement('label', { className: 'dshRemoteRelayFieldWide' },
          React.createElement('span', { className: 'dshRemoteRelayFieldLabel' }, t('connectionAddressDomain')),
          React.createElement('input', { type: 'text', value: systemInfo.dnsName, readOnly: true }))),
      systemInfo?.state === 'not-logged-in'
        ? React.createElement('p', { className: 'dshRemoteSettingsState' }, t('systemLoginHint'),
          systemInfo.authUrl === undefined ? null : React.createElement('a', {
            href: systemInfo.authUrl, target: '_blank', rel: 'noreferrer',
          }, t('openInBrowser')))
        : systemInfo?.state === 'not-installed' || systemInfo?.state === 'stopped'
          ? React.createElement('p', { className: 'dshRemoteSettingsState' }, t('systemInstallHint'))
          : systemInfo?.detail === undefined ? null
            : React.createElement('p', { className: 'dshRemoteSettingsState' }, t('systemDetail') + '：' + systemInfo.detail),
      React.createElement('button', {
        type: 'button', className: 'dshRemotePageRefresh', disabled: modeBusy,
        onClick: () => void refreshSystem(),
      }, t(modeBusy ? 'extensionBusy' : 'refreshSystem')),
    ]
    const systemBlock = activeMode === 'system' && systemStateLabel !== undefined
      ? React.createElement('div', { className: 'dshRemoteSystemStatus' }, systemChildren)
      : null
    const extensionValue = extension === undefined ? ''
      : extension.state === 'installed' ? t('extensionInstalled', { size: String(extension.size ?? '') })
        : extension.state === 'downloading' ? t('extensionDownloading', { progress: String(extension.progress ?? 0) })
          : extension.state === 'error' ? t('extensionError', { message: extension.error ?? '' })
            : t('extensionAbsent')
    const extensionButton = extension?.state === 'installed'
      ? React.createElement('button', {
        type: 'button', disabled: extensionBusy || serviceEnabled === true || sshEnabled,
        onClick: () => void removeComponent(),
      }, t(extensionBusy ? 'extensionBusy' : 'extensionRemove'))
      : React.createElement('button', {
        type: 'button', disabled: extensionBusy || extension?.state === 'downloading',
        onClick: () => void downloadComponent(),
      }, t(extensionBusy ? 'extensionBusy' : 'extensionDownload'))
    const extensionBlock = React.createElement('div', { className: 'dshRemoteExtension' },
      React.createElement('div', { className: 'dshRemoteRelayFields' },
        React.createElement('label', { className: 'dshRemoteRelayFieldWide' },
          React.createElement('span', { className: 'dshRemoteRelayFieldLabel' }, t('extensionTitle')),
          React.createElement('input', { type: 'text', readOnly: true, value: extensionValue }))),
      extension?.state === 'error' ? React.createElement('p', { className: 'dshRemoteError' }, extension.error) : null,
      React.createElement('p', { className: 'dshRemoteSettingsState' }, t('extensionRawOnly')),
      React.createElement('div', { className: 'dshRemoteRelayActions' }, extensionButton))
    const portBlock = tail?.phase === 'ready' && tail.publicPort !== undefined
      ? React.createElement('p', { className: 'dshRemoteSettingsState' },
        t('relayPortLabel') + '：' + String(tail.publicPort) + '　'
        + t('sshPortLabel') + '：' + String(tail.ssh?.port ?? (activeMode === 'system' ? 2222 : 22)))
      : null
    const modeSection = React.createElement('section', {
      className: 'dshRemoteRelayAccess dshRemoteModeSection',
      'aria-label': t('networkMode'),
    },
      React.createElement('div', { className: 'dshRemoteRelayAccessHeading' },
        React.createElement('div', { className: 'dshRemoteSectionTitle' },
          React.createElement('strong', null, t('networkMode'))),
        React.createElement('p', null, t('networkModeHint'))),
      modeButtons,
      systemBlock,
      extensionBlock,
      portBlock)

    // 内嵌节点是中继与 SSH 共用的底座；关节点前要先关掉两个下游服务。
    const setTailnet = async (enabled: boolean): Promise<void> => {
      setTailnetBusy(true)
      setError(undefined)
      try {
        setStatus(await props.control<RemoteStatus>('tailnet.set', { enabled }))
        setTailnetEnabled(enabled)
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setTailnetBusy(false)
      }
    }

    const setRemoteService = async (enabled: boolean): Promise<void> => {
      setServiceBusy(true)
      setError(undefined)
      try {
        setStatus(await props.control<RemoteStatus>('service.set', { enabled }))
      } catch (reason) {
        setError(messageOf(reason, t))
      } finally {
        setServiceBusy(false)
      }
    }

    // 开关走同一个端点，编排就地启停监听，不重启节点。
    const saveSsh = async (enabled: boolean): Promise<void> => {
      setSshBusy(true)
      setSshError(undefined)
      try {
        setStatus(await props.control<RemoteStatus>('ssh.set', { enabled }))
        setSshEnabled(enabled)
      } catch (reason) {
        setSshError(messageOf(reason, t))
      } finally {
        setSshBusy(false)
      }
    }

    // 固定时记录当前实例端口；已固定时点击解绑，恢复跟随当前实例。
    const setSshPinned = async (pinned: boolean): Promise<void> => {
      setSshBusy(true)
      setSshError(undefined)
      try {
        const next = await props.control<RemoteStatus>('ssh.pin', { pinned })
        setStatus(next)
        setSshPinnedSavedPort(next.tailnet?.ssh?.pinnedPort)
      } catch (reason) {
        setSshError(messageOf(reason, t))
      } finally {
        setSshBusy(false)
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
    // 连接数只跟随中继服务开关：关闭时不显示，开启时没有客户端也显示 0。
    const connectedClients = status?.host?.connectedClients ?? []
    const connectedClientCount = status?.host?.enabled === true ? connectedClients.length : undefined
    // 眼睛图标只切换密码的可见性，复制通过选中文本框完成。
    const eyeIcon = (revealed: boolean): unknown => React.createElement('svg', {
      viewBox: '0 0 24 24',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
      React.createElement('path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z' }),
      React.createElement('circle', { cx: 12, cy: 12, r: 3 }),
      revealed ? React.createElement('path', { d: 'M4 4l16 16' }) : null)
    // SSH 服务：地址、账号与密码由上面的连接信息共用，这里只列 SSH 专有的两项。
    const sshReady = tailnet?.ssh
    // 面板显示客户端要填的端口：固定之后一直是固定值，没固定时跟着当前实例走。
    const sshPinnedPort = sshReady?.pinnedPort ?? sshPinnedSavedPort
    const sshDshPort = sshPinnedPort ?? tailnet?.webPort
    const sshPinned = sshPinnedPort !== undefined
    const sshSection = React.createElement('section', {
      className: 'dshRemoteRelayAccess dshRemoteSshBlock',
      'aria-label': t('sshTitle'),
    },
      React.createElement('div', { className: 'dshRemoteRelayAccessHeading dshRemoteRelayHeading' },
        React.createElement('div', { className: 'dshRemoteRelayHeadingMain' },
          React.createElement('div', { className: 'dshRemoteSectionTitle' },
            React.createElement('strong', null, t('sshTitle')),
            sshSupported
              ? React.createElement('span', { className: 'dshRemoteRelayHeadingControls' },
                React.createElement('input', {
                  type: 'checkbox',
                  role: 'switch',
                  className: 'dshRemoteRelaySwitch',
                  'aria-label': t('sshEnable'),
                  checked: sshEnabled,
                  disabled: sshBusy || tailnetBusy || !tailnetEnabled,
                  onChange: (event: Event) => void saveSsh((event.target as HTMLInputElement).checked),
                }))
              : null),
          React.createElement('p', null, t('sshPortSummary', { sshPort: String(tailnet?.ssh?.port ?? (activeMode === 'system' ? SYSTEM_SSH_PORT : SSH_LISTEN_PORT)) }))),
        React.createElement('div', { className: 'dshRemoteRelayNameField' },
          React.createElement('span', null, t('sshDshPort')),
          React.createElement('input', {
            type: 'text',
            value: sshDshPort === undefined ? '' : String(sshDshPort),
            readOnly: true,
            'aria-label': t('sshDshPort'),
            placeholder: '-',
          }),
          sshSupported
            ? React.createElement('button', {
              type: 'button',
              title: t('sshPinHint'),
              onClick: () => void setSshPinned(!sshPinned),
              // 解绑不需要 SSH 在跑；只有固定新端口才要求服务已经就绪。
              disabled: sshBusy || tailnetBusy || (!sshPinned && (!sshEnabled || sshReady === undefined)),
            }, sshPinned ? t('sshPinned') : t('sshPin'))
            : null)),
      sshSupported ? null : React.createElement('p', { className: 'dshRemoteSettingsState' }, t('sshNeedsRestart')),
      sshEnabled && sshReady === undefined && sshSupported
        ? React.createElement('p', { className: 'dshRemoteSettingsState' }, t('sshNotReady'))
        : null,
      sshError === undefined ? null : React.createElement('p', { className: 'dshRemoteSettingsState' }, sshError),
      sshReady === undefined ? null : React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dshRemoteRelayFields' },
          React.createElement('label', { className: 'dshRemoteRelayFieldWide' },
            React.createElement('span', { className: 'dshRemoteRelayFieldLabel' }, t('sshToken')),
            React.createElement('input', { type: 'text', value: sshToken, readOnly: true })),
          React.createElement('label', { className: 'dshRemoteRelayFieldWide' },
            React.createElement('span', { className: 'dshRemoteRelayFieldLabel' }, t('sshFingerprint')),
            React.createElement('input', { type: 'text', value: sshReady.fingerprint, readOnly: true }))),
        React.createElement('p', null, t('sshClientHint'))))

    // 连接信息：地址、账号、密码由 DSH Remote 与 SSH 共用，全局只在这里出现一次。
    const connectionPanel = React.createElement('section', {
      className: 'dshRemoteRelayAccess dshRemoteConnectionBlock',
      'aria-label': t('connectionTitle'),
    },
      React.createElement('div', { className: 'dshRemoteRelayAccessHeading' },
        React.createElement('div', { className: 'dshRemoteSectionTitle' },
          React.createElement('strong', null, t('connectionTitle'))),
        React.createElement('p', null, t('connectionHint'))),
      React.createElement('div', { className: 'dshRemoteRelayFields' },
        React.createElement('label', { className: 'dshRemoteRelayFieldWide' },
          React.createElement('span', { className: 'dshRemoteRelayFieldLabel' }, t('connectionAddress')),
          React.createElement('div', { className: 'dshRemoteAddressPicker' },
            React.createElement('input', {
              type: 'text',
              value: addressKind === 'ip' ? tailnet?.ipv4 ?? '' : tailnet?.dnsName ?? '',
              readOnly: true,
            }),
            React.createElement('select', {
              value: addressKind,
              'aria-label': t('connectionAddressKind'),
              onChange: (event: Event) => setAddressKind((event.target as HTMLSelectElement).value === 'ip' ? 'ip' : 'domain'),
            },
              React.createElement('option', { value: 'domain' }, t('connectionAddressDomain')),
              React.createElement('option', { value: 'ip' }, t('connectionAddressIp'))))),
        React.createElement('label', null,
          React.createElement('span', { className: 'dshRemoteRelayFieldLabel' }, t('tailnetAccount')),
          React.createElement('input', {
            type: 'email',
            value: relayAccountDraft,
            autoComplete: 'username',
            readOnly: credentialsLocked,
            onChange: (event: Event) => setRelayAccountDraft((event.target as HTMLInputElement).value),
          })),
        React.createElement('label', null,
          React.createElement('span', { className: 'dshRemoteRelayFieldLabel' }, t('tailnetPassword')),
          React.createElement('div', { className: 'dshRemoteRelaySecretField' },
            React.createElement('input', {
              type: relaySecretVisible ? 'text' : 'password',
              value: relayPasswordDraft,
              autoComplete: 'current-password',
              readOnly: credentialsLocked,
              onChange: (event: Event) => setRelayPasswordDraft((event.target as HTMLInputElement).value),
            }),
            React.createElement('button', {
              type: 'button',
              className: 'dshRemoteRelayEye',
              title: t(relaySecretVisible ? 'tailnetHideSecret' : 'tailnetShowSecret'),
              'aria-label': t(relaySecretVisible ? 'tailnetHideSecret' : 'tailnetShowSecret'),
              onClick: () => setRelaySecretVisible(visible => !visible),
            }, eyeIcon(relaySecretVisible))))),
      React.createElement('div', { className: 'dshRemoteRelayFooterRow' },
        credentialsLocked
          ? React.createElement('span', { className: 'dshRemoteSettingsState' }, t('connectionLocked'))
          : null,
        React.createElement('div', { className: 'dshRemoteRelayActions' },
          savedSection === 'connection' ? React.createElement('span', { className: 'dshRemoteRelaySaved' }, t('tailnetSaved')) : null,
          React.createElement('button', {
            type: 'button',
            disabled: saving || serviceBusy || credentialsLocked || !credentialsChanged,
            onClick: () => void saveSharedCredentials(),
          }, t(saving ? 'saving' : 'tailnetSave')))))

    // 中继专有设置：开关与连接数在标题行，本机名称在同一行右侧。
    // Tailnet 组网总开关：中继与 SSH 都挂在它下面，必须先打开组网。
    const tailnetSection = React.createElement('section', {
      className: 'dshRemoteRelayAccess dshRemoteTailnetSection',
      'aria-label': t('tailnetEnable'),
    },
      React.createElement('div', { className: 'dshRemoteRelayAccessHeading' },
        React.createElement('div', { className: 'dshRemoteSectionTitle' },
          React.createElement('strong', null, t('tailnetEnable')),
          React.createElement('span', { className: 'dshRemoteRelayHeadingControls' },
            React.createElement('input', {
              type: 'checkbox',
              role: 'switch',
              className: 'dshRemoteRelaySwitch',
              'aria-label': t('tailnetEnable'),
              checked: tailnetEnabled,
              disabled: tailnetBusy || serviceEnabled === true || sshEnabled,
              onChange: (event: Event) => void setTailnet((event.target as HTMLInputElement).checked),
            }))),
        React.createElement('p', null, t('tailnetEnableHint'))))

    const relayAccessPanel = React.createElement('section', {
      className: 'dshRemoteRelayAccess',
      'aria-label': t('tailnetAccessTitle'),
    },
      React.createElement('div', { className: 'dshRemoteRelayAccessHeading dshRemoteRelayHeading' },
        React.createElement('div', { className: 'dshRemoteRelayHeadingMain' },
          React.createElement('div', { className: 'dshRemoteSectionTitle' },
            React.createElement('strong', null, t('tailnetAccessTitle')),
            // 开关与连接数紧贴标题右侧，下面不再单独占一块；开关在左，连接数出现在它右边。
            React.createElement('span', { className: 'dshRemoteRelayHeadingControls' },
              status?.serviceAvailable
                ? React.createElement('input', {
                  type: 'checkbox',
                  role: 'switch',
                  className: 'dshRemoteRelaySwitch',
                  'aria-label': t('remoteService'),
                  checked: status?.host?.enabled === true,
                  disabled: saving || serviceBusy || tailnetBusy || !tailnetEnabled,
                  onChange: (event: Event) => void setRemoteService((event.target as HTMLInputElement).checked),
                })
                : null,
              connectedClientCount === undefined
                ? null
                : React.createElement('span', {
                  className: 'dshRemoteServiceCount',
                  title: connectedClientCount === 0
                    ? t('connectedClientsEmpty')
                    : t('connectedClientCount', { count: connectedClientCount }),
                  'aria-label': connectedClientCount === 0
                    ? t('connectedClientsEmpty')
                    : t('connectedClientCount', { count: connectedClientCount }),
                }, String(connectedClientCount)))),
        React.createElement('p', null, t('relayHint'))),
      React.createElement('div', { className: 'dshRemoteRelayNameField' },
        React.createElement('span', { className: 'dshRemoteRelayFieldLabel' }, t('hostName')),
        React.createElement('input', {
          type: 'text',
          value: deviceNameDraft,
          maxLength: 80,
          autoComplete: 'off',
          disabled: status?.host?.enabled === true,
          title: status?.host?.enabled === true ? t('tailnetAccessHintRunning') : undefined,
          onChange: (event: Event) => setDeviceNameDraft((event.target as HTMLInputElement).value),
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key === 'Enter') void saveDeviceName()
          },
        }),
        React.createElement('button', {
          type: 'button',
          disabled: saving || serviceBusy || !deviceNameValid || !deviceNameChanged,
          onClick: () => void saveDeviceName(),
        }, t(saving ? 'saving' : 'tailnetSave')))),
      // 新装时节点停在授权等待，授权链接在这个弹窗里也要能直接点开。
      tailnet?.phase === 'auth-required' && tailnet.authUrl !== undefined
        ? React.createElement('p', { className: 'dshRemoteTailnetAuth' },
          t('tailnetAuthorizeHint'),
          React.createElement('a', {
            href: tailnet.authUrl, target: '_blank', rel: 'noreferrer',
          }, t('openInBrowser')))
        : null,
      tailnet?.error === undefined ? null : React.createElement('p', { className: 'dshRemoteError', role: 'alert' },
        tailnet.error.message,
        tailnet.error.actionUrl === undefined ? null : React.createElement('a', {
          href: tailnet.error.actionUrl, target: '_blank', rel: 'noreferrer',
        }, t('openInBrowser'))),
      savedSection === 'relay'
        ? React.createElement('div', { className: 'dshRemoteRelayFooterRow' },
          React.createElement('span', { className: 'dshRemoteRelaySaved' }, t('tailnetSaved')))
        : null)

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
              React.createElement('strong', null, t('remoteTitle')),
              React.createElement('p', null, t('remoteDescription'))),
            React.createElement('div', { className: 'dshRemotePageActions' },
              React.createElement('button', {
                type: 'button',
                className: 'dshRemotePageRefresh',
                disabled: refreshing,
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
            connectionPanel,
            modeSection,
            tailnetSection,
            relayAccessPanel,
            sshSection),
          React.createElement('footer', { className: 'dshRemotePageFooter' },
            React.createElement('a', {
              className: 'dshRemoteStarLink',
              href: 'https://github.com/demoliisher/dsh-remote-over-tailnet',
              target: '_blank',
              rel: 'noreferrer',
            }, t('starProject')))))))
  }

  return RemoteWorkspaceAction
}
