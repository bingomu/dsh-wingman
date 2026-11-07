/**
 * Wingman · 片段存储。
 *
 * 一个 JSON 文件，读一次、写整份、原子替换。数据在 `DSH_HOME/wingman/snippets.json`，
 * 删掉文件就等于清空（下次启动会重新写入三条示例片段）。
 *
 * @module dsh-wingman/lib/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 片段总量上限。 */
export const MAX_ITEMS = 200
/** 标题最长字数。 */
export const MAX_TITLE = 120
/** 正文最长字数。 */
export const MAX_BODY = 8000
/** 分组名最长字数。 */
export const MAX_GROUP = 40

/** DSH 主目录：DSH_HOME 优先，否则 ~/.dsh。和便签墙同一套约定。 */
export function dshHome() {
  const override = process.env.DSH_HOME
  return resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
}

/**
 * 读数据文件；新目录没有就从旧目录（swiss）复制过来并落盘。
 * 迁移只复制、不删除，旧目录保留着当备份。
 */
export async function readMigrated(dir, legacyDir, fileName) {
  try {
    return await readFile(join(dir, fileName), 'utf8')
  } catch (error) {
    if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') throw error
    try {
      const legacy = await readFile(join(legacyDir, fileName), 'utf8')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, fileName), legacy, 'utf8')
      return legacy
    } catch {
      return null
    }
  }
}

/** 新片段 id。 */
function newId() {
  return `s-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
}

/** 首次启动的三条示例片段：删掉即可，用来演示「点一下插进输入框」。 */
function seeds() {
  const now = Date.now()
  return [
    {
      id: newId(),
      title: '插件发布自检',
      group: '发布',
      body: '发布前按顺序检查：\n1. npm run check / test 全绿\n2. README、CHANGELOG、版本号一致\n3. 打包内容只含 files 里声明的文件\n4. tarball 装到干净 profile 里试一次\n5. 最后再跑一次安全重启脚本',
      pinned: false,
      uses: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: newId(),
      title: '写一个 DSH 插件的骨架',
      group: '开发',
      body: '照 cordis-plugin-development 的流程给我搭一个 DSH 插件：先确认要占哪个 slot、拿到它的 props，再写 package.json / cordis.patch.yml / index.js / client.js，最后本地装上验证。',
      pinned: false,
      uses: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: newId(),
      title: '重启前先查 Cookie 堆积',
      group: '运维',
      body: '重启 DSH 前先跑 node scripts/dsh-auth-guard.mjs status；不是 OK 就走 bash scripts/dsh-safe-restart.sh，不要直接 Cmd+Q。',
      pinned: true,
      uses: 0,
      createdAt: now,
      updatedAt: now,
    },
  ]
}

/** 把磁盘上的任意值洗成合法片段；坏条目丢弃，重复 id 重发。 */
function cleanItems(value) {
  const used = new Set()
  const items = []
  for (const entry of Array.isArray(value) ? value : []) {
    if (entry === null || typeof entry !== 'object') continue
    const body = typeof entry.body === 'string' ? entry.body : ''
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    if (title === '' && body.trim() === '') continue
    let id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : newId()
    if (used.has(id)) id = newId()
    used.add(id)
    const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now()
    items.push({
      id,
      title: (title === '' ? body.trim().split('\n')[0] : title).slice(0, MAX_TITLE),
      group: typeof entry.group === 'string' ? entry.group.trim().slice(0, MAX_GROUP) : '',
      body: body.slice(0, MAX_BODY),
      pinned: entry.pinned === true,
      uses: Number.isFinite(entry.uses) && entry.uses > 0 ? Math.floor(entry.uses) : 0,
      createdAt,
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : createdAt,
    })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

/**
 * 片段的本地存储：懒加载、串行写入、原子替换。
 */
export class SnippetsStore {
  constructor(options = {}) {
    const home = typeof options.home === 'string' && options.home !== '' ? options.home : dshHome()
    this.dir = join(home, 'wingman')
    this.legacyDir = join(home, 'swiss')
    this.file = join(this.dir, 'snippets.json')
    this.value = null
    this.queue = Promise.resolve()
  }

  /** 确保已装载。 */
  async ready() {
    if (this.value === null) await this.load()
    return this.value
  }

  async load() {
    const text = await readMigrated(this.dir, this.legacyDir, 'snippets.json')
    if (text === null) {
      // 第一次启动：写入示例片段，让「点一下插入」可以直接试。
      this.value = { version: 1, items: cleanItems(seeds()), loadedAt: Date.now() }
      await this.persist()
      return this.value
    }
    const parsed = JSON.parse(text)
    const items = cleanItems(parsed !== null && typeof parsed === 'object' ? parsed.items : [])
    this.value = { version: 1, items, loadedAt: Date.now() }
    return this.value
  }

  /** 当前快照（深拷贝，防止调用方改到内存态）。 */
  snapshot() {
    const items = (this.value === null ? [] : this.value.items).map((item) => ({ ...item }))
    return { version: 1, items, now: Date.now() }
  }

  /** 整份替换。 */
  async save(items) {
    const cleaned = cleanItems(items)
    this.value = { version: 1, items: cleaned, loadedAt: Date.now() }
    await this.persist()
    return this.snapshot()
  }

  /** 还原为初始的三条示例（整份替换）。 */
  async reset() {
    this.value = { version: 1, items: cleanItems(seeds()), loadedAt: Date.now() }
    await this.persist()
    return this.snapshot()
  }

  /** 记一次使用：只动 uses 与 updatedAt。 */
  async markUsed(id) {
    const current = await this.ready()
    const target = current.items.find((item) => item.id === id)
    if (target === undefined) return this.snapshot()
    target.uses += 1
    await this.persist()
    return this.snapshot()
  }

  /** 串行写盘：临时文件 + rename，写坏也不会毁掉旧文件。 */
  persist() {
    const next = () => this.writeOnce()
    this.queue = this.queue.then(next, next)
    return this.queue
  }

  async writeOnce() {
    const body = JSON.stringify({ version: 1, items: this.value === null ? [] : this.value.items }, null, 2)
    await mkdir(this.dir, { recursive: true })
    const temporary = `${this.file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
    await writeFile(temporary, body, 'utf8')
    await rename(temporary, this.file)
  }
}
