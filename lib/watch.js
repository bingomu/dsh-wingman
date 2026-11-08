/**
 * 「看」的数据采集：全部只读。
 *
 * - 上下文与 token：Host `tokenMeter.measure(session)`
 * - 模型与窗口：`session.requestContext()`
 * - 运行中的子代理：`subagents.listDescendants(sessionId)`（带 activity；旧宿主退化到 listChildren）
 * - 未完成跟进：读便签墙同款约定下的 `DSH_HOME/followup/tasks.json`
 *
 * 任何一项拿不到都只是少显示一行，绝不抛错——这个面板不该因为某个服务缺席就整个空掉。
 *
 * @module dsh-wingman/lib/watch
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dshHome } from './store.js'

/** 安全地取一个服务；取不到就是 undefined。 */
function serviceOf(ctx, name) {
  try {
    if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 数未完成跟进；文件不存在或格式不对都算「没有」。 */
async function openFollowups() {
  try {
    const raw = await readFile(join(dshHome(), 'followup', 'tasks.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : []
    const open = tasks.filter((task) => task !== null && typeof task === 'object' && task.done !== true).length
    return { open }
  } catch {
    return null
  }
}

/**
 * 采集一次面板数据。
 * @param {*} ctx 带 get 的宿主上下文
 * @param {string | undefined} sessionId
 */
export async function collectWatch(ctx, sessionId) {
  const result = {
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    model: null,
    tokens: null,
    subagents: null,
    followups: await openFollowups(),
    now: Date.now(),
  }

  const sessions = serviceOf(ctx, 'sessions')
  let session
  try {
    session = result.sessionId !== null && sessions !== undefined && typeof sessions.get === 'function'
      ? sessions.get(result.sessionId)
      : undefined
  } catch {
    session = undefined
  }

  if (session !== undefined && session !== null) {
    try {
      const context = typeof session.requestContext === 'function' ? session.requestContext() : undefined
      if (context !== null && context !== undefined) {
        result.model = {
          provider: typeof context.provider === 'string' ? context.provider : '',
          model: typeof context.model === 'string' ? context.model : '',
          contextWindow: Number.isFinite(context.contextWindow) ? context.contextWindow : null,
        }
      }
    } catch {
      // 没有 requestContext 就少一行。
    }

    try {
      const tokenMeter = serviceOf(ctx, 'tokenMeter')
      const measurement = tokenMeter !== undefined && typeof tokenMeter.measure === 'function'
        ? tokenMeter.measure(session)
        : undefined
      if (measurement !== null && measurement !== undefined) {
        const usage = measurement.baseline?.kind === 'usage' ? measurement.baseline.usage : null
        result.tokens = {
          total: Number.isFinite(measurement.totalTokens) ? measurement.totalTokens : null,
          surface: Number.isFinite(measurement.surfaceTokens) ? measurement.surfaceTokens : null,
          input: usage !== null && Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
          output: usage !== null && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
          cacheRead: usage !== null && Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
        }
      }
    } catch {
      // 量不出来就少一行。
    }

    try {
      const subagents = serviceOf(ctx, 'subagents')
      // 宿主口径（@deepseek-ai/dsh-subagent 的 SubagentRuntime）：
      //   listChildren    → durable 直接子级目录 { id, createdAt, mode, label? }，没有 activity；
      //   listDescendants → 带 activity: 'running' | 'inactive' 的遍历结果（diagnostic 要跳过）。
      // 「运行中」只能来自后者；只有前者时退化成「本会话 N 个子代理」。
      // 有 listDescendants 就只读它一次（面板开着每 4 秒会取数，别多打一次目录查询）。
      if (typeof subagents?.listDescendants === 'function') {
        const rows = await subagents.listDescendants(session.id)
        if (Array.isArray(rows)) {
          const kids = rows.filter((row) => row !== null && typeof row === 'object' && row.kind === 'child')
          result.subagents = {
            total: kids.length,
            running: kids.filter((row) => row.activity === 'running').length,
          }
        }
      } else if (typeof subagents?.listChildren === 'function') {
        const children = await subagents.listChildren(session.id)
        if (Array.isArray(children)) result.subagents = { total: children.length, running: null }
      }
    } catch {
      // 子代理服务缺席就少一行。
    }
  }

  return result
}
