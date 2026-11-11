// 复核问题的回归测试（不进安装包）：node --test test/*.test.mjs
//   1. 工具只读发起调用的会话所属的项目，和页面当前打开哪个项目无关；
//   2. 工作区改名只改“包含这个会话且完整路径等于项目文件夹真实路径”的那一个。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, realpath, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/store.js'
import { createTools } from '../src/tools.js'

const defineTool = t => t
const agentAt = cwd => ({ session: { header: { cwd } } })

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bidread-scope-')))
  const store = createStore(root)
  const A = await store.create('项目A 教学楼改造')
  await new Promise(r => setTimeout(r, 1100))   // 项目 ID 精确到秒
  const B = await store.create('项目B 医院设备采购')
  await store.saveText(A.id, [{ name: 'a.pdf', label: '正文', hash: 'ha', role: 'main', unit: '页', pages: ['投标保证金 一万元 甲方专属条款'] }])
  await store.saveText(B.id, [{ name: 'b.pdf', label: '正文', hash: 'hb', role: 'main', unit: '页', pages: ['投标保证金 五万元 乙方专属条款'] }])
  return { root, store, A, B }
}
const run = async (tools, name, args, exec) => JSON.parse(await tools.find(t => t.name === name).execute(args, exec))

test('A 项目的会话在页面切到 B 之后仍只能读 A', async () => {
  const { root, store, A, B } = await setup()
  const toolsA = createTools({ defineTool, store, agent: agentAt(join(root, A.id)) })
  // 页面切到 B：旧版这里会通过 current.json 让 A 的会话读到 B；新版工具不看页面当前项目
  await writeFile(join(root, 'current.json'), JSON.stringify({ pid: B.id }))
  const p = await run(toolsA, 'bidread_project', {}, { agent: agentAt(join(root, A.id)) })
  assert.equal(p.项目, '项目A 教学楼改造')
  assert.equal((await run(toolsA, 'bidread_search', { query: '乙方专属条款' }, { agent: agentAt(join(root, A.id)) })).命中, 0)
  assert.equal((await run(toolsA, 'bidread_search', { query: '甲方专属条款' }, { agent: agentAt(join(root, A.id)) })).命中, 1)
  const page = await run(toolsA, 'bidread_read', { file: '正文', page: 1 }, { agent: agentAt(join(root, A.id)) })
  assert.match(page.pages[0].原文, /一万元/)
  assert.doesNotMatch(page.pages[0].原文, /五万元/)
})

test('以发起调用的会话为准：B 的会话读 B', async () => {
  const { root, store, A, B } = await setup()
  const toolsA = createTools({ defineTool, store, agent: agentAt(join(root, A.id)) })
  const p = await run(toolsA, 'bidread_project', {}, { agent: agentAt(join(root, B.id)) })
  assert.equal(p.项目, '项目B 医院设备采购')
})

test('工作区不是项目资料文件夹时拒绝读取', async () => {
  const { root, store, A } = await setup()
  const other = await realpath(await mkdtemp(join(tmpdir(), 'bidread-other-')))
  await mkdir(join(other, A.id))                         // 别处同名（末段相同）的目录
  const linkDir = join(other, 'link'); await symlink(root, linkDir)
  const cases = [undefined, '', root, join(root, 'files'), join(other, A.id), join(root, A.id, 'files'), join(linkDir, '..', A.id)]
  for (const cwd of cases) {
    const tools = createTools({ defineTool, store, agent: agentAt(cwd) })
    await assert.rejects(() => tools[0].execute({}, { agent: agentAt(cwd) }), /读不到项目资料/, String(cwd))
  }
  // 经链接到达的正是 A 的真实目录：按真实路径比较，允许
  const viaLink = join(linkDir, A.id)
  const ok = createTools({ defineTool, store, agent: agentAt(viaLink) })
  assert.equal(JSON.parse(await ok[0].execute({}, { agent: agentAt(viaLink) })).项目, '项目A 教学楼改造')
})

// ---- 客户端：加载 lib/client.js（模块加载器和 React 用桩），取出导出的 nameWorkspace / samePath ----
async function loadClient() {
  let factory
  globalThis.window = { __ModuleLoader__: { load: m => { factory = m.factory } } }
  new Function(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))()
  return factory(name => (name === 'react' ? { createElement() {}, useState() {}, useRef() {}, useEffect() {}, useCallback() {} } : {}))
}
function fakeWorkspaces(items) {
  const renamed = []
  return { renamed, list: { getSnapshot: () => ({ items }) }, rename: async (id, title) => { renamed.push([id, title]) } }
}
const P = { pid: 'p20261109-180000-de00', name: '城西三中设备采购', folder: '/data/bidread/p20261109-180000-de00' }

test('改名：只改包含该会话且完整路径一致的工作区', async () => {
  const { nameWorkspace } = await loadClient()
  const ws = fakeWorkspaces([
    { workspaceId: 'decoy', path: '/Users/x/Documents/p20261109-180000-de00', title: 'p20261109-180000-de00', sessionIds: ['s1'] },   // 末段相同、也含该会话（极端情况）
    { workspaceId: 'decoy2', path: '/other/p20261109-180000-de00', title: 'p20261109-180000-de00', sessionIds: [] },
    { workspaceId: 'right', path: '/data/bidread/p20261109-180000-de00/', title: 'p20261109-180000-de00', sessionIds: ['s1'] }
  ])
  await nameWorkspace('s1', P, ws, 0)
  assert.deepEqual(ws.renamed, [['right', '城西三中设备采购']])
})

test('改名：会话不在列表里时（旧版会按路径末段改到别的目录）不改任何工作区', async () => {
  const { nameWorkspace } = await loadClient()
  const ws = fakeWorkspaces([
    { workspaceId: 'decoy', path: '/other/place/p20261109-180000-de00', title: 'p20261109-180000-de00', sessionIds: ['s9'] },
    { workspaceId: 'right-no-session-yet', path: '/data/bidread/p20261109-180000-de00', title: 'x', sessionIds: [] }
  ])
  await nameWorkspace('s1', P, ws, 0)
  assert.deepEqual(ws.renamed, [])
})

test('改名：路径比较只在 Windows 盘符路径上忽略大小写和斜杠方向', async () => {
  const { samePath } = await loadClient()
  assert.equal(samePath('C:\\Users\\A\\bidread\\p1', 'c:/users/a/bidread/p1/'), true)
  assert.equal(samePath('/Users/A/bidread/p1', '/users/a/bidread/p1'), false)
  assert.equal(samePath('/a/b/p1', '/c/b/p1'), false)
  assert.equal(samePath('', ''), false)
})
