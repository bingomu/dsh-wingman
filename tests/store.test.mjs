import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SnippetsStore, MAX_ITEMS } from '../lib/store.js'

async function fresh() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wingman-'))
  return { home, store: new SnippetsStore({ home }) }
}

test('首次启动写入三条示例片段，并且真的落盘', async () => {
  const { home, store } = await fresh()
  try {
    const snapshot = await store.ready()
    assert.equal(snapshot.items.length, 3)
    assert.ok(snapshot.items.some((item) => item.title.includes('插件发布自检')))
    const raw = JSON.parse(await readFile(join(home, 'wingman', 'snippets.json'), 'utf8'))
    assert.equal(raw.items.length, 3)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('保存会清洗坏条目：空条目丢弃、标题截断、uses 归一', async () => {
  const { home, store } = await fresh()
  try {
    await store.ready()
    const saved = await store.save([
      { title: 'ok', body: 'hello', uses: 3.7 },
      { title: '', body: '' },
      null,
      { title: 'x'.repeat(200), body: 'y'.repeat(9000) },
      { title: 'dup', body: 'a', id: 'same' },
      { title: 'dup2', body: 'b', id: 'same' },
    ])
    assert.equal(saved.items.length, 4)
    assert.equal(saved.items[0].uses, 3)
    assert.equal(saved.items[1].title.length, 120)
    assert.equal(saved.items[1].body.length, 8000)
    assert.notEqual(saved.items[2].id, saved.items[3].id)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('markUsed 只加计数，未知 id 不动数据', async () => {
  const { home, store } = await fresh()
  try {
    const initial = await store.ready()
    const target = initial.items[0]
    const before = target.uses
    const after = await store.markUsed(target.id)
    assert.equal(after.items.find((item) => item.id === target.id).uses, before + 1)
    const untouched = await store.markUsed('s-not-there')
    assert.equal(untouched.items.length, initial.items.length)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('超过上限时截断到 MAX_ITEMS', async () => {
  const { home, store } = await fresh()
  try {
    await store.ready()
    const many = Array.from({ length: MAX_ITEMS + 25 }, (_, index) => ({ title: `t${index}`, body: 'b' }))
    const saved = await store.save(many)
    assert.equal(saved.items.length, MAX_ITEMS)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('旧目录 swiss/ 的数据会自动搬到 wingman/', async () => {
  const { home } = await fresh()
  try {
    const legacyDir = join(home, 'swiss')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, 'snippets.json'), JSON.stringify({ items: [{ title: '老指令', body: '旧数据' }] }))
    const store = new SnippetsStore({ home })
    const snapshot = await store.ready()
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.items[0].title, '老指令')
    const migrated = JSON.parse(await readFile(join(home, 'wingman', 'snippets.json'), 'utf8'))
    assert.equal(migrated.items[0].title, '老指令')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('reset 会把内容还原成三条示例', async () => {
  const { home, store } = await fresh()
  try {
    await store.ready()
    await store.save([{ title: '只剩一条', body: 'x' }])
    const reset = await store.reset()
    assert.equal(reset.items.length, 3)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('坏 JSON 不会静默覆盖：读取抛错，文件保持原样', async () => {
  const { home, store } = await fresh()
  try {
    await store.ready()
    await writeFile(join(home, 'wingman', 'snippets.json'), '{ not json', 'utf8')
    const broken = new SnippetsStore({ home })
    await assert.rejects(() => broken.ready())
    assert.equal(await readFile(join(home, 'wingman', 'snippets.json'), 'utf8'), '{ not json')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
