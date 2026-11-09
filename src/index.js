// 招标文件解读工作台 · DSH 服务端
// 接口和本地服务 tools/dev_server.py 完全一致（页面只认 /api/bidread/...），区别只在：
//   - 模型走 DSH 的 ctx.llm（用户在 DSH 里配好的模型），可以在工作台里另选；
//   - 数据放在 DSH 数据目录（cordis.patch.yml 里的 dshHomePath('bidread')）。
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { createStore, NotFound, Conflict } from './store.js'
import { callModel, currentRoute, listProviders, listModels, lightEffort } from './llm.js'
import { createTools } from './tools.js'

export const name = 'dsh-bidread'
// 这一版 cordis 的 inject 只能列服务名（全部视为必需），不支持“可选”：写成 {required, optional} 会被当成两个叫 required、optional 的服务而一直等待
export const inject = ['webServer', 'connection', 'llm', 'agentDefaultModel', 'agents', 'desktopWorkbenchOwnership']
export const Config = Schema.object({
  root: Schema.string().required().description('招标文件解读工作台的数据目录（上传的资料和解读结果）。')
})

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const PREFIX = '/api/bidread/'
const MAX_BODY = 300 * 1024 * 1024
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf' }
const VERSION = JSON.parse(await readFile(join(PUBLIC, '..', 'package.json'), 'utf8')).version

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  res.writeHead(status, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-store' })
  res.end(data)
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('文件太大'), { status: 413 })); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject)
  })
}

