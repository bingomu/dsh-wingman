/**
 * 「转」的 AI 半侧：把用户选中的一段交给当前会话的模型处理一次。
 *
 * 三条路径与 `dsh-prompt-hints` 一致：先看会话的 requestHeader 记下的路由，
 * 再退到 `agentDefaultModel` 的当前选择；调用走 `llm.stream(...)`，
 * 只累加文本块，finish 为 error/aborted 时抛错。
 *
 * @module dsh-wingman/lib/transform
 */

const SYSTEM = {
  prompt: '你把用户选中的一段文字改写成一条可以直接发给 AI 编码助手的中文指令：保留事实、路径、约束与专有名词，去掉口语和背景叙述；只输出这段指令本身，不要解释，不要加引号或代码块。',
  summary: '你把用户选中的一段文字提炼成 3-5 条要点，每条一行、以「- 」开头；只保留事实与结论，不重复原句，不加解释，不写总结段。',
  translate: '你把用户选中的一段文字译成简体中文，保留代码、路径与专有名词原样；只输出译文，不要解释，不要加引号。',
  translateEn: '你把用户选中的一段文字译成英文，保留代码、路径与专有名词原样；只输出译文，不要解释，不要加引号。',
  explain: '你用简体中文解释用户选中的这段内容：先一句话说它是什么，再列 2-4 条关键点，最后一句说它为什么重要。不要复述原句，不要加标题，总长不超过 120 字。',
  tests: '你根据用户选中的这段内容，用简体中文列出 3-5 条直接的测试用例，每条一行、以「- 」开头；写清「输入/场景 → 期望结果」，不要解释，不要写测试代码。',
}

const MAX_INPUT = 12000
const MAX_OUTPUT_TOKENS = 900
const TIMEOUT_MS = 25000

function serviceOf(ctx, name) {
  try {
    if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 会话当前用的模型；拿不到就退到默认模型。 */
function routeOf(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  let session
  try {
    session = sessions !== undefined && typeof sessions.get === 'function' && typeof sessionId === 'string'
      ? sessions.get(sessionId)
      : undefined
  } catch {
    session = undefined
  }
  try {
    const header = session !== null && session !== undefined && typeof session.requestHeader === 'function'
      ? session.requestHeader()
      : undefined
    const config = header === null || header === undefined ? undefined : header.config
    if (config !== null && config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  } catch {
    // 还没写过 request header。
  }
  const defaults = serviceOf(ctx, 'agentDefaultModel')
  if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
    try {
      const selection = defaults.currentSelection()
      if (selection !== null && selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // 没有默认模型。
    }
  }
  return undefined
}

function timeoutSignal() {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(TIMEOUT_MS)
  } catch {
    // 没有就同步调用。
  }
  return undefined
}

/**
 * 跑一次转换。
 * @param {*} ctx 带 get 的宿主上下文
 * @param {{ sessionId?: string, action?: string, text?: string }} request
 * @returns {Promise<{ text: string, model: string, provider: string }>}
 */
export async function runTransform(ctx, request) {
  const action = typeof request?.action === 'string' ? request.action : ''
  const system = SYSTEM[action]
  if (typeof system !== 'string') throw Object.assign(new Error(`unknown action: ${action || '(empty)'}`), { code: 'unknown_action' })

  const raw = typeof request?.text === 'string' ? request.text.trim() : ''
  if (raw === '') throw Object.assign(new Error('text is required'), { code: 'empty_text' })
  const text = raw.slice(0, MAX_INPUT)

  const llm = serviceOf(ctx, 'llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw Object.assign(new Error('模型服务不可用'), { code: 'no_llm' })
  }

  const route = routeOf(ctx, typeof request?.sessionId === 'string' ? request.sessionId : undefined)
  if (route === undefined) throw Object.assign(new Error('找不到可用模型'), { code: 'no_route' })

  const signal = timeoutSignal()
  const options = {
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    maxTokens: MAX_OUTPUT_TOKENS,
    ...(signal === undefined ? {} : { signal }),
  }

  const chunks = []
  let finish
  for await (const chunk of llm.stream(options)) {
    if (chunk === null || chunk === undefined) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') chunks.push(chunk.text)
    else if (chunk.type === 'finish') finish = chunk.reason
  }

  if (finish !== null && finish !== undefined && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const message = finish.failure !== null && finish.failure !== undefined && typeof finish.failure.message === 'string'
      ? finish.failure.message
      : `model call ${finish.kind}`
    throw Object.assign(new Error(message), { code: 'model_failed' })
  }

  const out = chunks.join('').trim()
  if (out === '') throw Object.assign(new Error('模型返回了空内容'), { code: 'empty_reply' })

  return { text: out, provider: route.provider, model: route.model }
}
