/**
 * Wingman · 宿主半
 *
 * 一块本机 JSON（片段）+ 一条 HTTP 路由。没有设置、没有数据库。
 * 渲染全在浏览器半侧（client.js）：shell.overlay 挂细条，input.dock 挂输入桥。
 *
 * @module dsh-wingman
 */

import { SnippetsStore } from './lib/store.js'
import { registerRoutes } from './lib/routes.js'
import { CustomStore } from './lib/custom.js'
import { ReminderStore } from './lib/reminders.js'

export const name = 'dsh-wingman'

/**
 * 挂载宿主半。
 * @param {*} ctx cordis 插件上下文
 */
export function apply(ctx) {
  const store = new SnippetsStore()
  const custom = new CustomStore()
  const reminders = new ReminderStore()

  // 启动就先读一次：坏文件尽早暴露成一条警告，而不是等第一次点开面板。
  store.ready().catch((error) => {
    console.warn(`[dsh-wingman] 片段加载失败（${store.file}）：`, error)
  })

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        const dispose = registerRoutes(webCtx, { store, custom, reminders })
        webCtx.effect(() => dispose, 'dsh-wingman: routes')
      })
    } else {
      const dispose = registerRoutes(ctx, { store, custom, reminders })
      ctx.effect(() => dispose, 'dsh-wingman: routes')
    }
  } catch (error) {
    console.warn('[dsh-wingman] 路由注册失败：', error)
  }
}
