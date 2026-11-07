import test from 'node:test'
import assert from 'node:assert/strict'

import { runRecap, transcriptOf } from '../lib/recap.js'

function message(role, text) {
  return { role, content: [{ type: 'text', text }] }
}

function fakeCtx({ messages = [], chunks = ['【结论】\n- a'], finish = { kind: 'stop' }, session = true } = {}) {
  const ctxSession = {
    deriveMessages: () => messages,
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
  }
  return {
    get(name) {
      if (name === 'sessions') return { get: () => (session ? ctxSession : undefined) }
      if (name === 'llm') {
        return {
          async *stream() {
            for (const text of chunks) yield { type: 'text-delta', index: 0, text }
            yield { type: 'finish', reason: finish }
          },
        }
      }
      return undefined
    },
  }
}

test('正常复盘：拼出对话并返回模型文本', async () => {
  const ctx = fakeCtx({ messages: [message('user', '做第五颗便签'), message('assistant', '好的')] })
  const result = await runRecap(ctx, { sessionId: 's-1' })
  assert.equal(result.text, '【结论】\n- a')
  assert.equal(result.provider, 'deepseek')
})

test('没有会话 / 没有内容时拒绝', async () => {
  await assert.rejects(() => runRecap(fakeCtx({}), { sessionId: '' }), (error) => error.code === 'no_session')
  await assert.rejects(() => runRecap(fakeCtx({ session: false }), { sessionId: 's-1' }), (error) => error.code === 'no_session')
  await assert.rejects(() => runRecap(fakeCtx({ messages: [] }), { sessionId: 's-1' }), (error) => error.code === 'empty_conversation')
})

test('只取最后若干条，且截断到上限', () => {
  const many = Array.from({ length: 40 }, (_, index) => message('user', `第${index}条`))
  const transcript = transcriptOf({ deriveMessages: () => many })
  assert.ok(transcript.includes('第39条'))
  assert.ok(!transcript.includes('第0条'))
  assert.ok(transcript.length <= 9000)
})
