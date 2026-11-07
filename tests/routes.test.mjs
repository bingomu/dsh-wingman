import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerRoutes } from '../lib/routes.js'
import { SnippetsStore } from '../lib/store.js'
import { CustomStore } from '../lib/custom.js'
import { ReminderStore } from '../lib/reminders.js'

/** 用真实的 handler + 假的 req/res，验证「前端按钮对应的接口真的存在」。 */
function harness() {
  let handler = null
  const webCtx = {
    get(name) {
      if (name === 'webServer') return { register: (options) => { handler = options.handler; return () => {} } }
      return undefined
    },
  }
  return {
    webCtx,
    get handler() { return handler },
  }
}

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function call(handler, method, url, body) {
  const res = {
    status: 0,
    text: null,
    writeHead(status) { this.status = status },
    end(text) { this.text = text },
  }
  handler(makeReq(method, url, body), res)
  for (let index = 0; index < 60 && res.text === null; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { status: res.status, json: res.text === null ? null : JSON.parse(res.text) }
}

async function setup(run) {
  const home = await mkdtemp(join(tmpdir(), 'wingman-routes-'))
  try {
    const h = harness()
    registerRoutes(h.webCtx, {
      store: new SnippetsStore({ home }),
      custom: new CustomStore({ home }),
      reminders: new ReminderStore({ home }),
    })
    assert.ok(h.handler !== null, '路由没有注册')
    await run(h)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test('POST /snippets op=reset 还原成三条示例', async () => {
  await setup(async (h) => {
    const save = await call(h.handler, 'POST', '/dsh-wingman/api/snippets', {
      op: 'save',
      items: [{ title: '只剩一条', body: 'x' }],
    })
    assert.equal(save.json.value.items.length, 1)

    const reset = await call(h.handler, 'POST', '/dsh-wingman/api/snippets', { op: 'reset' })
    assert.equal(reset.status, 200)
    assert.equal(reset.json.ok, true)
    assert.equal(reset.json.value.items.length, 3)
  })
})

test('未知 op 返回 400，不会静默成功', async () => {
  await setup(async (h) => {
    const response = await call(h.handler, 'POST', '/dsh-wingman/api/snippets', { op: 'nope' })
    assert.equal(response.status, 400)
    assert.equal(response.json.error.code, 'unknown_op')
  })
})
