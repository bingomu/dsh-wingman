import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanItem, CustomStore, MAX_ITEMS } from '../lib/custom.js'

test('清洗：缺名称/缺目标/未知类型都丢掉', () => {
  assert.equal(cleanItem(null), null)
  assert.equal(cleanItem({ kind: 'open', name: '', target: '/x' }), null)
  assert.equal(cleanItem({ kind: 'open', name: 'a', target: '   ' }), null)
  assert.equal(cleanItem({ kind: 'nope', name: 'a', target: '/x' }), null)
  const ok = cleanItem({ kind: 'run', name: ' 跑自检 ', target: 'npm run check', cwd: ' /w ' })
  assert.equal(ok.name, '跑自检')
  assert.equal(ok.kind, 'run')
  assert.equal(ok.cwd, '/w')
  assert.ok(ok.id.startsWith('c-'))
})

test('存整份、读回来、按 id 找', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wingman-custom-'))
  try {
    const store = new CustomStore({ home })
    await store.ready()
    const saved = await store.save([{ kind: 'open', name: '打开项目', target: '/Users/me/project' }])
    assert.equal(saved.items.length, 1)
    const found = await store.find(saved.items[0].id)
    assert.equal(found.name, '打开项目')

    const again = new CustomStore({ home })
    const reloaded = await again.ready()
    assert.equal(reloaded.items.length, 1)
    assert.equal(reloaded.items[0].target, '/Users/me/project')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('超过上限截断', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wingman-custom-'))
  try {
    const store = new CustomStore({ home })
    await store.ready()
    const many = Array.from({ length: MAX_ITEMS + 5 }, (_, index) => ({ kind: 'open', name: `n${index}`, target: '/x' }))
    const saved = await store.save(many)
    assert.equal(saved.items.length, MAX_ITEMS)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
