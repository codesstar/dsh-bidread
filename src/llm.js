// 模型调用：走 DSH 的 ctx.llm（用户在 DSH 里配置好的模型），不需要另外的密钥。
// 用哪个模型：工作台里选过的优先，其次是 DSH 的默认模型（ctx.agentDefaultModel），再其次是第一个可用的提供方。
// 和本地服务 dev_server.py 的处理一致：开头输出思考过程时立即中断重试；常见的 JSON 小毛病先修好再交给页面。

const MAX_TOKENS = 16000

/** 页面适配器认识的错误码（见 app/index.html 的 codeCopy）对应的 HTTP 状态 */
export function httpStatusOf(code) {
  return { RATE_LIMIT: 429, CONTEXT_WINDOW_EXCEEDED: 413, CONTENT_FILTERED: 451 }[code] || 502
}

/** 当前生效的模型路由 */
export function currentRoute(ctx, settings) {
  if (settings?.provider && settings?.model) return { provider: settings.provider, model: settings.model, source: 'workbench' }
  try {
    const s = ctx.agentDefaultModel?.currentSelection?.()
    if (s?.provider && s?.model) return { provider: s.provider, model: s.model, source: 'dsh-default' }
  } catch {}
  const p = listProviders(ctx)[0]
  return p ? { provider: p.provider, model: p.models[0] || '', source: 'first' } : null
}

/** 可选的提供方和模型（给页面的“模型”设置用） */
export function listProviders(ctx) {
  let ps = []
  try { ps = ctx.llm?.listProviders?.() || [] } catch {}
  return ps.map(p => ({ provider: p.provider || p.id || p.route || String(p), label: p.label || p.name || p.provider || p.id || String(p),
    models: (p.models || []).map(m => m.id || m.model || m.name || String(m)).filter(Boolean) })).filter(p => p.provider)
}

export async function listModels(ctx, provider) {
  try { const ms = await ctx.llm?.listModels?.(provider); if (Array.isArray(ms)) return ms.map(m => m.id || m.model || m.name || String(m)).filter(Boolean) } catch {}
  return listProviders(ctx).find(p => p.provider === provider)?.models || []
}

/* 抽取任务不需要模型“想很久”：思考型模型（如 deepseek-v4-pro）默认思考强度下，一次请求实测要 3 到 6 分钟，
   还会把输出额度耗在思考上、正文为空，页面就显示“解读中断”。所以选模型支持的最低思考强度（优先“不思考”）。 */
const effortCache = new Map()
export async function lightEffort(ctx, route) {
  const key = route.provider + '/' + route.model
  if (effortCache.has(key)) return effortCache.get(key)
  let pick
  try {
    const info = await ctx.llm.resolveModelInfo?.(route.provider, route.model)
    const ef = info?.reasoning?.efforts || []
    const by = re => ef.find(e => re.test(String(e.id)) || re.test(String(e.name || '')))
    pick = (by(/none|off|disable|no.?think|non.?think|不思考|关闭/i) || by(/minimal|lowest/i) || by(/low|低/i))?.id
  } catch {}
  effortCache.set(key, pick)
  return pick
}

// 同时最多几个模型请求：页面会一次发出十几个（速览分组、分段抽取），全部并发容易被限流或超时
let running = 0; const queue = []
const slot = () => new Promise(r => { if (running < 4) { running++; r() } else queue.push(r) })
const release = () => { const n = queue.shift(); if (n) n(); else running-- }

async function streamOnce(ctx, route, prompt, maxTokens, abortOnThink, signal, effort) {
  let text = '', failure = null, finish = null
  for await (const chunk of ctx.llm.stream({
    provider: route.provider, model: route.model, maxTokens, temperature: 0.1, signal, ...(effort ? { reasoningEffort: effort } : {}),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  })) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      if (abortOnThink) { const head = text.trimStart(); if (head.length >= 7 && head.startsWith('<think>')) return { thinking: true } }
    } else if (chunk.type === 'finish') {
      finish = chunk.reason?.kind
      if (finish === 'error' || finish === 'aborted') failure = chunk.reason.failure || { code: 'UPSTREAM', message: '模型请求失败' }
    }
  }
  return { text, failure, finish }
}

/** 发一段提示词，返回模型输出（已去掉思考段、修过常见 JSON 毛病）。失败时 throw {code, status, message} */
export async function callModel(ctx, settings, prompt, signal) {
  if (!ctx.llm?.stream) throw { status: 503, code: 'NO_LLM', message: '当前 DSH 没有可用的模型服务' }
  const route = currentRoute(ctx, settings)
  if (!route?.provider || !route?.model) throw { status: 503, code: 'NO_MODEL', message: '还没有选择模型：请先在 DSH 里配置模型，或在工作台的“模型”里选择' }
  const effort = await lightEffort(ctx, route)
  let r
  await slot()
  try {
    for (let attempt = 0, empty = 0; attempt < 6; attempt++) {
      const last = attempt === 5
      r = await streamOnce(ctx, route, prompt, MAX_TOKENS * (last ? 2 : 1), !last, signal, effort)
      if (r.thinking) continue
      // 正文为空（输出额度耗在思考上，或服务偶发）：再试，最多两次
      if (!r.failure && !String(r.text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim() && ++empty <= 2) continue
      break
    }
  } finally { release() }
  if (!r.failure && !String(r.text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim())
    throw { status: 502, code: 'EMPTY', message: '模型没有返回内容（可能是思考过长、输出额度不够），可以换一个模型或稍后重试' }
  if (r.failure) {
    const code = r.failure.code || 'UPSTREAM'
    throw { status: code === 'ABORTED' || r.finish === 'aborted' ? 499 : httpStatusOf(code), code, message: r.failure.message || code }
  }
  return tidyJson(String(r.text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim())
}

/** 模型的 JSON 并不总是严格合法：结尾多括号、值少引号、"null 少引号等。能修就修，修不好原样返回由页面处理 */
export function tidyJson(text) {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) t = fence[1].trim()
  t = t.replace(/":"null([,}])/g, '":null$1')
  const keys = 'file|page|quote|name|need|form|changedFrom|changed|from|text|value|type|topic|before|after|impact|orig|rule|tip|points|part|method|total|summary|meaning'
  t = t.replace(new RegExp(`"(${keys}):"`, 'g'), '"$1":"')
  const first = t.search(/[{[]/); if (first > 0) t = t.slice(first)
  // 只取开头一个完整对象，忽略结尾多出来的括号
  try { return JSON.stringify(JSON.parse(t)) } catch {}
  let depth = 0, inStr = false, esc = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') { depth--; if (depth === 0) { const head = t.slice(0, i + 1); if (!t.slice(i + 1).replace(/[\s}\]]/g, '')) { try { return JSON.stringify(JSON.parse(head)) } catch {} } break } }
  }
  return text
}
