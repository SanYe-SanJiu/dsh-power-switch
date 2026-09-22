/**
 * dsh-power-switch — browser half.
 *
 * Hand-written lazy-CJS factory, the same artifact shape the client module
 * system expects from a built bundle:
 *
 *     window.__ModuleLoader__.load({ id, factory(require) { ... } })
 *
 * It registers one card on the Settings -> Plugins page
 * (`plugins.item`, the list the Plugins page dispatches for each official
 * plugin card). The card owns its own chrome, its own copy sheet, and its own
 * confirmation step; the only host call it makes is the plugin's own
 * `POST /api/dsh-power-switch/shutdown` route.
 */

window.__ModuleLoader__.load({
  id: 'dsh-power-switch',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const NS = 'dsh-power-switch'
    const SHUTDOWN_ROUTE = '/api/dsh-power-switch/shutdown'
    const CONFIG_ROUTE = '/api/dsh-power-switch/config'
    const RESTART_ROUTE = '/api/dsh-power-switch/restart'
    const SHORTCUT_ROUTE = '/api/dsh-power-switch/shortcut'
    /** How long the card keeps checking that the process really went down. */
    const REVIVE_WINDOW_MS = 15_000
    /** Pause between liveness probes. */
    const PROBE_INTERVAL_MS = 1000
    /** Ask the host for a shorter hold than its default, so the UI reacts. */
    const REQUESTED_DELAY_MS = 700
    /** How many times an app window re-asks to close before falling back. */
    const AUTO_CLOSE_ATTEMPTS = 3
    /** Pause between those attempts. */
    const AUTO_CLOSE_RETRY_MS = 250
    /**
     * How long the card waits for the host to answer a mode switch.
     *
     * The host answers BEFORE it exits, so a healthy host replies in well under
     * this. The deadline exists for the unhealthy case: without it the button
     * said "saving and restarting" forever and never came back.
     */
    const RESTART_REQUEST_TIMEOUT_MS = 10_000
    /**
     * How long the shutdown request may hang before it is called failed.
     *
     * The host answers BEFORE it disposes, so a request that never answers means
     * the host never took it. Without a deadline the card sat in "working" with
     * the button disabled forever — the exact stuck-pending state the restart
     * path had already been given a deadline to avoid.
     */
    const SHUTDOWN_REQUEST_TIMEOUT_MS = 10_000
    /** How long a settings read may hang before it is retried. */
    const CONFIG_REQUEST_TIMEOUT_MS = 8_000
    /** Attempts for that read: one failure must not disable the switch for good. */
    const CONFIG_READ_ATTEMPTS = 2
    /**
     * How long a CONFIRMED switch may leave the control spent.
     *
     * A confirmed answer means the host is about to exit, so this page is
     * normally destroyed and the timer never runs. It exists for the case the
     * page cannot see: the host exited and came back, the app reconnected in
     * place, and no new window ever arrived. Nothing else would clear the pending
     * state, so the switch button stayed disabled forever -- which is exactly how
     * this control froze the settings page after a switch that did restart DSH.
     */
    const SWITCH_SPENT_MS = 12_000

    /**
     * Copy sheet. Registered under the plugin's own namespace and also kept
     * locally: the card is rendered through a slot the page dispatches with
     * owner props only, so it never assumes the standard `t` seat arrived.
     */
    const dict = {
      zh: {
        title: 'DSH 电源按钮',
        summary: 'dsh-power-switch — 侧边栏一键关闭 DSH 进程，或在「应用窗口 / 普通标签页」之间切换下次启动方式。',
        dangerTitle: '关闭 DSH 进程',
        dangerHint: '关闭后本页会失效，需要重新启动 DSH 才能继续用。进行中的回合、后台任务与终端会话都会被中止。',
        action: '关闭 DSH 进程',
        working: '正在关闭…',
        done: '已发出关闭请求，进程正在退出。',
        waiting: '正在确认进程是否已退出…',
        gone: 'DSH 已停止，本页可以关掉了。',
        stillRunning: '进程仍在运行——关闭请求可能没生效，可以重试。',
        closePage: '关闭此页面',
        closeHint: '本页请按 Ctrl+W（macOS 为 ⌘W）关闭：浏览器不允许页面关闭「你自己打开」的标签页。',
        reopenHint: '需要再用时，双击桌面图标即可（终端里运行 dsh web 也行）。',
        launchNow: '当前窗口',
        launchNext: '下次启动',
        launchModeTab: '普通标签页',
        launchModeApp: '应用窗口',
        launchClosesItself: '关闭进程后本页会自己消失',
        launchNeedsKey: '关闭进程后需按 Ctrl+W',
        launchPending: '已设为',
        launchSwitchToApp: '切换到「应用窗口」',
        launchSwitchToTab: '切换到「普通标签页」',
        launchSwitchHint: '一键完成：保存设置 → 改好桌面快捷方式 → 重启 DSH。',
        launchSwitching: '正在切换…',
        launchRestarting: '正在重启，新窗口马上打开…',
        launchNoAnswer: '宿主 10 秒内没有回应：设置可能已保存，但重启不确定，可以再点一次。',
        launchStillHere: '本页仍在：新窗口可能开在别处了，可以按 Ctrl+W 关掉本页。',
        launchUnavailable: '读取宿主设置失败：',
        launchFailed: '切换失败：',
        launchRefusedHost: '这个 DSH 不是以「dsh web 命令行」方式启动的（桌面版就是这样），插件无法自动重启它。关闭进程仍然可以用。',
        launchRefusedHelper: '重启助手没能启动，所以这次不会重启——服务保持可用。',
        launchRefusedUnconfirmed: '重启助手启动了但没有确认就位，所以这次不会重启——服务保持可用。',
        launchReadRetry: '读取宿主设置失败，正在重试…',
        launchUnknown: '未知',
        shortcutAdopted: '已接管桌面快捷方式：',
        shortcutCreated: '已新建桌面快捷方式：',
        shortcutRestored: '已还原桌面快捷方式：',
        shortcutRemoved: '已删除新建的快捷方式：',
        shortcutAlready: '桌面快捷方式已是启动器：',
        shortcutNothing: '桌面快捷方式保持你原来的方式，无需改动。',
        shortcutFailed: '桌面快捷方式未能自动处理：',
        failed: '关闭请求失败',
        cornerAction: '关闭 DSH',
        cornerClosing: '正在关闭 DSH…',
        cornerStillHere: '已请求关闭；本页可以按 Ctrl+W 关掉。',
        cancel: '取消',
        confirm: '确认关闭',
        dialogTitle: '确认关闭 DSH 进程？',
        dialogBody: '这会结束正在运行的 dsh web 进程：进行中的回合、后台任务与终端会话都会被中止。',
        style: '样式',
        pid: '进程 PID',
      },
      en: {
        title: 'DSH power button',
        summary: 'dsh-power-switch \u2014 shut this DSH down from the sidebar, or switch how the next launch opens (app window / normal tab).',
        dangerTitle: 'Shut down DSH',
        dangerHint: 'After this the page stops working until DSH starts again. Turns in flight, background jobs and terminal sessions are aborted.',
        action: 'Shut down DSH',
        working: 'Shutting down\u2026',
        done: 'The request landed; the process is leaving.',
        waiting: 'Confirming the process actually exited\u2026',
        gone: 'DSH has stopped \u2014 this page can be closed.',
        stillRunning: 'The process is still running \u2014 the request may not have taken effect. You can retry.',
        closePage: 'Close this page',
        closeHint: 'Press Ctrl+W (\u2318W on macOS) to close it: a browser refuses to let a page close a tab that YOU opened.',
        reopenHint: 'To use it again, double-click the desktop icon (or run dsh web in a terminal).',
        launchNow: 'This window',
        launchNext: 'Next launch',
        launchModeTab: 'Normal tab',
        launchModeApp: 'App window',
        launchClosesItself: 'this page closes itself after the shutdown',
        launchNeedsKey: 'press Ctrl+W after the shutdown',
        launchPending: 'set to',
        launchSwitchToApp: 'Switch to app window',
        launchSwitchToTab: 'Switch to normal tab',
        launchSwitchHint: 'One click does it: save the setting, fix the desktop shortcut, restart DSH.',
        launchSwitching: 'Switching\u2026',
        launchRestarting: 'restarting; the new window opens shortly\u2026',
        launchNoAnswer: 'the host did not answer within 10 seconds: the setting may be saved but the restart is unconfirmed. Try again.',
        launchStillHere: 'this page is still here \u2014 the new window probably opened elsewhere. Press Ctrl+W to close it.',
        launchUnavailable: 'Could not read the host settings: ',
        launchFailed: 'The switch failed: ',
        launchRefusedHost: 'this DSH was not started as a "dsh web" command line (the desktop app, for example), so the plugin cannot restart it automatically. Shutting it down still works.',
        launchRefusedHelper: 'the relaunch helper could not be started, so nothing was restarted \u2014 the service stays available.',
        launchRefusedUnconfirmed: 'the relaunch helper started but never confirmed it was up, so nothing was restarted \u2014 the service stays available.',
        launchReadRetry: 'Could not read the host settings; retrying\u2026',
        launchUnknown: 'unknown',
        shortcutAdopted: 'Desktop shortcut adopted: ',
        shortcutCreated: 'Desktop shortcut created: ',
        shortcutRestored: 'Desktop shortcut put back: ',
        shortcutRemoved: 'Created shortcut removed: ',
        shortcutAlready: 'Desktop shortcut is already the launcher: ',
        shortcutNothing: 'the desktop shortcut is still your original one \u2014 nothing to change.',
        shortcutFailed: 'the desktop shortcut could not be handled: ',
        failed: 'Shutdown request failed',
        cornerAction: 'Shut down DSH',
        cornerClosing: 'shutting DSH down\u2026',
        cornerStillHere: 'shutdown requested; press Ctrl+W to close this page.',
        cancel: 'Cancel',
        confirm: 'Shut down',
        dialogTitle: 'Shut down the DSH process?',
        dialogBody: 'This ends the running dsh web process: turns in flight, background jobs and terminal sessions are aborted.',
        style: 'Style',
        pid: 'Process PID',
      },
    }

    /**
     * Pick the sheet matching the active locale, without depending on the
     * locale service being readable at this point.
     * @returns the copy record for the page's language.
     */
    function localStrings() {
      let language = 'zh'
      try {
        const raw = typeof document !== 'undefined' && document.documentElement
          ? document.documentElement.lang
          : ''
        if (typeof raw === 'string' && raw.toLowerCase().startsWith('en')) language = 'en'
      } catch {
        // An unreadable document language is not a reason to lose the copy.
      }
      return dict[language]
    }

    /**
     * Resolve against the host's translator when one was injected, falling back
     * to the local sheet on a missing key or a missing translator.
     * @param t - the injected translator, when present.
     * @param local - the local sheet.
     * @param key - dictionary key.
     * @param params - interpolation values.
     * @returns the display text.
     */
    function translate(t, local, key, params) {
      if (typeof t === 'function') {
        try {
          const value = t(key, params)
          if (typeof value === 'string' && value.length > 0 && value !== key) return value
        } catch {
          // A translator that does not serve this namespace falls through.
        }
      }
      return local[key] ?? key
    }

    /**
     * Resolve a root-absolute route against the directory the page is served
     * from, so a reverse proxy that mounts DSH under a prefix still reaches it.
     * @param route - the route path, with or without its leading slash.
     * @returns the pathname to fetch.
     */
    function absoluteUrl(route) {
      const relative = String(route).replace(/^\/+/u, '')
      if (typeof document === 'undefined' || !document.baseURI) return `/${relative}`
      return new URL(relative, document.baseURI).pathname
    }

    /** Design tokens, injected once as a plugin-owned stylesheet. */
    const CSS = `
.dpb-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0 8px;
}
.dpb-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dpb-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.dpb-danger {
  background: var(--dsw-alias-bg-danger, var(--dsw-alias-bg-layer-3, #fee2e2)) !important;
  color: var(--dsw-alias-label-danger, var(--dsw-alias-label-primary, #b91c1c)) !important;
  border-color: var(--dsw-alias-border-danger, currentColor) !important;
}
.dpb-danger:hover:not(:disabled) { filter: brightness(0.97); }
.dpb-status {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dpb-status[data-phase="done"] { color: var(--dsw-alias-label-primary, #111827); }
.dpb-status[data-phase="failed"] { color: var(--dsw-alias-label-danger, #b91c1c); }
.dpb-pid { font-variant-numeric: tabular-nums; }
.dpb-launch {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  padding-top: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
}
.dpb-launch-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}
.dpb-launch-label {
  min-width: 4.5em;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.dpb-launch-value { color: var(--dsw-alias-label-primary, #111827); }
.dpb-launch-note { color: var(--dsw-alias-label-secondary, #6b7280); }
/* The shutdown control in the sidebar's foot. It shares that seat -- and therefore
   that flex ROW -- with the cost plugin's budget box, so it claims no width of its
   own: flex-none, a fixed 36px square, and a label that lives in the tooltip. An
   earlier version asked for width:100% and squeezed the neighbour's peak/off-peak
   bar down to nothing; 36px is the largest size that still leaves that budget box
   (min-width 148px) its room in an expanded sidebar. (No backticks in this block:
   it is a template literal.) */
.dpb-side {
  /* Anchors the status popover, which takes no layout space of its own. */
  position: relative;
  display: flex;
  align-items: center;
  flex: none;
  width: auto;
  min-width: 0;
}
.dpb-side-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0.5px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-family: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}
.dpb-side-button:hover:not(:disabled) {
  color: var(--dsw-alias-label-danger, #b91c1c);
  border-color: var(--dsw-alias-border-danger, currentColor);
}
.dpb-side-button:disabled { cursor: default; opacity: 0.55; }
.dpb-side-button[data-state="failed"] { color: var(--dsw-alias-label-danger, #b91c1c); }
/* Shown only after an action, and absolutely positioned so it can never widen the
   row that the cost plugin's budget box shares. */
.dpb-side-status {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 1;
  width: max-content;
  max-width: 220px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-l1, rgba(255, 255, 255, 0.96));
  box-shadow: 0 2px 10px #0001;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dpb-side-status[data-phase="failed"] { color: var(--dsw-alias-label-danger, #b91c1c); }
`

    /**
     * Install the stylesheet once, tagged so a reload can recognise it.
     *
     * Guarded on `document` because the factory is also evaluated by tooling
     * outside a page, and a stylesheet is never a reason to fail the boot pass.
     */
    function installStyles() {
      if (typeof document === 'undefined') return
      const existing = document.querySelector(`style[data-plugin="${NS}"]`)
      if (existing !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Whether the confirmation modal can be rendered. Read at call time rather
     * than cached, so a host whose primitives arrive later still gets the
     * dialog once it can.
     * @returns true when the primitives module offers a modal and a button.
     */
    const hasModal = () => typeof primitives?.Modal === 'function' && typeof primitives?.Button === 'function'

    /**
     * The fallback confirmation step, used only when the primitives module
     * offers no `Modal` — a host that old must still be able to ask.
     * @param local - the local copy sheet.
     * @returns true when the person confirmed.
     */
    const askConfirm = (local) => window.confirm(`${local.dialogTitle}\n\n${local.dialogBody}`)

    /**
     * Whether this window can close itself, and whether it should do so by itself.
     *
     * `dsh web` hands the URL to the OS (`spawnBrowserLauncher`), so an ordinary
     * launch is a tab the PERSON opened, and browsers refuse `window.close()` on
     * those. An app window is different, and this was MEASURED on Edge 151 by
     * serving a probe page both ways:
     *
     *   normal tab  : display-mode standalone false, outer-inner height 84,
     *                 window.close() refused (the page was still alive 3 s later)
     *   --app= URL  : display-mode standalone TRUE,  outer-inner height 38,
     *                 window.close() HONOURED (the window was gone)
     *
     * `menubar`/`toolbar`/`locationbar` are useless here: they still report
     * `visible: true` in an app window. So `standalone` is the detector, with
     * `window.opener` kept for a popup (a script-opened window closes too), and
     * `window.name` kept because Chrome sets it in app mode.
     *
     * Factory scope, not card scope: the corner button in the shell overlay needs
     * the same rule, and two copies of it would eventually disagree.
     * @returns 'auto' when the window closes itself, 'button' when the person can
     *   close it with one click, 'key' when only the keyboard can.
     */
    function closeStrategy() {
      try {
        const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true
        if (standalone || window.name === 'app') return 'auto'
        if (window.opener !== null && window.opener !== undefined) return 'button'
      } catch {
        // An unreadable window means the keyboard route, never a dead button.
      }
      return 'key'
    }

    /**
     * The power card.
     * @param props - the page's view request plus the injected face.
     * @returns the summary line, or the control.
     */
    function PowerCard(props) {
      const view = props?.view
      const local = props?.strings ?? localStrings()
      const t = (key, params) => translate(props?.t, local, key, params)

      const [confirming, setConfirming] = React.useState(false)
      const [phase, setPhase] = React.useState('idle')
      const [message, setMessage] = React.useState(null)
      const [pid, setPid] = React.useState(null)
      /** Which close strategy already drove an attempt, so it runs once. */
      const [autoCloseRan, setAutoCloseRan] = React.useState(false)
      /** The launch mode the NEXT launch should use, as the host reports it. */
      const [storedMode, setStoredMode] = React.useState(null)
      /** Whether reading that mode failed, so the card can say so. */
      const [modeError, setModeError] = React.useState(false)
      /** Whether a mode switch is in flight (it restarts DSH). */
      const [switching, setSwitching] = React.useState(false)
      /** What the switch did to the desktop entry, shown under it. */
      const [shortcutLines, setShortcutLines] = React.useState(null)
      /** The pending-switch recovery timer, so unmounting can cancel it. */
      const switchTimer = React.useRef(null)
      React.useEffect(() => () => {
        if (switchTimer.current !== null) window.clearTimeout(switchTimer.current)
      }, [])

      if (view === 'summary') return t('summary')

      /**
       * Ask the host to leave. The host answers BEFORE it starts disposing, so
       * a completed request means the process really is on its way out.
       */
      const submit = async () => {
        setConfirming(false)
        setPhase('working')
        setMessage(null)
        const controller = new AbortController()
        const deadline = window.setTimeout(() => { controller.abort() }, SHUTDOWN_REQUEST_TIMEOUT_MS)
        try {
          const relative = SHUTDOWN_ROUTE.replace(/^\/+/u, '')
          const endpoint = typeof document === 'undefined' ? `/${relative}` : new URL(relative, document.baseURI).pathname
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ delayMs: REQUESTED_DELAY_MS }),
            signal: controller.signal,
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            setPhase('failed')
            setMessage(`${t('failed')} (HTTP ${String(response.status)})`)
            return
          }
          setPid(typeof payload.pid === 'number' ? payload.pid : null)
          setPhase('done')
          setMessage(t('done'))
          watchForRevival()
        } catch (error) {
          if (error?.name === 'AbortError') {
            // The deadline passed with no answer. Do NOT treat this as sent: the
            // host answers before it disposes, so silence means it never took the
            // request. `failed` keeps the button usable for a second attempt.
            setPhase('failed')
            setMessage(`${t('failed')} — ${t('launchNoAnswer')}`)
            return
          }
          // Any OTHER transport failure is the EXPECTED last leg of a successful
          // shutdown: the socket dies with the server. Treat it as sent, and
          // let the probe below decide whether the service really went away.
          // A refusal the host actually sent is handled above, before this.
          setPhase('done')
          setMessage(t('done'))
          watchForRevival()
        } finally {
          window.clearTimeout(deadline)
        }
      }

      /**
       * Confirm the process actually went down, then stop.
       *
       * This is a SHORT watch on purpose. A plain shutdown never comes back, so
       * waiting for it is waiting forever -- the original version polled for 90
       * seconds and left the button reading "waiting for the process to exit".
       * The question worth answering is only "did it go down", which one refused
       * or dropped connection settles immediately; the watch window exists just
       * to cover the configured hold before disposal starts.
       */
      const watchForRevival = () => {
        setPhase('waiting')
        setMessage(t('waiting'))
        // A test harness that owns the event loop can opt out of the polling.
        if (window.__DSH_POWER_SWITCH_NO_REVIVAL__ === true) return
        const deadline = Date.now() + REVIVE_WINDOW_MS
        const probe = async () => {
          let reachable = false
          try {
            const response = await fetch(window.location.href, { method: 'GET', cache: 'no-store' })
            // A refused request still proves something is listening. If it is
            // still US, disposal has not started; if it answers, a supervisor
            // brought the service back and this page's launch token is stale.
            reachable = response.status !== 0
          } catch {
            reachable = false
          }
          if (!reachable) {
            setPhase('gone')
            setMessage(t('gone'))
            return
          }
          if (Date.now() > deadline) {
            // Still answering after the whole window: it did not stop, and
            // saying otherwise would be a lie the user cannot check.
            setPhase('failed')
            setMessage(t('stillRunning'))
            return
          }
          window.setTimeout(() => { void probe() }, PROBE_INTERVAL_MS)
        }
        window.setTimeout(() => { void probe() }, PROBE_INTERVAL_MS)
      }

      /**
       * Ask this window to close, then check whether the ask was honoured.
       *
       * A browser refuses `window.close()` SILENTLY, so the only honest way to
       * know is to look again afterwards: a real close takes this page with it
       * and nothing below ever runs. A refusal, or an exhausted attempt budget,
       * falls back to telling the person which key to press.
       * @param attemptsLeft - how many more times to ask before falling back.
       */
      const autoClose = (attemptsLeft) => {
        try {
          window.close()
        } catch {
          // Fall through to the next attempt.
        }
        if (attemptsLeft <= 1) {
          // Still here: this window is not one a script may close. Stop asking
          // and say what to press.
          setMessage(t('closeHint'))
          setPhase('gone')
          return
        }
        window.setTimeout(() => { autoClose(attemptsLeft - 1) }, AUTO_CLOSE_RETRY_MS)
      }

      const strategy = closeStrategy()
      // Runs once, from the render that first sees the process gone. In an app
      // window the page is gone before the person reads anything; in a tab the
      // refusal lands on the key instruction instead of a button that would do
      // nothing. The test harness opts out so it can assert the attempt itself.
      if (phase === 'gone' && strategy === 'auto' && !autoCloseRan) {
        setAutoCloseRan(true)
        if (window.__DSH_POWER_SWITCH_NO_REVIVAL__ !== true) autoClose(AUTO_CLOSE_ATTEMPTS)
      }

      /** Best effort at the person's request: a refusal falls back to the key. */
      const closePage = () => {
        try {
          window.close()
        } catch {
          // The message already tells the person to close the tab.
        }
      }

      /**
       * The display name of one launch mode.
       *
       * Declared before its callers on purpose: these are `const` arrow
       * functions, so a later declaration would be in the temporal dead zone for
       * any handler invoked after mount.
       */
      const modeLabel = (mode) => (mode === 'app' ? t('launchModeApp') : t('launchModeTab'))

      /**
       * Localized copy for a refusal the host NAMED.
       *
       * The host refuses instead of risking an outage, and it reports a stable
       * `reason` code with its diagnostic. Without this the card pasted the
       * host's English error at somebody reading a Chinese page — the failure was
       * explainable, and the explanation was in the wrong language.
       * @param reason - `payload.reason` from a refused restart, if any.
       * @returns the copy to show, or null to fall back to the raw message.
       */
      const refusalCopy = (reason) => {
        if (reason === 'unsupported-host') return t('launchRefusedHost')
        if (reason === 'helper-unavailable') return t('launchRefusedHelper')
        if (reason === 'helper-not-confirmed') return t('launchRefusedUnconfirmed')
        return null
      }

      /**
       * Read the launch mode the host will use for the NEXT launch.
       *
       * The card cannot read that itself: the settings document is the host's.
       * A failure is shown rather than hidden, because "cannot tell" and "tab"
       * look identical on screen otherwise.
       */
      const readStoredMode = async (attempt = 1) => {
        const controller = new AbortController()
        const deadline = window.setTimeout(() => { controller.abort() }, CONFIG_REQUEST_TIMEOUT_MS)
        try {
          const response = await fetch(absoluteUrl(CONFIG_ROUTE), { cache: 'no-store', signal: controller.signal })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(`HTTP ${String(response.status)}`)
          setStoredMode(payload.launchMode === 'app' ? 'app' : 'tab')
          setModeError(false)
        } catch (error) {
          // ONE retry, then a recoverable failure. A single failed read used to
          // leave `storedMode` null forever, which disabled the switch with no way
          // back — and the deadline matters too, because a host that accepts the
          // connection and never answers looked exactly like a slow one.
          if (attempt < CONFIG_READ_ATTEMPTS) {
            setModeError(true)
            setMessage(`${t('launchReadRetry')}${String(error?.message ?? error)}`)
            await new Promise((resolve) => { window.setTimeout(resolve, 1500) })
            await readStoredMode(attempt + 1)
            return
          }
          setModeError(true)
          setMessage(`${t('launchUnavailable')}${String(error?.message ?? error)}`)
        } finally {
          window.clearTimeout(deadline)
        }
      }


      /**
       * One click: save the mode, make the desktop entry match it, restart DSH.
       *
       * The two halves are useless apart. The stored mode only governs a cold start
       * when the thing that gets double-clicked starts the packaged launcher, and the
       * launcher only ever chooses a window shape from the stored mode -- so asking
       * the person to press a second button for the shortcut was asking them to
       * complete a step the plugin already knew how to do. App mode adopts (or
       * creates) that shortcut; tab mode puts the original back, because the launcher
       * adds nothing to a tab.
       *
       * The shortcut step runs FIRST, and that order is load-bearing: the restart
       * below takes this process down, so anything that has to happen before the
       * process goes has to happen before the request that ends it.
       *
       * A shortcut failure does NOT cancel the switch. The mode still works -- DSH
       * opens its own tab and the plugin opens the app window at boot -- so refusing
       * to switch would cost the person more than the stray tab it saves. The failure
       * is reported on its own line instead.
       *
       * The request carries a DEADLINE. Without one, a host that never answers left
       * the button reading "switching" forever, which is worse than an error: the
       * person cannot tell whether anything happened and the control never comes back.
       * @param mode - `'app'` or `'tab'`.
       */
      const switchLaunchMode = async (mode) => {
        setSwitching(true)
        setMessage(null)
        setShortcutLines(null)
        const controller = new AbortController()
        const deadline = window.setTimeout(() => { controller.abort() }, RESTART_REQUEST_TIMEOUT_MS)
        try {
          try {
            const applied = await shortcutStep(mode === 'app' ? 'install' : 'restore', controller.signal)
            setShortcutLines(shortcutReport(applied))
          } catch (error) {
            const aborted = error?.name === 'AbortError'
            setShortcutLines([`${t('shortcutFailed')}${aborted ? t('launchNoAnswer') : String(error?.message ?? error)}`])
          }
          const response = await fetch(absoluteUrl(RESTART_ROUTE), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ launchMode: mode }),
            signal: controller.signal,
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            // The refusal's stable CODE travels with the error: the host refuses
            // rather than risk an outage, and the card answers in the reader's
            // own language instead of pasting an English diagnostic at them.
            const refusal = new Error(payload?.error ?? `HTTP ${String(response.status)}`)
            if (typeof payload?.reason === 'string') refusal.reason = payload.reason
            throw refusal
          }
          setStoredMode(mode)
          setMessage(`${t('launchPending')}${modeLabel(mode)} — ${t('launchRestarting')}`)
          // Arm the recovery. It normally never fires, because this page is the
          // thing being replaced; when it does fire, the new window never came
          // and the control has to come back or the card is stuck for good.
          if (switchTimer.current !== null) window.clearTimeout(switchTimer.current)
          switchTimer.current = window.setTimeout(() => {
            switchTimer.current = null
            setSwitching(false)
            setMessage(`${t('launchPending')}${modeLabel(mode)} — ${t('launchStillHere')}`)
          }, SWITCH_SPENT_MS)
        } catch (error) {
          // Comes back either way: a refusal, a deadline, or a dead socket.
          setSwitching(false)
          const aborted = error?.name === 'AbortError'
          if (!aborted) setModeError(true)
          const refused = refusalCopy(error?.reason)
          setMessage(aborted
            ? `${t('launchPending')}${modeLabel(mode)} — ${t('launchNoAnswer')}`
            : (refused ?? `${t('launchFailed')}${String(error?.message ?? error)}`))
        } finally {
          window.clearTimeout(deadline)
        }
      }

      /**
       * One desktop-shortcut operation, as part of the switch.
       *
       * The card sends ONE thing -- which operation -- because the host decides every
       * path, name and target from its own install location. That is what keeps this
       * request from being able to write a shortcut anywhere, and it is why the action
       * travels as a fixed word rather than as a path.
       * @param action - `'install'` (app mode) or `'restore'` (tab mode).
       * @param signal - the switch's own deadline signal.
       * @returns the host's answer.
       */
      const shortcutStep = async (action, signal) => {
        const response = await fetch(absoluteUrl(SHORTCUT_ROUTE), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
          signal,
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok !== true) {
          throw new Error(String(payload?.error ?? `HTTP ${String(response.status)}`))
        }
        return payload
      }

      /** Turn the host's shortcut answer into the one line the card shows. */
      const shortcutReport = (payload) => {
        const where = typeof payload.path === 'string' && payload.path !== '' ? payload.path : t('launchUnknown')
        // "Nothing to change" is a normal state, not a failure: the desktop is
        // already the way the person had it.
        if (payload.action === 'nothing') return [t('shortcutNothing')]
        if (payload.action === 'adopted') return [`${t('shortcutAdopted')}${where}`]
        if (payload.action === 'created') return [`${t('shortcutCreated')}${where}`]
        if (payload.action === 'restored') return [`${t('shortcutRestored')}${where}`]
        if (payload.action === 'removed') return [`${t('shortcutRemoved')}${where}`]
        return [`${t('shortcutAlready')}${where}`]
      }

      // Read the stored mode once, on mount.
      if (storedMode === null && !modeError && window.__DSH_POWER_SWITCH_NO_REVIVAL__ !== true) {
        void readStoredMode()
      }

      const busy = phase === 'working' || phase === 'waiting'
      /**
       * Whether the process is gone.
       *
       * Only the CONFIRMED stop earns the close affordance: a failed request
       * means the process is still up and the page still works, so offering to
       * close it there would be advice against the person's own interest.
       */
      const stopped = phase === 'gone'
      const otherMode = strategy === 'auto' ? 'tab' : 'app'

      /* eslint-disable react/no-unknown-property -- data-* attributes are the page's hooks */
      return h('div', { className: 'dpb-root', 'data-dsh-power-switch': '' },
        h('p', { className: 'dpb-hint' }, t('dangerHint')),
        h('div', { className: 'dpb-row' },
          h(primitives.Button, {
            variant: 'outline',
            className: 'dpb-danger',
            // Once the request has landed the button is spent: `waiting` while
            // the exit is confirmed, and `gone` after it. `failed` stays usable
            // so a request that never took effect can be sent again.
            disabled: busy || phase === 'done' || stopped,
            'data-dsh-power-action': 'shutdown',
            onClick: () => {
              if (hasModal()) setConfirming(true)
              else if (askConfirm(local)) void submit()
            },
          }, phase === 'working' ? t('working') : t('action')),
          h('span', { className: 'dpb-status', 'data-phase': phase },
            message ?? (phase === 'idle' ? t('dangerTitle') : '')),
        ),
        // Only a POPUP earns the close button. An app window is already closing
        // itself, and a plain tab would swallow the click silently.
        stopped && strategy === 'button' ? h('div', { className: 'dpb-row' },
          h(primitives.Button, {
            variant: 'outline',
            'data-dsh-power-close': 'true',
            onClick: closePage,
          }, t('closePage')),
        ) : null,
        stopped && strategy === 'key' ? h('p', { className: 'dpb-hint', 'data-dsh-power-closehint': 'true' },
          t('closeHint')) : null,
        h('div', { className: 'dpb-launch', 'data-dsh-power-launch': 'true' },
          h('div', { className: 'dpb-launch-row' },
            h('span', { className: 'dpb-launch-label' }, t('launchNow')),
            h('span', {
              className: 'dpb-launch-value',
              'data-dsh-power-window-mode': strategy === 'auto' ? 'app' : (strategy === 'button' ? 'popup' : 'tab'),
            }, strategy === 'auto' || strategy === 'button' ? t('launchModeApp') : t('launchModeTab')),
            h('span', { className: 'dpb-launch-note' },
              strategy === 'auto' ? t('launchClosesItself') : t('launchNeedsKey')),
          ),
          h('div', { className: 'dpb-launch-row' },
            h('span', { className: 'dpb-launch-label' }, t('launchNext')),
            h('span', { className: 'dpb-launch-value', 'data-dsh-power-stored-mode': storedMode ?? '?' },
              storedMode === null ? t('launchUnknown') : modeLabel(storedMode)),
          ),
          h('p', { className: 'dpb-hint' }, t('launchSwitchHint')),
          h('div', { className: 'dpb-row' },
            h(primitives.Button, {
              variant: 'outline',
              // Disabled only while a switch is in flight, or before the first
              // read has answered. A FAILED read keeps it usable: the switch does
              // not depend on knowing the stored mode (it moves to the shape this
              // window is not), so a dead settings read must not disable it.
              disabled: switching || (storedMode === null && !modeError),
              'data-dsh-power-switch': otherMode,
              onClick: () => { void switchLaunchMode(otherMode) },
            }, switching
              ? t('launchSwitching')
              : (otherMode === 'app' ? t('launchSwitchToApp') : t('launchSwitchToTab'))),
          ),
          // What the switch did to the desktop entry, on its own line. There is no
          // button for this any more: the mode switch does it, because a stored mode
          // only governs a COLD start when the icon that gets double-clicked starts
          // the packaged launcher -- so asking for a second click was asking the
          // person to finish a step the plugin already knew how to do.
          shortcutLines === null
            ? null
            : h('div', { className: 'dpb-status', 'data-dsh-power-shortcut-status': 'true' },
              ...shortcutLines.map((line, index) => h('div', { key: String(index) }, line))),
        ),
        phase === 'gone' ? h('p', { className: 'dpb-hint' }, t('reopenHint')) : null,
        pid === null ? null : h('p', { className: 'dpb-hint' },
          `${t('pid')}: `, h('span', { className: 'dpb-pid' }, String(pid))),
        hasModal() ? h(primitives.Modal, {
          open: confirming,
          onClose: () => { setConfirming(false) },
          title: t('dialogTitle'),
          closeLabel: t('cancel'),
          description: t('dialogBody'),
          footer: h(React.Fragment, null,
            h(primitives.Button, {
              variant: 'outline',
              onClick: () => { setConfirming(false) },
            }, t('cancel')),
            h(primitives.Button, {
              variant: 'primary',
              className: 'dpb-danger',
              'data-dsh-power-confirm': 'true',
              onClick: () => { void submit() },
            }, t('confirm')),
          ),
        }) : null,
      )
      /* eslint-enable react/no-unknown-property */
    }

    /**
     * Required client SERVICES.
     *
     * These are service names resolved through the renderer's context, NOT
     * package names. `dsh.client.inject` in package.json is the separate
     * package-level list that orders bundle materialization, and naming a
     * service there is unsatisfiable: `@deepseek-ai/dsh-client-ui-slots` is not
     * a bundle in the boot graph (its registry ships inside the renderer), so a
     * package row for it can never be composed.
     */
    const inject = ['slots', 'locale']

    /**
     * The shutdown control in the sidebar's foot.
     *
     * It registers into `sidebar.footer.action`, the seat the sidebar documents as
     * stacking its entries **above the Settings row** in both sidebar widths. That
     * is what makes this the bottom-left control the person asked for without the
     * problem the first attempt had: a fixed bottom-left overlay landed on top of
     * Settings and stole its clicks.
     *
     * It is also a SHARED row: the cost plugin's budget box uses the same seat, so
     * this control is one fixed 32px icon that claims no width at all. An earlier
     * version asked for width:100% and squeezed that plugin's peak/off-peak bar down
     * to nothing -- a reminder that a seat's other occupants are part of its contract.
     *
     * It carries the SHUTDOWN only -- the window-mode switch stays on the card,
     * where its result and its shortcut work can be explained.
     *
     * Every press is CONFIRMED: this sits next to Settings in a corner of the
     * window, which is exactly where a hand lands by accident. That confirmation is
     * also what makes its position safe.
     * @param props - the injected face plus the seat's `wide` flag.
     * @returns the button and its own one-line status.
     */
    function PowerSideAction(props) {
      const local = props?.strings ?? localStrings()
      const t = (key, params) => translate(props?.t, local, key, params)
      // The seat's `wide` flag is deliberately unused: the button is the same fixed
      // 32px square in both sidebar widths, because the row it sits in is shared with
      // another plugin's budget box.
      const [confirming, setConfirming] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [failed, setFailed] = React.useState(false)

      /**
       * Ask this window to close, a few times, then say which key does it.
       *
       * Only a window that may close itself is asked at all -- an app window or a
       * script-opened popup. A normal tab would refuse silently, and naming the key
       * beats a button that appears to do nothing.
       * @param attemptsLeft - how many more times to ask.
       */
      const autoClose = (attemptsLeft) => {
        try {
          window.close()
        } catch {
          // A refusal is silent; the attempt budget is the only signal.
        }
        if (attemptsLeft <= 1) {
          setStatus(t('cornerStillHere'))
          return
        }
        window.setTimeout(() => { autoClose(attemptsLeft - 1) }, AUTO_CLOSE_RETRY_MS)
      }

      const submit = async () => {
        setConfirming(false)
        setBusy(true)
        setStatus(null)
        setFailed(false)
        try {
          const relative = SHUTDOWN_ROUTE.replace(/^\/+/u, '')
          const endpoint = typeof document === 'undefined' ? `/${relative}` : new URL(relative, document.baseURI).pathname
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ delayMs: REQUESTED_DELAY_MS }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
          setStatus(t('cornerClosing'))
          // An app window closes itself once the host has accepted; that is the whole
          // point of the mode, and it applies no matter which control was used.
          if (closeStrategy() !== 'key') autoClose(AUTO_CLOSE_ATTEMPTS)
        } catch (error) {
          setFailed(true)
          setStatus(`${t('failed')}: ${String(error?.message ?? error)}`)
        } finally {
          setBusy(false)
        }
      }

      /* eslint-disable react/no-unknown-property -- data-* attributes are the page's hooks */
      return h('div', {
        className: 'dpb-side',
        'data-dsh-power-side': 'shutdown',
      },
        status === null ? null : h('div', {
          className: 'dpb-side-status',
          'data-dsh-power-side-status': failed ? 'failed' : 'ok',
        }, status),
        h('button', {
          type: 'button',
          className: 'dpb-side-button',
          disabled: busy || status === t('cornerClosing'),
          // The label lives in the tooltip: the button itself stays a fixed 32px so it
          // can never take width from the budget box beside it.
          title: status ?? t('cornerAction'),
          'aria-label': t('cornerAction'),
          'data-state': failed ? 'failed' : 'idle',
          'data-dsh-power-shutdown': 'sidebar',
          onClick: () => {
            if (hasModal()) setConfirming(true)
            else if (askConfirm(local)) void submit()
          },
        }, busy ? '…' : '⏻'),
        hasModal() ? h(primitives.Modal, {
          open: confirming,
          onClose: () => { setConfirming(false) },
          title: t('dialogTitle'),
          closeLabel: t('cancel'),
          description: t('dialogBody'),
          footer: h(React.Fragment, null,
            h(primitives.Button, {
              variant: 'outline',
              onClick: () => { setConfirming(false) },
            }, t('cancel')),
            h(primitives.Button, {
              variant: 'primary',
              className: 'dpb-danger',
              'data-dsh-power-side-confirm': 'true',
              onClick: () => { void submit() },
            }, t('confirm')),
          ),
        }) : null,
      )
      /* eslint-enable react/no-unknown-property */
    }

    /**
     * Mount the copy sheet and the Plugins-page card.
     * @param ctx - the browser plugin context carrying `slots` and `locale`.
     */
    function apply(ctx) {
      installStyles()

      // Keep the translator when the host serves it; the card also carries a
      // local sheet, so a missing namespace never blanks the button.
      let t
      try {
        ctx.locale.register(NS, { zh: dict.zh, en: dict.en })
        t = ctx.locale.bind(NS)
      } catch {
        t = undefined
      }

      // The quick shutdown, in the sidebar's foot: the seat stacks it directly above
      // Settings and hands it the sidebar's own `wide` flag, so the collapsed rail
      // gets the icon form without any positioning of our own. Guarded because a
      // composition without that seat must still get the card and the routes -- a
      // convenience in a corner is never worth a failed boot.
      try {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: `${NS}-shutdown`,
          locale: NS,
          inject: () => ({ t, strings: localStrings() }),
        }, PowerSideAction))
      } catch {
        // No sidebar foot here; the card still offers the same shutdown.
      }

      ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: NS,
        // Last: a power control belongs at the end of the official cards.
        order: 10_000,
        // Through `translate`, never a bare `t(...)`: a host translator that
        // returns nothing for this namespace must fall back to the local sheet,
        // or the card registers an EMPTY label and shows up as a blank row.
        label: () => translate(t, localStrings(), 'title'),
        locale: NS,
        inject: () => ({ t, strings: localStrings() }),
      }, PowerCard))
    }

    return { name: NS, inject, apply }
  },
})
