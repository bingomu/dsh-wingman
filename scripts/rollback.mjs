#!/usr/bin/env node
/**
 * 回滚 client.js 到最近一份备份；`--list` 只列不还原。
 *
 * 用法：
 *   node scripts/rollback.mjs          # 还原最近一份
 *   node scripts/rollback.mjs --list   # 看有哪些备份
 */

import { copyFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const backupDir = join(root, 'backup')
// 同样按修改时间排：字典序会把 0.32.x 排到 0.9.x 前面，回滚到错误的版本。
const names = (await readdir(backupDir)).filter((name) => name.endsWith('.js'))
const stamped = await Promise.all(names.map(async (name) => ({
  name,
  mtime: (await stat(join(backupDir, name))).mtimeMs,
})))
stamped.sort((a, b) => a.mtime - b.mtime) // 旧的在前
const files = stamped.map((item) => item.name)

if (files.length === 0) {
  console.log('还没有备份。先跑 node scripts/snapshot.mjs。')
  process.exit(0)
}

if (process.argv.includes('--list')) {
  console.log(`共 ${files.length} 份备份（旧的在前）：`)
  for (const name of files) console.log(`  ${name}`)
  process.exit(0)
}

const latest = files[files.length - 1]
await copyFile(join(backupDir, latest), join(root, 'client.js'))
console.log(`已回滚到 ${latest}。刷新页面即可生效（若改了 host 侧，需重启）。`)
