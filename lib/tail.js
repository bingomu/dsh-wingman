/**
 * 「接着上次」：找同一个工作区里最近的一个会话，读它的尾巴，让模型拼成开场白。
 *
 * 只读：listSessions 找候选、readSession 读事件、llm 生成一段话。
 * 不会打开那个会话，也不会改动它。
 *
 * @module dsh-wingman/lib/tail
 */

import { resolveRoute, serviceOf, streamText } from './llm.js'

const SYSTEM = [
  '你在帮用户续上一个会话。基于给出的旧对话记录，用第一人称写一段可以**直接发出去**的开场白，像刚坐下来接着干活的人说话：',
  '两句话，总共不超过 80 字。',
  '第一句交代上次做到哪、已经定下什么；第二句只说这次先做什么。',
  '不要罗列所有细节，不要用「结论」「未决」「下一步」这类小标题，不要寒暄，不要「以下是」。',
  '只输出这两句话本身。',
].join('\n')

const MAX_MESSAGES = 10
const MAX_CHARS = 8000

/** 从消息 content 里取纯文本。 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && block !== undefined && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 从原始事件里抽最近几条用户/助手消息。 */
export function linesFromEvents(events) {
  const lines = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || event === undefined) continue
    if (event.type === 'user/message') {
      const text = textOfContent(event.data?.content)
      if (text !== '') lines.push(`用户: ${text}`)
    } else if (event.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content)
      if (text !== '') lines.push(`助手: ${text}`)
    }
  }
  return lines.slice(-MAX_MESSAGES)
}

/**
 * 生成「接着上次」的开场白。
 * @param {*} ctx 带 get 的宿主上下文
 * @param {{ sessionId?: string }} request 当前会话
 * @returns {Promise<{ text: string, previousSessionId: string, previousTitle: string }>}
 */
export async function runTail(ctx, request) {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
  const query = serviceOf(ctx, 'sessionQuery')
  if (query === undefined || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
    throw Object.assign(new Error('会话查询服务不可用'), { code: 'no_query' })
  }

  const sessions = serviceOf(ctx, 'sessions')
  let current
  try {
    current = sessions !== undefined && typeof sessions.get === 'function' && sessionId !== '' ? sessions.get(sessionId) : undefined
  } catch {
    current = undefined
  }
  const cwd = current?.header?.cwd

  let records
  try {
    records = await query.listSessions()
  } catch {
    throw Object.assign(new Error('读取会话列表失败'), { code: 'list_failed' })
  }

  const candidates = (Array.isArray(records) ? records : [])
    .filter((record) => record !== null && record !== undefined)
    .filter((record) => record.header?.id !== sessionId && record.header?.origin !== 'subagent')
    .filter((record) => cwd === undefined || cwd === '' || record.header?.cwd === cwd)
    .sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))

  if (candidates.length === 0) {
    throw Object.assign(new Error('这个工作区还没有上一个会话'), { code: 'no_previous' })
  }

  // 最近的会话可能是空的（刚建、子代理、只有工具调用），逐个往前找到有内容的那一个
  let previous = null
  let lines = []
  for (const candidate of candidates.slice(0, 6)) {
    let snapshot
    try {
      snapshot = await query.readSession(candidate.header.id)
    } catch {
      continue
    }
    const found = linesFromEvents(snapshot?.events)
    if (found.length > 0) {
      previous = candidate
      lines = found
      break
    }
  }
  if (previous === null) {
    throw Object.assign(new Error('最近的几个会话都没有可用的文字内容'), { code: 'empty_previous' })
  }

  let transcript = lines.join('\n\n')
  if (transcript.length > MAX_CHARS) transcript = transcript.slice(transcript.length - MAX_CHARS)

  let title = ''
  try {
    if (typeof query.readTitle === 'function') {
      const found = await query.readTitle(previous.header.id)
      if (found !== null && found !== undefined && typeof found.title === 'string') title = found.title
    }
  } catch {
    // 标题拿不到就不显示。
  }

  const route = resolveRoute(ctx, sessionId)
  const text = await streamText(ctx, route, {
    system: SYSTEM,
    user: `旧对话记录：\n${transcript}\n\n请写这次的开场白。`,
    maxTokens: 200,
  })

  let opening = text.replace(/\s+/g, ' ').trim()
  if (opening.length > 160) {
    const sentences = opening.split(/(?<=[。！？!?])/).filter((part) => part.trim() !== '')
    opening = sentences.slice(0, 2).join('').trim()
  }

  return { text: opening, previousSessionId: previous.header.id, previousTitle: title }
}
