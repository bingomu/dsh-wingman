/**
 * 「说到哪了」：让当前会话的模型读最近几十条消息，产出三段复盘。
 *
 * 输出结构固定：3 条结论 / 2 条未决 / 1 条下一步。
 * 只读会话，不写任何东西；模型调用失败就抛错，由面板显示人话提示。
 *
 * @module dsh-wingman/lib/recap
 */

import { resolveRoute, serviceOf, streamText } from './llm.js'

const SYSTEM = [
  '你是会话复盘助手。只依据给出的对话记录，用简体中文输出三段，不要寒暄，不要总结性开场：',
  '【结论】3 条已经确定的事',
  '【未决】2 条还没解决的问题',
  '【下一步】1 条建议的下一步',
  '每条一行、以「- 」开头；只写事实与结论，不要复述原话；信息不足时对应段落只写「- 暂无可提取内容」。',
].join('\n')

const MAX_MESSAGES = 16
const MAX_CHARS = 9000

/** 从一条消息里取出纯文本。 */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block !== null && block !== undefined && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 读最近若干条有文字的消息，拼成一段带角色的记录。 */
export function transcriptOf(session) {
  const messages = session !== null && session !== undefined && typeof session.deriveMessages === 'function'
    ? session.deriveMessages()
    : []
  const lines = []
  for (const message of messages) {
    const text = textOf(message)
    if (text === '') continue
    const role = message?.role === 'user' ? '用户' : message?.role === 'assistant' ? '助手' : message?.role === 'tool' ? '工具' : ''
    if (role === '') continue
    lines.push(`${role}: ${text}`)
  }
  const recent = lines.slice(-MAX_MESSAGES)
  let transcript = recent.join('\n\n')
  if (transcript.length > MAX_CHARS) transcript = transcript.slice(transcript.length - MAX_CHARS)
  return transcript
}

/**
 * 跑一次复盘。
 * @param {*} ctx 带 get 的宿主上下文
 * @param {{ sessionId?: string }} request
 * @returns {Promise<{ text: string, provider: string, model: string }>}
 */
export async function runRecap(ctx, request) {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  if (sessionId === '') throw Object.assign(new Error('sessionId is required'), { code: 'no_session' })

  const sessions = serviceOf(ctx, 'sessions')
  let session
  try {
    session = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  } catch {
    session = undefined
  }
  if (session === undefined) throw Object.assign(new Error('找不到这个会话'), { code: 'no_session' })

  const transcript = transcriptOf(session)
  if (transcript === '') throw Object.assign(new Error('这个会话还没有可复盘的内容'), { code: 'empty_conversation' })

  const route = resolveRoute(ctx, sessionId)
  const text = await streamText(ctx, route, {
    system: SYSTEM,
    user: `对话记录：\n${transcript}\n\n请按三段输出复盘。`,
    maxTokens: 700,
  })

  return { text, provider: route.provider, model: route.model }
}