// 旧版 .doc/.xls：有 LibreOffice 就转换，没有时页面提示另存为
const SOFFICE = [process.env.BIDREAD_SOFFICE, '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice', '/usr/local/bin/soffice',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe'].find(p => p && existsSync(p))
async function convertOffice(data, from, to) {
  if (!SOFFICE) throw Object.assign(new Error('本机没有 LibreOffice，请把文件另存为 .' + to + ' 后再添加'), { status: 501 })
  const dir = await mkdtemp(join(tmpdir(), 'bidread-'))
  try {
    const src = join(dir, 'in.' + from); await writeFile(src, data)
    await new Promise((ok, fail) => execFile(SOFFICE, ['--headless', `-env:UserInstallation=file://${join(dir, 'profile')}`, '--convert-to', to, '--outdir', dir, src], { timeout: 180000 }, e => e ? fail(e) : ok()))
    return await readFile(join(dir, 'in.' + to))
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export function apply(ctx, config) {
  const store = createStore(config.root)
  const settingsPath = join(config.root, 'settings.json')
  const loadSettings = async () => { try { return JSON.parse(await readFile(settingsPath, 'utf8')) } catch { return {} } }
  // 面板里当前打开的项目：DSH 智能体的工具读的就是它
  let currentPid = null
  const currentPath = join(config.root, 'current.json')
  readFile(currentPath, 'utf8').then(t => { currentPid = JSON.parse(t).pid || null }).catch(() => {})

  async function projects(req, res, parts) {
    const m = req.method
    if (!parts.length) {
      if (m === 'GET') return send(res, 200, await store.list())
      if (m === 'POST') { const b = JSON.parse((await readBody(req)).toString() || '{}'); return send(res, 200, await store.create(b.name, b.autoName)) }
    } else if (parts[0] === '.trash') {
      if (parts.length === 1 && m === 'GET') return send(res, 200, await store.listTrash())
      if (parts.length === 2 && m === 'POST') return send(res, 200, await store.restore(parts[1]))
      if (parts.length === 2 && m === 'DELETE') { await store.purge(parts[1]); return send(res, 200, { ok: true }) }
    } else if (parts.length === 1) {
      if (m === 'GET') return send(res, 200, await store.get(parts[0]))
      if (m === 'PATCH') { const b = JSON.parse((await readBody(req)).toString() || '{}'); return send(res, 200, await store.rename(parts[0], b.name, b.autoName)) }
      if (m === 'DELETE') { await store.remove(parts[0]); return send(res, 200, { ok: true }) }
    } else if (parts.length === 2 && parts[1] === 'text' && m === 'PUT') {
      await store.saveText(parts[0], JSON.parse((await readBody(req)).toString() || '[]')); return send(res, 200, { ok: true })
    } else if (parts.length === 2 && parts[1] === 'state' && m === 'PUT') {
      await store.saveState(parts[0], JSON.parse((await readBody(req)).toString() || 'null')); return send(res, 200, { ok: true })
    } else if (parts.length === 3 && parts[1] === 'files') {
      if (m === 'GET') return send(res, 200, await store.readFile(parts[0], parts[2]), 'application/octet-stream')
      if (m === 'PUT') return send(res, 200, { name: await store.saveFile(parts[0], parts[2], await readBody(req)) })
      if (m === 'DELETE') { await store.removeFile(parts[0], parts[2]); return send(res, 200, { ok: true }) }
    }
    return send(res, 404, { error: 'not found' })
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === PREFIX + 'app' || path === PREFIX + 'app/') return send(res, 200, await readFile(join(PUBLIC, 'app.html')), TYPES['.html'])
    for (const dir of ['vendor', 'sample']) if (path.startsWith(PREFIX + dir + '/')) {
      const f = path.slice((PREFIX + dir + '/').length)
      if (!/^[\w.-]+$/.test(f) || !existsSync(join(PUBLIC, dir, f))) return send(res, 404, { error: 'not found' })
      return send(res, 200, await readFile(join(PUBLIC, dir, f)), TYPES[extname(f)] || 'application/octet-stream')
    }
    if (path.startsWith(PREFIX + 'projects')) {
      const parts = path.slice((PREFIX + 'projects').length).split('/').filter(Boolean).map(decodeURIComponent)
      return projects(req, res, parts)
    }
    if (path === PREFIX + 'current' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString() || '{}')
      currentPid = typeof b.pid === 'string' && b.pid ? b.pid : null
      await writeFile(currentPath, JSON.stringify({ pid: currentPid }), 'utf8')
      // 面板为这个项目建 DSH 会话时，用项目资料所在文件夹作工作区
      return send(res, 200, { ok: true, folder: currentPid ? join(config.root, currentPid) : null })
    }
    if (path === PREFIX + 'llm' && req.method === 'POST') {
      const { prompt } = JSON.parse((await readBody(req)).toString() || '{}')
      const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort() })
      try { return send(res, 200, await callModel(ctx, await loadSettings(), String(prompt || ''), ac.signal), 'text/plain; charset=utf-8') }
      catch (e) { return send(res, e.status || 502, { error: e.message || String(e), code: e.code }) }
    }
    if (path === PREFIX + 'model') {
      if (req.method === 'GET') {
        const settings = await loadSettings(), providers = listProviders(ctx)
        for (const p of providers) if (!p.models.length) p.models = await listModels(ctx, p.provider)
        // 有的提供方不公布模型列表：至少把当前正在用的模型放进去，下拉里才选得到
        const cur = currentRoute(ctx, settings), def = currentRoute(ctx, {})
        for (const r of [cur, def]) { const p = r && providers.find(x => x.provider === r.provider); if (p && r.model && !p.models.includes(r.model)) p.models.unshift(r.model) }
        const current = currentRoute(ctx, settings)
        return send(res, 200, { current, effort: current ? await lightEffort(ctx, current) ?? null : null, dshDefault: currentRoute(ctx, {}), providers })
      }
      if (req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString() || '{}')
        const next = b.provider && b.model ? { provider: String(b.provider), model: String(b.model) } : {}
        await writeFile(settingsPath, JSON.stringify(next), 'utf8')
        return send(res, 200, { current: currentRoute(ctx, next) })
      }
    }
    if (path === PREFIX + 'convert' && req.method === 'POST') {
      const from = url.searchParams.get('from'), to = url.searchParams.get('to')
      if (!['xls>xlsx', 'doc>docx'].includes(`${from}>${to}`)) return send(res, 400, { error: `不支持 ${from} → ${to}` })
      return send(res, 200, await convertOffice(await readBody(req), from, to), 'application/octet-stream')
    }
    if (path === PREFIX + 'ocr') return send(res, req.method === 'GET' ? 200 : 503, { available: false, error: '工作台暂未提供扫描件识别' })
    if (path === PREFIX + 'health') {
      const r = currentRoute(ctx, await loadSettings())
      return send(res, 200, { ok: true, version: VERSION, model: r, libreoffice: !!SOFFICE, data_dir: config.root })
    }
    return send(res, 404, { error: 'not found' })
  }

  // ---------- DSH 智能体工具：只挂在归属本工作台的会话上 ----------
  const tools = createTools({ defineTool, store, current: () => currentPid })
  const mounted = new Map()
  // 本地安装时工作台 ID 是 local:dsh-bidread，上架后是“GitHub 账号/仓库”
  const isOurs = id => typeof id === 'string' && (id === 'local:dsh-bidread' || /\/dsh-bidread$/i.test(id))
  const owns = (snap, sessionId) => { const id = snap?.sessionBindings?.[sessionId]; return isOurs(id) && Array.isArray(snap.added) && snap.added.includes(id) }
  const detach = id => { const ds = mounted.get(id); if (!ds) return; mounted.delete(id); for (const d of ds) { try { d() } catch {} } }
  async function reconcile(agent) {
    if (!agent?.id) return
    try {
      const snap = await ctx.desktopWorkbenchOwnership.read()
      if (!owns(snap, agent.id)) return detach(agent.id)
      if (!mounted.has(agent.id)) mounted.set(agent.id, tools.map(t => agent.ctx.tools.register(t)))
    } catch { detach(agent.id) }   // 读不到归属就不给工具
  }
  async function reconcileAll() {
    const agents = ctx.agents.list(), live = new Set(agents.map(a => a.id))
    for (const id of mounted.keys()) if (!live.has(id)) detach(id)
    await Promise.all(agents.map(reconcile))
  }
  ctx.on('agent/created', ({ agent }) => { void reconcile(agent) })
  ctx.on('agent/disposed', ({ agent }) => detach(agent.id))
  void reconcileAll()
  ctx.effect(() => {
    const timer = setInterval(() => { void reconcileAll() }, 3000); timer.unref?.()
    return () => { clearInterval(timer); for (const id of [...mounted.keys()]) detach(id) }
  })

  // 前缀路由不能带结尾斜杠：DSH 按 pathname === prefix 或以 prefix + '/' 开头来匹配
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: PREFIX.replace(/\/$/, ''),
    handler: (req, res) => {
      // 和其他工作台一样：所有请求先过 DSH 的登录校验
      const rejection = ctx.connection?.requestRejection?.(req)
      if (!ctx.connection?.requestRejection || rejection !== undefined) return send(res, rejection || 403, { error: 'Authentication required' })
      return handle(req, res).catch(e => {
        if (e instanceof NotFound) return send(res, 404, { error: 'not found: ' + e.message })
        if (e instanceof Conflict) return send(res, 409, { error: e.message })
        return send(res, e.status || 500, { error: e instanceof Error ? e.message : String(e) })
      })
    }
  }), 'dsh-bidread: ' + PREFIX)
}
