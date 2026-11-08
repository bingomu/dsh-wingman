import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectWatch } from '../lib/watch.js'

function fakeCtx({ session, measurement, children, descendants } = {}) {
  const map = {}
  if (session !== undefined) map.sessions = { get: () => session }
  if (measurement !== undefined) map.tokenMeter = { measure: () => measurement }
  if (children !== undefined || descendants !== undefined) {
    map.subagents = {
      ...(children === undefined ? {} : { listChildren: async () => children }),
      ...(descendants === undefined ? {} : { listDescendants: async () => descendants }),
    }
  }
  return { get: (name) => map[name] }
}

const session = {
  id: 's-1',
  requestContext: () => ({ provider: 'deepseek', model: 'deepseek-v4', contextWindow: 100000 }),
}

const measurement = {
  totalTokens: 62000,
  surfaceTokens: 4000,
  baseline: { kind: 'usage', tokens: 1, usage: { inputTokens: 50000, outputTokens: 12000, cacheReadTokens: 9000 } },
}

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wingman-watch-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('全部服务在场时，四项数据都取到', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, 'followup'), { recursive: true })
    await writeFile(join(home, 'followup', 'tasks.json'), JSON.stringify({
      tasks: [{ done: true }, { done: false }, { title: 'x' }],
    }))

    const result = await collectWatch(fakeCtx({
      session,
      measurement,
      descendants: [
        { kind: 'child', id: 'c-1', mode: 'one-shot', activity: 'running' },
        { kind: 'child', id: 'c-2', mode: 'external', activity: 'inactive' },
        { kind: 'child', id: 'c-3', mode: 'one-shot', activity: 'inactive' },
        { kind: 'diagnostic', id: 'c-4', reason: 'unsupported' },
      ],
    }), 's-1')
    assert.equal(result.model.model, 'deepseek-v4')
    assert.equal(result.model.contextWindow, 100000)
    assert.equal(result.tokens.total, 62000)
    assert.equal(result.tokens.input, 50000)
    assert.equal(result.tokens.cacheRead, 9000)
    assert.equal(result.subagents.total, 3)
    assert.equal(result.subagents.running, 1)
    assert.equal(result.followups.open, 2)
  })
})

test('子代理：只有 listChildren（旧宿主）时 total 有值、running 为 null，不谎报运行中', async () => {
  await withHome(async () => {
    const result = await collectWatch(fakeCtx({ session, children: [{ id: 'c-1' }, { id: 'c-2' }] }), 's-1')
    assert.equal(result.subagents.total, 2)
    assert.equal(result.subagents.running, null)
  })
})

test('子代理：listDescendants 里没有 running 时 running 为 0（跑完要归零）', async () => {
  await withHome(async () => {
    const result = await collectWatch(fakeCtx({
      session,
      descendants: [
        { kind: 'child', id: 'c-1', mode: 'one-shot', activity: 'inactive' },
        { kind: 'diagnostic', id: 'c-2', reason: 'corrupt' },
      ],
    }), 's-1')
    assert.equal(result.subagents.total, 1)
    assert.equal(result.subagents.running, 0)
  })
})

test('没有会话时只少行，不抛错', async () => {
  await withHome(async () => {
    const result = await collectWatch(fakeCtx({}), 'missing')
    assert.equal(result.tokens, null)
    assert.equal(result.model, null)
    assert.equal(result.subagents, null)
    assert.equal(result.followups, null)
  })
})

test('服务抛错时被吞掉，其余照常', async () => {
  await withHome(async () => {
    const ctx = {
      get(name) {
        if (name === 'sessions') return { get: () => { throw new Error('boom') } }
        if (name === 'tokenMeter') return { measure: () => { throw new Error('boom') } }
        if (name === 'subagents') return { listChildren: async () => { throw new Error('boom') } }
        return undefined
      },
    }
    const result = await collectWatch(ctx, 's-1')
    assert.equal(result.tokens, null)
    assert.equal(result.subagents, null)
    assert.equal(result.model, null)
  })
})

test('跟进文件坏掉时返回 null，不影响其它项', async () => {
  await withHome(async (home) => {
    await mkdir(join(home, 'followup'), { recursive: true })
    await writeFile(join(home, 'followup', 'tasks.json'), '{ broken')
    const result = await collectWatch(fakeCtx({ session, measurement }), 's-1')
    assert.equal(result.followups, null)
    assert.equal(result.tokens.total, 62000)
  })
})
