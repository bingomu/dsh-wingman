/**
 * 浏览器半侧用的 HTTP 路由。
 *
 *   GET  /dsh-wingman/api/snippets    整份片段
 *   POST /dsh-wingman/api/snippets    单入口：{ op: 'save' | 'use' | 'list', ... }
 *
 * 同源 JSON，没有 SSE——本地单人使用，每次操作后拿回整份，客户端不做增量合并。
 *
 * @module dsh-wingman/lib/routes
 */

import { collectWatch } from './watch.js'
import { runTransform } from './transform.js'
import { runRecap } from './recap.js'
import { runTail } from './tail.js'
import { runEntry } from './run.js'

const ROUTE_PREFIX = '/dsh-wingman/api'
const MAX_BODY = 512 * 1024

/** 发 JSON。 */
function send(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** 成功信封。 */
function ok(res, value) {
  send(res, 200, { ok: true, value })
}

/** 失败信封。 */
function fail(res, status, code, message) {
  send(res, status, { ok: false, error: { code, message } })
}

/** 读 JSON 请求体（有上限）。 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { code: 'too_large' })
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    const value = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('body must be an object')
    }
    return value
  } catch (error) {
    throw Object.assign(new Error(`invalid JSON body: ${error.message}`), { code: 'invalid_json' })
  }
}

/** 同源判定：没有 Origin 的本机请求放行；带 Origin 的交给宿主连接层。 */
function rejectionOf(ctx, req) {
  if (req.headers.origin === undefined) return undefined
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
  if (connection !== null && connection !== undefined && typeof connection.requestRejection === 'function') {
    try {
      return connection.requestRejection(req)
    } catch {
      return 'error'
    }
  }
  return undefined
}

/**
 * 注册路由。
 * @param {{ get?: (name: string) => unknown, effect?: (fn: () => unknown) => unknown }} webCtx 带 webServer 的上下文
 * @param {{ store: import('./store.js').SnippetsStore }} deps
 * @returns {() => void} disposer
 */
export function registerRoutes(webCtx, deps) {
  const { store, custom, reminders } = deps

  const handler = async (req, res) => {
    try {
      const rejected = rejectionOf(webCtx, req)
      if (rejected !== undefined) {
        fail(res, 403, 'forbidden', 'origin not allowed')
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname


      if (path === `${ROUTE_PREFIX}/reminders`) {
        if (reminders === undefined) {
          fail(res, 503, 'unavailable', 'reminders are unavailable')
          return
        }
        if (req.method === 'GET') {
          await reminders.ready()
          ok(res, reminders.snapshot())
          return
        }
        if (req.method !== 'POST') {
          fail(res, 405, 'method_not_allowed', `${req.method} not allowed`)
          return
        }
        const body = await readJson(req)
        const op = typeof body.op === 'string' ? body.op : 'list'
        if (op === 'add') {
          ok(res, await reminders.add({
            text: typeof body.text === 'string' ? body.text : '',
            dueAt: Number(body.dueAt),
          }))
          return
        }
        if (op === 'done') {
          ok(res, await reminders.update(String(body.id ?? ''), { done: true }))
          return
        }
        if (op === 'delete') {
          ok(res, await reminders.remove(String(body.id ?? '')))
          return
        }
        if (op === 'list') {
          await reminders.ready()
          ok(res, reminders.snapshot())
          return
        }
        fail(res, 400, 'unknown_op', `unknown op: ${op}`)
        return
      }


      if (path === `${ROUTE_PREFIX}/custom`) {
        if (custom === undefined) {
          fail(res, 503, 'unavailable', 'custom entries are unavailable')
          return
        }
        if (req.method === 'GET') {
          await custom.ready()
          ok(res, custom.snapshot())
          return
        }
        if (req.method !== 'POST') {
          fail(res, 405, 'method_not_allowed', `${req.method} not allowed`)
          return
        }
        const body = await readJson(req)
        const op = typeof body.op === 'string' ? body.op : 'list'
        if (op === 'save') {
          if (!Array.isArray(body.items)) {
            fail(res, 400, 'invalid_request', 'items must be an array')
            return
          }
          ok(res, await custom.save(body.items))
          return
        }
        if (op === 'delete') {
          if (typeof body.id !== 'string' || body.id === '') {
            fail(res, 400, 'invalid_request', 'id is required')
            return
          }
          await custom.ready()
          const items = custom.snapshot().items.filter((item) => item.id !== body.id)
          ok(res, await custom.save(items))
          return
        }
        fail(res, 400, 'unknown_op', `unknown op: ${op}`)
        return
      }

      if (path === `${ROUTE_PREFIX}/run`) {
        if (custom === undefined) {
          fail(res, 503, 'unavailable', 'custom entries are unavailable')
          return
        }
        if (req.method !== 'POST') {
          fail(res, 405, 'method_not_allowed', `${req.method} not allowed`)
          return
        }
        const body = await readJson(req)
        if (typeof body.id !== 'string' || body.id === '') {
          fail(res, 400, 'invalid_request', 'id is required')
          return
        }
        await custom.ready()
        const entry = await custom.find(body.id)
        ok(res, await runEntry(entry))
        return
      }

      if (path === `${ROUTE_PREFIX}/tail`) {
        if (req.method !== 'POST') {
          fail(res, 405, 'method_not_allowed', `${req.method} not allowed`)
          return
        }
        const body = await readJson(req)
        ok(res, await runTail(webCtx, {
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        }))
        return
      }

      if (path === `${ROUTE_PREFIX}/recap`) {
        if (req.method !== 'POST') {
          fail(res, 405, 'method_not_allowed', `${req.method} not allowed`)
          return
        }
        const body = await readJson(req)
        ok(res, await runRecap(webCtx, {
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        }))
        return
      }

      if (path === `${ROUTE_PREFIX}/transform`) {
        if (req.method !== 'POST') {
          fail(res, 405, 'method_not_allowed', `${req.method} not allowed`)
          return
        }
        const body = await readJson(req)
        ok(res, await runTransform(webCtx, {
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          action: typeof body.action === 'string' ? body.action : undefined,
          text: typeof body.text === 'string' ? body.text : undefined,
        }))
        return
      }

      if (path === `${ROUTE_PREFIX}/watch`) {
        if (req.method !== 'GET') {
          fail(res, 405, 'method_not_allowed', `${req.method} not allowed`)
          return
        }
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        ok(res, await collectWatch(webCtx, sessionId))
        return
      }

      if (path !== `${ROUTE_PREFIX}/snippets`) {
        fail(res, 404, 'not_found', `no route for ${path}`)
        return
      }

      await store.ready()

      if (req.method === 'GET') {
        ok(res, store.snapshot())
        return
      }

      if (req.method !== 'POST') {
        fail(res, 405, 'method_not_allowed', `${req.method} not allowed`)
        return
      }

      const body = await readJson(req)
      const op = typeof body.op === 'string' ? body.op : 'list'

      if (op === 'list') {
        ok(res, store.snapshot())
        return
      }
      if (op === 'save') {
        if (!Array.isArray(body.items)) {
          fail(res, 400, 'invalid_request', 'items must be an array')
          return
        }
        ok(res, await store.save(body.items))
        return
      }
      if (op === 'reset') {
        ok(res, await store.reset())
        return
      }
      if (op === 'use') {
        if (typeof body.id !== 'string' || body.id === '') {
          fail(res, 400, 'invalid_request', 'id is required')
          return
        }
        ok(res, await store.markUsed(body.id))
        return
      }

      fail(res, 400, 'unknown_op', `unknown op: ${op}`)
    } catch (error) {
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'internal'
      const status = code === 'too_large' ? 413 : code === 'invalid_json' ? 400 : 500
      fail(res, status, code, error instanceof Error ? error.message : String(error))
    }
  }

  const webServer = typeof webCtx?.get === 'function' ? webCtx.get('webServer') : undefined
  if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
    console.warn('[dsh-wingman] webServer 不可用，片段接口没有挂上')
    return () => {}
  }

  let dispose = () => {}
  try {
    dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        void handler(req, res)
      },
    })
  } catch (error) {
    console.warn('[dsh-wingman] 片段路由注册失败：', error)
    return () => {}
  }

  return () => {
    try {
      dispose()
    } catch {
      // 路由随插件一起卸载。
    }
  }
}
