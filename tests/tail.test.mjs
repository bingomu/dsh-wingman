import test from 'node:test'
import assert from 'node:assert/strict'

import { linesFromEvents, runTail } from '../lib/tail.js'

function record(id, createdAt, cwd, origin) {
  return { header: { id, createdAt, cwd, origin }, live: false, persisted: true }
}

function event(role, text) {
  if (role === 'user') return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } }
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

function fakeCtx({ records = [], events = [], title = '旧会话', currentCwd = '/w', chunks = ['开场白'] } = {}) {
  return {
    get(name) {
      if (name === 'sessions') return { get: () => ({ header: { id: 'now', cwd: currentCwd }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }) }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => records,
          readSession: async () => ({ events }),
          readTitle: async () => ({ title }),
        }
      }
      if (name === 'llm') {
        return {
          async *stream() {
            for (const text of chunks) yield { type: 'text-delta', index: 0, text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      return undefined
    },
  }
}

test('挑同工作区、非当前、非子代理的最近会话', async () => {
  const records = [
    record('now', 300, '/w'),
    record('old', 100, '/w'),
    record('other', 200, '/other'),
    record('sub', 250, '/w', 'subagent'),
  ]
  const ctx = fakeCtx({ records, events: [event('user', '上次做到这里'), event('assistant', '好的')] })
  const result = await runTail(ctx, { sessionId: 'now' })
  assert.equal(result.previousSessionId, 'old')
  assert.equal(result.previousTitle, '旧会话')
  assert.equal(result.text, '开场白')
})

test('没有上一个会话时拒绝', async () => {
  const ctx = fakeCtx({ records: [record('now', 300, '/w')] })
  await assert.rejects(() => runTail(ctx, { sessionId: 'now' }), (error) => error.code === 'no_previous')
})

test('上一个会话没有文字时拒绝', async () => {
  const ctx = fakeCtx({ records: [record('now', 300, '/w'), record('old', 100, '/w')], events: [] })
  await assert.rejects(() => runTail(ctx, { sessionId: 'now' }), (error) => error.code === 'empty_previous')
})

test('事件转文字只保留用户与助手', () => {
  const lines = linesFromEvents([
    event('user', '甲'),
    { type: 'tool/result', data: {} },
    event('assistant', '乙'),
  ])
  assert.deepEqual(lines, ['用户: 甲', '助手: 乙'])
})
