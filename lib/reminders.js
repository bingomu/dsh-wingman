/**
 * 定时提醒：本机 JSON，独立的文件。
 *
 * 只存「什么时候、提醒什么、完成没有」，不接系统通知，由前端轮询触发工具条提示。
 *
 * @module dsh-wingman/lib/reminders
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { dshHome } from './store.js'

const MAX_ITEMS = 200
const MAX_TEXT = 200
/** 已完成的提醒保留多久（毫秒）。 */
const KEEP_DONE_MS = 7 * 86400000

function newId() {
  return `r-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
}

function cleanItem(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_TEXT) : ''
  const dueAt = Number(raw.dueAt)
  if (text === '' || !Number.isFinite(dueAt)) return null
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId(),
    text,
    dueAt,
    done: raw.done === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
}

export class ReminderStore {
  constructor(options = {}) {
    const home = typeof options.home === 'string' && options.home !== '' ? options.home : dshHome()
    this.dir = join(home, 'wingman')
    this.file = join(this.dir, 'reminders.json')
    this.value = null
    this.queue = Promise.resolve()
  }

  async ready() {
    if (this.value === null) await this.load()
    return this.value
  }

  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      const items = Array.isArray(parsed?.items) ? parsed.items.map(cleanItem).filter((item) => item !== null) : []
      this.value = { version: 1, items }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        this.value = { version: 1, items: [] }
      } else {
        throw error
      }
    }
    return this.value
  }

  snapshot() {
    const now = Date.now()
    const items = (this.value === null ? [] : this.value.items)
      .filter((item) => item.done !== true || now - item.createdAt < KEEP_DONE_MS)
      .sort((left, right) => left.dueAt - right.dueAt)
      .map((item) => ({ ...item }))
    return { version: 1, items, now }
  }

  async add({ text, dueAt }) {
    await this.ready()
    const item = cleanItem({ text, dueAt })
    if (item === null) throw Object.assign(new Error('提醒内容和时间都不能为空'), { code: 'invalid_input' })
    const items = [...this.value.items, item].slice(-MAX_ITEMS)
    this.value = { version: 1, items }
    await this.persist()
    return this.snapshot()
  }

  async update(id, patch) {
    await this.ready()
    const items = this.value.items.map((item) => (item.id === id ? { ...item, ...patch } : item))
    this.value = { version: 1, items }
    await this.persist()
    return this.snapshot()
  }

  async remove(id) {
    await this.ready()
    this.value = { version: 1, items: this.value.items.filter((item) => item.id !== id) }
    await this.persist()
    return this.snapshot()
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
