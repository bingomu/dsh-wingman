#!/usr/bin/env node
/**
 * 备份当前 client.js 到 backup/，用于出问题后 30 秒回滚。
 * 只保留最近 20 份。
 *
 * 用法：node scripts/snapshot.mjs
 */

import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const backupDir = join(root, 'backup')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const target = join(backupDir, `client-${pkg.version}-${stamp}.js`)

await mkdir(backupDir, { recursive: true })
await copyFile(join(root, 'client.js'), target)

// 按「修改时间」保留最近 20 份。早先按文件名字典序排，0.32.x 会被判成比 0.9.x 旧，
// 新快照刚写出来就被自己删掉——查版本号指望不上，只能看时间。
const names = (await readdir(backupDir)).filter((name) => name.endsWith('.js'))
const stamped = await Promise.all(names.map(async (name) => ({
  name,
  mtime: (await stat(join(backupDir, name))).mtimeMs,
})))
stamped.sort((a, b) => b.mtime - a.mtime)
for (const stale of stamped.slice(20)) {
  await rm(join(backupDir, stale.name), { force: true })
}

console.log(`已备份 → backup/${basename(target)}`)
