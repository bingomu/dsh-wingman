import test from 'node:test'
import assert from 'node:assert/strict'

import { runTransform } from '../lib/transform.js'

function session(provider, model) {
  return { requestHeader: () => ({ config: { provider, model } }) }
}

function streamingCtx({ chunks = [], finish = { kind: 'stop' }, route, defaultRoute, llm = true } = {}) {
  const map = {}
  if (route !== undefined) map.sessions = { get: () => session(route.provider, route.model) }
  if (defaultRoute !== undefined) map.agentDefaultModel = { currentSelection: () => defaultRoute }
  map.llm = llm
    ? {
      async *stream() {
        for (const chunk of chunks) yield chunk
        if (finish !== undefined) yield { type: 'finish', reason: finish }
      },
    }
    : undefined
  return { get: (name) => map[name] }
}

const textChunk = (text) => ({ type: 'text-delta', index: 0, text })

test('用会话路由调模型，拼出文本', async () => {
  const ctx = streamingCtx({ route: { provider: 'deepseek', model: 'v4' }, chunks: [textChunk('改写'), textChunk('结果')] })
  const result = await runTransform(ctx, { sessionId: 's-1', action: 'prompt', text: '一段原文' })
  assert.equal(result.text, '改写结果')
  assert.equal(result.provider, 'deepseek')
  assert.equal(result.model, 'v4')
})

test('没有会话路由时退到默认模型', async () => {
  const ctx = streamingCtx({ defaultRoute: { provider: 'openai', model: 'gpt' }, chunks: [textChunk('ok')] })
  const result = await runTransform(ctx, { action: 'summary', text: 'x' })
  assert.equal(result.provider, 'openai')
  assert.equal(result.text, 'ok')
})

test('新增的 explain / tests / translateEn 动作可用', async () => {
  for (const action of ['explain', 'tests', 'translateEn']) {
    const ctx = streamingCtx({ route: { provider: 'deepseek', model: 'v4' }, chunks: [textChunk('ok')] })
    const result = await runTransform(ctx, { sessionId: 's-1', action, text: '一段原文' })
    assert.equal(result.text, 'ok')
  }
})

test('没有 llm 服务时报 no_llm', async () => {
  const ctx = streamingCtx({ route: { provider: 'p', model: 'm' }, llm: false })
  await assert.rejects(() => runTransform(ctx, { action: 'translate', text: 'x' }), (error) => error.code === 'no_llm')
})

test('finish 为 error 时抛 model_failed', async () => {
  const ctx = streamingCtx({
    route: { provider: 'p', model: 'm' },
    chunks: [textChunk('半截')],
    finish: { kind: 'error', failure: { message: 'quota', code: 'x' } },
  })
  await assert.rejects(() => runTransform(ctx, { sessionId: 's-1', action: 'prompt', text: 'x' }), (error) => error.code === 'model_failed')
})

test('空输入与未知动作直接拒绝', async () => {
  const ctx = streamingCtx({ route: { provider: 'p', model: 'm' } })
  await assert.rejects(() => runTransform(ctx, { action: 'prompt', text: '   ' }), (error) => error.code === 'empty_text')
  await assert.rejects(() => runTransform(ctx, { action: 'nope', text: 'x' }), (error) => error.code === 'unknown_action')
})

test('模型返回空白时抛 empty_reply', async () => {
  const ctx = streamingCtx({ route: { provider: 'p', model: 'm' }, chunks: [textChunk('   ')] })
  await assert.rejects(() => runTransform(ctx, { sessionId: 's-1', action: 'prompt', text: 'x' }), (error) => error.code === 'empty_reply')
})
