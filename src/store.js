// 项目存储：tools/projects_store.py 的 Node 版，目录结构完全相同（数据可以在本地服务和工作台之间直接拷贝）。
//   <root>/<项目ID>/project.json   名称、创建与更新时间
//   <root>/<项目ID>/state.json     解读结果、勾选、修改、复核记录
//   <root>/<项目ID>/files/         原始文件
//   <root>/.trash/<项目ID>-<时间戳>/  删除的项目先挪到这里，可恢复
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

export const ID_RE = /^p\d{8}-\d{6}-[0-9a-f]{4}$/
const TRASH_RE = /^(p\d{8}-\d{6}-[0-9a-f]{4})-(\d+)$/
export class NotFound extends Error {}
export class Conflict extends Error {}

const pad = n => String(n).padStart(2, '0')
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const now = () => stamp(new Date())
const readJson = async (p, dflt) => { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return dflt } }
const writeJson = async (p, v) => { const tmp = p + '.tmp'; await writeFile(tmp, JSON.stringify(v), 'utf8'); await rename(tmp, p) }

// 只保留文件名本身，去掉路径和控制字符，防止写到项目目录之外
function safeName(name) {
  const n = basename(String(name || '').replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').trim()
  if (!n || n === '.' || n === '..') throw new Error('文件名无效')
  return n.slice(0, 200)
}

export function createStore(root) {
  const pdir = async pid => {
    if (!ID_RE.test(pid || '')) throw new NotFound(pid)
    const d = join(root, pid)
    if (!existsSync(join(d, 'project.json'))) throw new NotFound(pid)
    return d
  }
  async function summary(d) {
    const meta = await readJson(join(d, 'project.json'), {})
    const fdir = join(d, 'files')
    const files = existsSync(fdir) ? (await readdir(fdir)).filter(n => !n.startsWith('.')) : []
    const state = await readJson(join(d, 'state.json'), {}) || {}
    const res = state.res || {}, ov = res.overview || {}, rv = state.rv || {}
    return { ...meta, fileCount: files.length, analyzed: !!res.overview,
      modules: ['overview', 'changes', 'risks', 'scoring', 'materials'].filter(m => res[m]).length,
      deadline: ov.deadline_iso || null, type: state.cat || ov.type || null, brief: String(ov.summary || '').slice(0, 80),
      confirmed: Object.values(rv).filter(v => v && v.s === 'ok').length,
      risks: Object.values(res.risks || {}).filter(Array.isArray).reduce((a, v) => a + v.length, 0) }
  }
  const touch = async d => { const p = join(d, 'project.json'); const m = await readJson(p, {}); m.updated = now(); await writeJson(p, m) }

  return {
    root,
    async list() {
      await mkdir(root, { recursive: true })
      const out = []
      for (const pid of await readdir(root)) if (ID_RE.test(pid) && existsSync(join(root, pid, 'project.json'))) out.push(await summary(join(root, pid)))
      return out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
    },
    async create(name, autoName) {
      const d0 = new Date()
      const pid = `p${d0.getFullYear()}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}-${pad(d0.getHours())}${pad(d0.getMinutes())}${pad(d0.getSeconds())}-${randomBytes(2).toString('hex')}`
      const d = join(root, pid)
      await mkdir(join(d, 'files'), { recursive: true })
      await writeJson(join(d, 'project.json'), { id: pid, name: (String(name || '').trim() || '未命名项目').slice(0, 120), autoName: !!autoName, created: now(), updated: now() })
      return summary(d)
    },
    async rename(pid, name, autoName) {
      const d = await pdir(pid), p = join(d, 'project.json'), m = await readJson(p, {})
      Object.assign(m, { name: (String(name || '').trim() || m.name || '未命名项目').slice(0, 120), autoName: !!autoName, updated: now() })
      await writeJson(p, m); return summary(d)
    },
    async remove(pid) {
      const d = await pdir(pid), trash = join(root, '.trash')
      await mkdir(trash, { recursive: true })
      await rename(d, join(trash, `${pid}-${Math.floor(Date.now() / 1000)}`))
    },
    async get(pid) {
      const d = await pdir(pid), fdir = join(d, 'files')
      const names = existsSync(fdir) ? (await readdir(fdir)).filter(n => !n.startsWith('.')).sort() : []
      const files = []
      for (const n of names) files.push({ name: n, size: (await stat(join(fdir, n))).size })
      return { project: await summary(d), files, state: await readJson(join(d, 'state.json'), null) }
    },
    async saveFile(pid, name, data) {
      const d = await pdir(pid), fdir = join(d, 'files'); await mkdir(fdir, { recursive: true })
      let n = safeName(name)
      // 同名但内容不同：加序号保存，不覆盖
      if (existsSync(join(fdir, n))) {
        const old = await readFile(join(fdir, n))
        if (!old.equals(data)) { const dot = n.lastIndexOf('.'), stem = dot > 0 ? n.slice(0, dot) : n, ext = dot > 0 ? n.slice(dot) : ''; let k = 2; while (existsSync(join(fdir, `${stem}（${k}）${ext}`))) k++; n = `${stem}（${k}）${ext}` }
      }
      await writeFile(join(fdir, n), data); await touch(d); return n
    },
    async readFile(pid, name) { const d = await pdir(pid); const p = join(d, 'files', safeName(name)); if (!existsSync(p)) throw new NotFound(name); return readFile(p) },
    async removeFile(pid, name) { const d = await pdir(pid); const p = join(d, 'files', safeName(name)); if (existsSync(p)) await rm(p); await touch(d) },
    // 页面识别出的原文文字（给 DSH 智能体搜索、读页用）
    async saveText(pid, files) { const d = await pdir(pid); await writeJson(join(d, 'text.json'), files) },
    async saveState(pid, state) { const d = await pdir(pid); await writeJson(join(d, 'state.json'), state); await touch(d) },
    async listTrash() {
      const trash = join(root, '.trash'); if (!existsSync(trash)) return []
      const out = []
      for (const tid of await readdir(trash)) {
        const m = TRASH_RE.exec(tid)
        if (m && existsSync(join(trash, tid, 'project.json'))) out.push({ ...await summary(join(trash, tid)), trashId: tid, deleted: stamp(new Date(+m[2] * 1000)) })
      }
      return out.sort((a, b) => b.deleted.localeCompare(a.deleted))
    },
    async restore(tid) {
      const m = TRASH_RE.exec(tid || ''); if (!m) throw new NotFound(tid)
      const src = join(root, '.trash', tid), dst = join(root, m[1])
      if (!existsSync(join(src, 'project.json'))) throw new NotFound(tid)
      if (existsSync(dst)) throw new Conflict('同名项目已存在，不能恢复')
      await rename(src, dst); return summary(dst)
    },
    async purge(tid) {
      if (!TRASH_RE.test(tid || '')) throw new NotFound(tid)
      const p = join(root, '.trash', tid); if (!existsSync(join(p, 'project.json'))) throw new NotFound(tid)
      await rm(p, { recursive: true, force: true })
    }
  }
}
