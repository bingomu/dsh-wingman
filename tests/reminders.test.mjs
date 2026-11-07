import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ReminderStore } from '../lib/reminders.js'

async function fresh() {
  const home = await mkdtemp(join(tmpdir(), 'wingman-rem-'))
  return { home, store: new ReminderStore({ home }) }
}

test('新增并按时间排序；完成的还能读回来', async () => {
  const { home, store } = await fresh()
  try {
    await store.ready()
    const later = Date.now() + 3600000
    await store.add({ text: '晚一点', dueAt: later })
    const snapshot = await store.add({ text: '马上', dueAt: Date.now() + 1000 })
    assert.equal(snapshot.items.length, 2)
    assert.equal(snapshot.items[0].text, '马上')

    const id = snapshot.items[0].id
    const done = await store.update(id, { done: true })
    assert.equal(done.items.find((item) => item.id === id).done, true)

    const removed = await store.remove(id)
    assert.equal(removed.items.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('缺内容或时间时拒绝', async () => {
  const { home, store } = await fresh()
  try {
    await store.ready()
    await assert.rejects(() => store.add({ text: '', dueAt: Date.now() }), (error) => error.code === 'invalid_input')
    await assert.rejects(() => store.add({ text: 'x', dueAt: Number.NaN }), (error) => error.code === 'invalid_input')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('落盘后重新读得到', async () => {
  const { home, store } = await fresh()
  try {
    await store.ready()
    await store.add({ text: '喝水', dueAt: Date.now() + 60000 })
    const again = new ReminderStore({ home })
    const snapshot = await again.ready()
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.items[0].text, '喝水')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
