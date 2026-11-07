/**
 * 执行一条自定义入口。
 *
 * 只支持两种动作：
 *   - open：用系统默认方式打开一个路径（macOS 走 `open`）
 *   - run：在工作目录里跑一条命令（20 秒超时、输出截断）
 *
 * 只在本机执行，不做网络转发；命令是用户自己写的，面板里也会提示。
 *
 * @module dsh-wingman/lib/run
 */

import { execFile } from 'node:child_process'

const TIMEOUT_MS = 20000
const MAX_OUTPUT = 20000

/** 跑一条命令并收集输出。 */
function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
      ...options,
    }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
      const clipped = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n…（输出已截断）` : output
      if (error !== null && error !== undefined) {
        const reason = error.killed === true ? '超时被中止' : error.message
        resolve({ ok: false, output: clipped === '' ? reason : `${clipped}\n\n（${reason}）` })
        return
      }
      resolve({ ok: true, output: clipped === '' ? '（没有输出）' : clipped })
    })
  })
}

/**
 * 执行入口。
 * @param {{ kind: 'open' | 'run', target: string, cwd?: string }} entry
 */
export async function runEntry(entry) {
  if (entry === null || entry === undefined) throw Object.assign(new Error('入口不存在'), { code: 'not_found' })
  const target = typeof entry.target === 'string' ? entry.target.trim() : ''
  if (target === '') throw Object.assign(new Error('入口没有目标'), { code: 'empty_target' })

  if (entry.kind === 'open') {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    const result = await exec(command, [target])
    return { ...result, output: result.ok ? `已打开：${target}` : result.output }
  }

  if (entry.kind === 'run') {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh'
    const args = process.platform === 'win32' ? ['-NoProfile', '-Command', target] : ['-lc', target]
    const cwd = typeof entry.cwd === 'string' && entry.cwd.trim() !== '' ? entry.cwd.trim() : undefined
    return exec(shell, args, cwd === undefined ? {} : { cwd })
  }

  throw Object.assign(new Error('未知的入口类型'), { code: 'unknown_kind' })
}
