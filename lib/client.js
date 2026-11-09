window.__ModuleLoader__.load({ id: 'dsh-bidread', factory: (require) => {
  // 招标文件解读工作台 · DSH 面板（业务整页 + 按需对话）
  // 平时整页显示工作台网页（/api/bidread/app）；用户在网页里点“问答”时，才在右侧展开 DSH 原生对话，
  // 为当前项目创建或恢复一个本工作台会话（工作区就是项目资料所在文件夹），再点或关闭即收起。
  const module = { exports: {} }
  const React = require('react')
  const h = React.createElement
  const VERSION = '0.2.1'
  const SESSIONS_KEY = 'dsh.bidread.project-sessions.v1'
  let bridge = null

  const css = `
  .br-panel{position:relative;display:flex;width:100%;height:100%;min-height:0;min-width:0;background:var(--dsw-alias-bg-base,#fff)}
  .br-frame{flex:1;min-width:0;height:100%;border:0;background:var(--dsw-alias-bg-base,#fff)}
  .br-chat{flex:none;width:min(440px,42%);min-width:320px;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--dsw-alias-border-l1,#dfe1e4);background:var(--dsw-alias-bg-base,#fff)}
  .br-chat-head{flex:none;height:44px;display:flex;align-items:center;gap:8px;padding:0 10px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#dfe1e4);color:var(--dsw-alias-label-primary,#17191c)}
  .br-chat-head b{font-size:13px;font-weight:600} .br-chat-head small{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,#6f7578);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .br-chat-head button{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6f7578);font-size:16px;cursor:pointer}
  .br-chat-head button:hover{background:var(--dsw-alias-interactive-bg-hover-accent,#eef1f0)}
  .br-chat-body{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
  .br-chat-wait{flex:1;display:grid;place-items:center;padding:20px;text-align:center;font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary,#6f7578)}
  @media (max-width:900px){.br-chat{position:absolute;inset:0 0 0 auto;width:min(440px,100%);z-index:5;box-shadow:-8px 0 24px rgba(0,0,0,.18)}}
  .br-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:9;max-width:80%;padding:8px 14px;border-radius:8px;
    background:#1d2022;color:#fff;font-size:12px;line-height:1.6;box-shadow:0 6px 20px rgba(0,0,0,.25)}`

  const readSessions = () => { try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}') || {} } catch { return {} } }
  const rememberSession = (pid, sessionId) => { const m = readSessions(); m[pid] = sessionId; try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(m)) } catch {} }
  const ownedCurrent = () => { const s = bridge?.desktopWorkbenches; const id = s?.currentSession?.(); return id && s.ownsSession?.(id) ? id : null }

  // 工作区是项目资料文件夹，DSH 默认拿文件夹名（项目 ID，如 p20261109-…）当工作区名，侧栏上看着像乱码。
  // 会话打开后把工作区改名为项目名；和别的工作区重名时加上 ID 末四位。改名失败不影响使用。
  async function nameWorkspace(sessionId, p) {
    const ws = bridge?.workspaces
    if (!p?.name || typeof ws?.rename !== 'function') return
    try {
      const items = ws.list?.getSnapshot?.().items || []
      const item = items.find(w => (w.sessionIds || []).includes(sessionId)) || items.find(w => String(w.path || '').replace(/\\/g, '/').endsWith('/' + p.pid))
      if (!item || item.title === p.name || item.title === `${p.name}（${p.pid.slice(-4)}）`) return
      try { await ws.rename(item.workspaceId, p.name) } catch { await ws.rename(item.workspaceId, `${p.name}（${p.pid.slice(-4)}）`) }
    } catch {}
  }

  function Panel({ conversation, active }) {
    const frame = React.useRef(null)
    const [chat, setChat] = React.useState(false)
    const [waiting, setWaiting] = React.useState('')
    const [msg, setMsg] = React.useState('')
    const project = React.useRef(null)   // 网页当前打开的项目 {pid, folder, name}
    React.useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(''), 4000); return () => clearTimeout(t) }, [msg])

    // 为当前项目创建或恢复本工作台会话：已有的接着用，没有就以项目资料文件夹为工作区新建
    const openSession = React.useCallback(async () => {
      const p = project.current
      if (!p?.pid) { setWaiting('先在左边打开或新建一个招标项目，AI 才知道要读哪个项目的资料。'); return }
      const service = bridge?.desktopWorkbenches
      if (typeof service?.ensureSession !== 'function') { setWaiting('当前 DSH 版本不支持自动创建工作台会话，请升级到 0.13 以上。'); return }
      setWaiting('正在打开这个项目的 AI 对话…')
      try {
        const id = await service.ensureSession({ folder: p.folder, sessionId: readSessions()[p.pid] })
        if (id) { rememberSession(p.pid, id); nameWorkspace(id, p) }
        setWaiting('')
      } catch (e) { setWaiting(''); setMsg('没有打开对话：' + (e?.message || e)) }
    }, [])

    React.useEffect(() => {
      const onMessage = event => {
        if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return
        const d = event.data || {}
        if (d.type === 'bidread:project') {
          const changed = project.current?.pid !== d.pid
          project.current = d.pid ? { pid: d.pid, folder: d.folder, name: d.name } : null
          if (chat && changed && d.pid) openSession()   // 对话开着时切换项目：跟着切到那个项目的会话
        }
        if (d.type === 'bidread:chat') setChat(v => { const next = d.open ?? !v; if (next) setTimeout(openSession, 0); return next })
      }
      window.addEventListener('message', onMessage)
      return () => window.removeEventListener('message', onMessage)
    }, [chat, openSession])
    // 对话区开关同步给网页（按钮显示“收起问答”）
    React.useEffect(() => { frame.current?.contentWindow?.postMessage({ type: 'bidread:chat-state', open: chat }, window.location.origin) }, [chat])

    const hasSession = !!ownedCurrent()
    return h('div', { className: 'br-panel' },
      h('iframe', { ref: frame, className: 'br-frame', title: '招标文件解读', src: '/api/bidread/app' }),
      chat && h('aside', { className: 'br-chat', 'aria-label': 'AI 问答' },
        h('div', { className: 'br-chat-head' },
          h('b', null, 'AI 问答'), h('small', null, project.current?.name ? `可读取「${project.current.name}」的资料和解读结果` : '可读取当前项目的资料和解读结果'),
          h('button', { type: 'button', title: '收起', 'aria-label': '收起问答', onClick: () => setChat(false) }, '×')),
        h('div', { className: 'br-chat-body' },
          waiting || !hasSession ? h('div', { className: 'br-chat-wait' }, waiting || '正在准备对话…') : null,
          active ? conversation : null)),
      msg && h('div', { className: 'br-toast', role: 'status' }, msg))
  }

  // workspaces 是 desktopWorkbenches 自身依赖的宿主服务，有工作台就一定有它
  const inject = ['desktopWorkbenches', 'workspaces']
  function apply(ctx) {
    bridge = ctx
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.dshPlugin = 'dsh-bidread'
      style.textContent = css
      document.head.appendChild(style)
      return () => style.remove()
    })
    ctx.effect(() => ctx.desktopWorkbenches.register({
      title: '招标文件解读', icon: '◧', panelTitle: '招标项目',
      description: '上传一个招标项目的全套资料，解读项目速览、补遗变更、废标风险、评分办法和材料清单，每条结论都能点回原文；需要时在右侧和 AI 讨论这个项目。',
      audience: '投标专员、商务和技术负责人', requirements: '使用 DSH 中配置的模型；也可以在工作台里另选模型。',
      category: '效率', author: 'codesstar', version: VERSION,
      repository: 'https://github.com/codesstar/dsh-bidread',
      // 业务整页 + 按需对话：平时整页看解读，用户点“问答”才展开 DSH 原生对话
      customFrame: true,
    }, Panel))
  }

  module.exports = { inject, apply, VERSION }
  return module.exports
} })
