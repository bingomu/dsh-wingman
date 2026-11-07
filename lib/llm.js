/**
 * 与模型打交道的公共小工具：解析路由 + 收一次完整回复。
 *
 * 路由顺序与会话里实际用的一致：requestHeader 记下的 → agentDefaultModel 的当前选择。
 *
 * @module dsh-wingman/lib/llm
 */

const TIMEOUT_MS = 25000

/** 安全取服务。 */
export function serviceOf(ctx, name) {
  try {
    if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 会话当前用的模型；拿不到就退到默认模型。 */
export function resolveRoute(ctx, sessionId) {
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
 * 收一次完整回复：只累加文本块，finish 为 error/aborted 时抛错。
 * @param {*} ctx
 * @param {{ provider: string, model: string }} route
 * @param {{ system: string, user: string, maxTokens?: number }} request
 * @returns {Promise<string>}
 */
const RETRYABLE = /transport|network|timeout|timed out|ECONN|socket|fetch failed/i

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function streamOnce(ctx, route, request) {
  const llm = serviceOf(ctx, 'llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw Object.assign(new Error('模型服务不可用'), { code: 'no_llm' })
  }
  if (route === undefined) throw Object.assign(new Error('找不到可用模型'), { code: 'no_route' })

  const signal = timeoutSignal()
  const options = {
    provider: route.provider,
    model: route.model,
    system: request.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
    maxTokens: request.maxTokens ?? 900,
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

  const text = chunks.join('').trim()
  if (text === '') throw Object.assign(new Error('模型返回了空内容'), { code: 'empty_reply' })
  return text
}

/**
 * 带一次重试的入口：传输类错误（网络抖动、连接被重置）重试一次，其余直接抛。
 */
export async function streamText(ctx, route, request) {
  try {
    return await streamOnce(ctx, route, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!RETRYABLE.test(message)) throw error
    await sleep(800)
    return streamOnce(ctx, route, request)
  }
}
