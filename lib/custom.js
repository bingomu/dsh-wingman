/**
 * 自定义入口的存储：本机 JSON，一个文件，读一次写整份。
 *
 * @module dsh-wingman/lib/custom
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { dshHome, readMigrated } from './store.js'

export const MAX_ITEMS = 30
export const MAX_NAME = 40
export const MAX_TARGET = 500

function newId() {
  return `c-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
}

/** 洗一条入口；不合法的丢掉。 */
export function cleanItem(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const kind = raw.kind === 'run' ? 'run' : raw.kind === 'open' ? 'open' : null
  if (kind === null) return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : ''
  const target = typeof raw.target === 'string' ? raw.target.trim().slice(0, MAX_TARGET) : ''
  if (name === '' || target === '') return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId(),
    name,
    kind,
    target,
    cwd: typeof raw.cwd === 'string' ? raw.cwd.trim().slice(0, MAX_TARGET) : '',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
}

export class CustomStore {
  constructor(options = {}) {
    const home = typeof options.home === 'string' && options.home !== '' ? options.home : dshHome()
    this.dir = join(home, 'wingman')
    this.legacyDir = join(home, 'swiss')
    this.file = join(this.dir, 'custom.json')
    this.value = null
    this.queue = Promise.resolve()
  }

  async ready() {
    if (this.value === null) await this.load()
    return this.value
  }

  async load() {
    const text = await readMigrated(this.dir, this.legacyDir, 'custom.json')
    if (text === null) {
      this.value = { version: 1, items: [] }
      return this.value
    }
    const parsed = JSON.parse(text)
    const items = Array.isArray(parsed?.items) ? parsed.items.map(cleanItem).filter((item) => item !== null).slice(0, MAX_ITEMS) : []
    this.value = { version: 1, items }
    return this.value
  }

  snapshot() {
    const items = (this.value === null ? [] : this.value.items).map((item) => ({ ...item }))
    return { version: 1, items, now: Date.now() }
  }

  async save(items) {
    const cleaned = (Array.isArray(items) ? items : []).map(cleanItem).filter((item) => item !== null).slice(0, MAX_ITEMS)
    this.value = { version: 1, items: cleaned }
    await this.persist()
    return this.snapshot()
  }

  async find(id) {
    await this.ready()
    return this.value.items.find((item) => item.id === id)
  }

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
