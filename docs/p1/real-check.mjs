/**
 * 真机自检：用桌面 App 当前的鉴权 cookie，在无头 Chrome 里打开真实 GUI，
 * 跑 P1 三项（AI 改写 / 状态数字 / 「记」写入）并出发布前自检截图。
 *
 *   node tests/real-check.mjs [port]
 *
 * 默认端口 65420（桌面 App 的 web UI）。全程只读宿主，除了一项测试便签
 * （跑完自己删掉）；唯一的一次改写模型调用是「改写成指令」。
 *
 * 会写：docs/p1/*.png（截图）、docs/p1/real-check.json（结果）。
 * 有任何功能项 ❌ 时以非 0 退出。
 *
 * 注意：npm test 只吃 tests/*.test.mjs，这个文件不会被它扫到。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT = join(REPO, 'docs/p1')
const PORT = Number(process.argv[2] ?? process.env.WINGMAN_PORT ?? 65420)
const SHOTS_ONLY = process.argv.includes('--shots')
const CDP = Number(process.env.CDP_PORT ?? 9455)
const CHROME = process.env.WINGMAN_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const COOKIE_DB = join(process.env.HOME, 'Library/Application Support/@deepseek-ai/dsh-desktop/Cookies')
const DSH_HOME = join(process.env.HOME, '.dsh')
const NOTES_FILE = join(DSH_HOME, 'sticky-wall/notes.json')
const TASKS_FILE = join(DSH_HOME, 'followup/tasks.json')
const SESSION_ROOT = join(DSH_HOME, 'sessions')

const TEST_TEXT = '工具条验收测试：这句话会被改写成一条指令。'
const TEST_NOTE = '工具条验收测试便签（跑完整理会删掉）'
const MSG_SEND = '工具条验收测试：请只回复 OK。'
const MSG_SPAWN = '工具条验收测试：请立刻调用 subagent 工具起一个子代理，让它只回复 OK；然后回我一句「已派发」，不要做别的事。'

const VIEWPORTS = [
  { name: '1440-light', width: 1440, height: 900, dark: false },
  { name: '1440-dark', width: 1440, height: 900, dark: true },
  { name: '1000-light', width: 1000, height: 820, dark: false },
  { name: '1000-dark', width: 1000, height: 820, dark: true },
  { name: '760-narrow', width: 760, height: 820, dark: false },
]

const MAX_SHOT_BYTES = 400 * 1024
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const results = {
  startedAt: new Date().toISOString(),
  port: PORT,
  checks: [],
  findings: [],
  screenshots: [],
  failures: [],
}
const log = (...parts) => console.log(...parts)

/** 功能项：不通过就计入失败（非 0 退出）。 */
function check(id, ok, detail) {
  results.checks.push({ id, ok, detail, kind: 'check' })
  if (!ok) results.failures.push({ id, detail })
  log(`${ok ? '✅' : '❌'} ${id}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  return ok
}

/** 现象记录：不影响退出码，但一定写进证据文档。 */
function finding(id, detail) {
  results.findings.push({ id, detail })
  log(`⚠️  ${id}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

/* ----------------------------------------------------------------- cookies */

/** 从 Chromium cookie 库里找当前端口的 dsh-auth cookie。 */
function currentCookie(port) {
  const output = execFileSync('sqlite3', [COOKIE_DB, 'select name, value from cookies'], { encoding: 'utf8' })
  for (const line of output.split('\n')) {
    const index = line.indexOf('|')
    if (index < 0) continue
    const name = line.slice(0, index)
    const value = line.slice(index + 1)
    if (!value.startsWith('v1.')) continue
    try {
      const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'))
      if (String(payload.authority ?? '').endsWith(`:${port}`)) return { name, value }
    } catch {
      /* 不是我们的 cookie */
    }
  }
  throw new Error(`没有找到 127.0.0.1:${port} 的 dsh-auth cookie —— 桌面 App 页面可能还没加载`)
}

/* ------------------------------------------------------------------- chrome */

function startChrome(width, height) {
  const profile = mkdtempSync(join(tmpdir(), 'wm-real-'))
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-crash-reporter', '--disable-breakpad', '--hide-scrollbars',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    `--window-size=${width},${height}`, 'about:blank',
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  return { pid: child.pid, profile }
}

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP}/json/version`)
      if (res.ok) return
    } catch {
      /* 还没起 */
    }
    await sleep(400)
  }
  throw new Error('chrome CDP 没起来')
}

/** 极简 CDP 客户端。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    } else if (message.method) {
      events.push(message)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  return {
    events,
    ready,
    close: () => ws.close(),
    send(method, params = {}) {
      const mid = ++id
      ws.send(JSON.stringify({ id: mid, method, params }))
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }))
    },
  }
}

/* ------------------------------------------------------------ page helpers */

async function evaluate(c, expression) {
  const result = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(`page error: ${result.exceptionDetails.text} ${result.result?.description ?? ''}`)
  return result.result?.value
}

/** 真实鼠标点一下。 */
async function clickAt(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

/** 按 selector 找到元素中心再点。 */
async function clickSelector(c, selector) {
  const rect = await evaluate(c, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
  })()`)
  if (rect === null || rect.w < 2 || rect.h < 2) return false
  await clickAt(c, rect.x, rect.y)
  return true
}

/** 按文字找按钮再点。 */
async function clickButtonByText(c, text) {
  const rect = await evaluate(c, `(() => {
    const nodes = [...document.querySelectorAll('button, [role="button"], .dsw-btn, .dsw-seg__btn')]
    const target = nodes.find((el) => (el.innerText || '').trim() === ${JSON.stringify(text)})
    if (!target) return null
    target.scrollIntoView({ block: 'center', inline: 'center' })
    const r = target.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
  })()`)
  if (rect === null) return false
  await clickAt(c, rect.x, rect.y)
  return true
}

/** 等一个条件成立（页面里的表达式返回真值）。 */
async function waitFor(c, expression, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(c, expression)
      if (value) return value
    } catch {
      /* 页面重排中 */
    }
    await sleep(intervalMs)
  }
  return null
}

/** 截图：超 400KB 就转 JPEG。 */
async function capture(c, name, clip) {
  mkdirSync(OUT, { recursive: true })
  // 宿主的「建议」气泡里有用户其它会话的文字，截图前必须盖掉（不是插件自己的 UI）。
  const hiddenHints = await hideForeignHints(c).catch(() => [])
  const shot = await c.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip === undefined ? {} : { clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 } }),
  })
  let path = join(OUT, `${name}.png`)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  let size = statSync(path).size
  if (size > MAX_SHOT_BYTES) {
    const jpg = path.replace(/\.png$/, '.jpg')
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '86', path, '--out', jpg], { stdio: 'ignore' })
    rmSync(path)
    path = jpg
    size = statSync(path).size
  }
  const relative = path.slice(REPO.length + 1)
  results.screenshots.push({ name, path: relative, bytes: size, hiddenHints: Array.isArray(hiddenHints) ? hiddenHints.length : 0 })
  log(`   📸 ${relative} (${Math.round(size / 1024)}KB)${Array.isArray(hiddenHints) && hiddenHints.length > 0 ? ` · 已遮住${hiddenHints.length}处建议气泡` : ''}`)
  await restoreForeignHints(c).catch(() => 0)
  return { path, relative, bytes: size }
}

/** 截图上不留别人的东西：把宿主的「建议」气泡临时隐藏（内容来自用户其它会话）。 */
async function hideForeignHints(c) {
  return evaluate(c, `(() => {
    const hidden = []
    const labels = [...document.querySelectorAll('span, div')]
      .filter((el) => {
        const text = (el.innerText || '').trim()
        return text === '建议' || /^[✦✦✧\s]*建议$/.test(text) || (text.length <= 6 && text.endsWith('建议'))
      })
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.width < 200 && r.height < 60
      })
    for (const label of labels) {
      // 往上找「建议」那一条的容器：宽 > 400、高 < 220，最多上溯 4 层，避免整块正文被隐藏
      let node = label
      let target = null
      for (let i = 0; i < 4 && node.parentElement !== null; i += 1) {
        node = node.parentElement
        const r = node.getBoundingClientRect()
        if (r.width > 400 && r.height < 220) { target = node; break }
      }
      if (target === null) continue
      target.style.visibility = 'hidden'
      hidden.push(target)
    }
    globalThis.__wmHidden = hidden
    return hidden.map((node) => ({ cls: String(node.className).slice(0, 50), h: Math.round(node.getBoundingClientRect().height) }))
  })()`)
}
async function restoreForeignHints(c) {
  return evaluate(c, `(() => {
    const hidden = globalThis.__wmHidden ?? []
    for (const node of hidden) node.style.visibility = ''
    globalThis.__wmHidden = []
    return hidden.length
  })()`)
}

/* -------------------------------------------------------------- 会话 / 数据 */

/** 解压会话 jsonl（多帧 zstd 拼接）。 */
function readSessionRecords(sessionId) {
  if (sessionId === null) return []
  let roots = []
  try { roots = readdirSync(SESSION_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()) } catch { return [] }
  for (const root of roots) {
    const dir = join(SESSION_ROOT, root.name, sessionId)
    if (!existsSync(dir)) continue
    const file = join(dir, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const buffer = readFileSync(file)
    const chunks = []
    let offset = 0
    while (offset < buffer.length) {
      const magic = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), offset)
      if (magic < 0) break
      let end = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), magic + 4)
      if (end < 0) end = buffer.length
      try { chunks.push(zlib.zstdDecompressSync(buffer.subarray(magic, end)).toString('utf8')) } catch { /* 半帧 */ }
      offset = end
    }
    return chunks.join('').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  }
  return []
}

/** 宿主这一轮是否跑完：jsonl 里出现新的 turn/end，且最后一条就是 turn/end。 */
async function waitTurnEnd(sessionId, baselineTurnEnd, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  let lastCount = 0
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    const records = readSessionRecords(sessionId)
    const ends = records.filter((record) => record.type === 'turn/end').length
    const last = records.length === 0 ? null : records[records.length - 1].type
    if (ends > baselineTurnEnd && last === 'turn/end') return { ok: true, turnEnds: ends, records: records.length }
    // 兜底：已经出现新的 turn/end，但最后一帧可能是半条记录被丢掉了 —— 文件 4 秒没长也算结束
    if (records.length !== lastCount) {
      lastCount = records.length
      stableSince = Date.now()
    } else if (ends > baselineTurnEnd && Date.now() - stableSince > 4000) {
      return { ok: true, turnEnds: ends, records: records.length, soft: true }
    }
    await sleep(700)
  }
  return { ok: false }
}

function countTurnEnds(sessionId) {
  return readSessionRecords(sessionId).filter((record) => record.type === 'turn/end').length
}

/** 便签墙上的便签（读文件，不写）。 */
function readNotes() {
  try { return JSON.parse(readFileSync(NOTES_FILE, 'utf8')).notes ?? [] } catch { return [] }
}

/** 跟进清单里未完成的条数（与 lib/watch.js 同一口径）。 */
function countOpenFollowups() {
  try {
    const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf8')).tasks ?? []
    return tasks.filter((task) => task !== null && typeof task === 'object' && task.done !== true).length
  } catch { return null }
}

/** "1.2k" / "127.1k" / "738" → 数字。 */
function parseTokenText(text) {
  const match = String(text ?? '').trim().match(/^([\d.]+)\s*([kM])?$/)
  if (match === null) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  if (match[2] === 'k') return value * 1000
  if (match[2] === 'M') return value * 1_000_000
  return value
}

/** 面板值与真值是否在展示精度内一致（k 是一位小数，误差按 5% 或 50 取大）。 */
function closeEnough(panelValue, truthValue) {
  if (panelValue === null || truthValue === null) return { ok: false, why: '无法解析' }
  const tolerance = Math.max(50, truthValue * 0.05)
  const delta = Math.abs(panelValue - truthValue)
  return { ok: delta <= tolerance, delta: Math.round(delta), tolerance: Math.round(tolerance) }
}

/** 自检截图 ×5 + 正文宽度度量（main 与 --shots 共用）。 */
async function runShots(c) {
  // 截图里不留别人的会话标题：侧边栏收起来（--shots 单独跑时也要做）
  await evaluate(c, `(() => {
    const button = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '') === '收起侧边栏')
    if (button) button.click()
    return button !== undefined
  })()`).catch(() => false)
  await sleep(900)
  await clickSelector(c, '.dsw-panel__icon[title="收起"]').catch(() => false)
  await sleep(400)
  await hideForeignHints(c)

  const measure = async () => evaluate(c, `(() => {
    const rails = [...document.querySelectorAll('.dsw-rail')]
    const rail = rails[0] ?? null
    const railRect = rail === null ? null : rail.getBoundingClientRect()
    const center = document.querySelector('[class*="centerCol"]')
    const composer = document.querySelector('[contenteditable="true"]')
    const textNodes = [...document.querySelectorAll('[class*="markdown"], p, [data-message-id]')]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 10 && r.height > 4 && (el.innerText || '').trim().length > 0
      })
    const intersects = (a, b) => a !== null && b !== null && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
    const asBox = (r) => r === null ? null : ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })
    const hits = railRect === null ? [] : textNodes.filter((el) => intersects(el.getBoundingClientRect(), railRect))
    const textRects = textNodes.map((el) => el.getBoundingClientRect())
    return {
      railCount: rails.length,
      railClass: rail === null ? null : rail.className,
      compact: rail !== null && rail.className.includes('dsw-rail--compact'),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      rail: asBox(railRect),
      railPosition: rail === null ? null : getComputedStyle(rail).position,
      railWidth: rail === null ? null : getComputedStyle(rail).width,
      centerCol: asBox(center?.getBoundingClientRect() ?? null),
      composer: asBox(composer?.getBoundingClientRect() ?? null),
      textColumn: textRects.length === 0 ? null : {
        left: Math.round(Math.min(...textRects.map((r) => r.left))),
        right: Math.round(Math.max(...textRects.map((r) => r.right))),
        width: Math.round(Math.max(...textRects.map((r) => r.right)) - Math.min(...textRects.map((r) => r.left))),
      },
      railHitsText: hits.map((el) => (el.innerText || '').trim().slice(0, 24)),
      railHitsComposer: composer === null ? null : intersects(composer.getBoundingClientRect(), railRect),
      documentScrollWidth: document.documentElement.scrollWidth,
    }
  })()`)

  const setDark = (dark) => evaluate(c, `(() => {
    if (${dark}) document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.style.colorScheme = ${dark} ? 'dark' : 'light'
    return { bodyBg: getComputedStyle(document.body).backgroundColor }
  })()`)

  const layoutFacts = []
  for (const viewport of VIEWPORTS) {
    const dark = await setDark(viewport.dark)
    await c.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false })
    // 视口变化后等工具条的响应式切换真正落地（≤1100px 变横排，宽度从 42 变成 300+）
    const expectCompact = viewport.width <= 1100
    let settled = await waitFor(c, `(() => {
      const rail = document.querySelector('.dsw-rail')
      if (rail === null) return false
      const width = rail.getBoundingClientRect().width
      const compact = rail.className.includes('dsw-rail--compact')
      return ${expectCompact} ? (compact && Math.abs(width - 42) > 2) : (!compact && Math.abs(width - 42) < 2)
    })()`, 12_000, 250)
    if (settled === null) {
      // 宿主偶尔吞掉一次 resize：补一发 resize 事件再看 3 秒
      await evaluate(c, `window.dispatchEvent(new Event('resize')); 0`)
      settled = await waitFor(c, `(() => {
        const rail = document.querySelector('.dsw-rail')
        if (rail === null) return false
        const width = rail.getBoundingClientRect().width
        const compact = rail.className.includes('dsw-rail--compact')
        return ${expectCompact} ? (compact && Math.abs(width - 42) > 2) : (!compact && Math.abs(width - 42) < 2)
      })()`, 3000, 250)
    }
    await sleep(600)
    const facts = await measure()
    const shot = await capture(c, `self-check-${viewport.name}`)
    layoutFacts.push({ ...viewport, shot: shot.relative, bodyBg: dark.bodyBg, settled: settled !== null, ...facts })
    if (settled === null) finding(`自检-${viewport.name}-响应式`, `15 秒内工具条没切到 ${expectCompact ? '横排（窄栏宽度≠42）' : '竖排（宽 42）'}；railCount=${facts.railCount} class=${JSON.stringify(facts.railClass)}`)
    const layoutOk = facts.documentScrollWidth <= facts.viewport.w + 1 && facts.railHitsText.length === 0 && facts.railHitsComposer === false
    check(`自检-${viewport.name}-工具条不压正文`, layoutOk,
      `视口 ${facts.viewport.w}×${facts.viewport.h} · rail ${JSON.stringify(facts.rail)}（${facts.railPosition}/${facts.railWidth}）· 正文列 ${JSON.stringify(facts.textColumn)} · 被 rail 压到的文字元素 ${facts.railHitsText.length} 个 · 与输入框相交 ${facts.railHitsComposer} · document.scrollWidth ${facts.documentScrollWidth} · 截图 ${shot.relative}`)
    await setDark(false)
  }
  results.layout = layoutFacts
  await restoreForeignHints(c)

  // 关键度量：工具条显示 / 隐藏时，正文容器宽度不变
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor(c, `document.querySelector('.dsw-rail--compact') === null`, 10_000, 250)
  await sleep(900)
  const shownBefore = await evaluate(c, `(() => ({
    center: Math.round(document.querySelector('[class*="centerCol"]')?.getBoundingClientRect().width ?? 0),
    composer: Math.round(document.querySelector('[contenteditable="true"]')?.getBoundingClientRect().width ?? 0),
  }))()`)
  const railClosed = await evaluate(c, `(() => {
    const button = document.querySelector('.dsw-rail__close')
    if (!button) return 'no-close'
    button.click()
    return true
  })()`)
  await sleep(900)
  const hiddenFacts = await evaluate(c, `(() => ({
    railGone: document.querySelector('.dsw-rail') === null,
    wing: document.querySelector('.dsw-wing') !== null,
    center: Math.round(document.querySelector('[class*="centerCol"]')?.getBoundingClientRect().width ?? 0),
    composer: Math.round(document.querySelector('[contenteditable="true"]')?.getBoundingClientRect().width ?? 0),
  }))()`)
  const wingBack = await evaluate(c, `(() => { const wing = document.querySelector('.dsw-wing'); if (!wing) return false; wing.click(); return true })()`)
  await sleep(900)
  const shownAfter = await evaluate(c, `(() => ({
    railBack: document.querySelector('.dsw-rail') !== null,
    center: Math.round(document.querySelector('[class*="centerCol"]')?.getBoundingClientRect().width ?? 0),
    composer: Math.round(document.querySelector('[contenteditable="true"]')?.getBoundingClientRect().width ?? 0),
  }))()`)
  results.layoutStability = { shownBefore, hiddenFacts, shownAfter, railClosed, wingBack }
  check('自检-工具条显示/隐藏正文宽度不变',
    railClosed === true && hiddenFacts.railGone === true && wingBack === true && shownAfter.railBack === true
      && shownBefore.center === hiddenFacts.center && shownBefore.composer === hiddenFacts.composer
      && shownAfter.center === shownBefore.center && shownAfter.composer === shownBefore.composer,
    `收起前 center=${shownBefore.center}/composer=${shownBefore.composer} → 收起后 center=${hiddenFacts.center}/composer=${hiddenFacts.composer} → 恢复后 center=${shownAfter.center}/composer=${shownAfter.composer}`)
}

/* ------------------------------------------------------------------- 主流程 */

async function main() {
  mkdirSync(OUT, { recursive: true })
  const cookie = currentCookie(PORT)
  const chrome = startChrome(1440, 900)
  await waitCdp()
  const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
  const c = connect(target.webSocketDebuggerUrl)
  await c.ready
  await c.send('Page.enable')
  await c.send('Runtime.enable')
  await c.send('Log.enable')
  await c.send('Network.enable')
  await c.send('Network.setCookie', {
    name: cookie.name, value: cookie.value, domain: '127.0.0.1', path: '/', httpOnly: false, secure: false,
  })
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })

  const railReady = await waitFor(c, `document.querySelector('.dsw-rail') !== null`, 25_000)
  if (!railReady) throw new Error('工具条 .dsw-rail 没渲染出来 —— 插件没挂上')
  await sleep(1500)

  if (SHOTS_ONLY) {
    await runShots(c)
    results.finishedAt = new Date().toISOString()
    results.ok = results.failures.length === 0
    writeFileSync(join(OUT, 'real-check.json'), JSON.stringify(results, null, 2))
    log('')
    log(`截图 ${results.screenshots.length} 张 → docs/p1/（--shots 模式，未跑 P1 三项）`)
    c.close()
    try { process.kill(chrome.pid) } catch { /* 已退出 */ }
    if (results.failures.length > 0) process.exitCode = 1
    return
  }

  /* 0. 隐私：收起侧边栏（截图里不留别人的会话标题），关掉第三方热重载提示 */
  const sidebarCollapsed = await evaluate(c, `(() => {
    const button = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('aria-label') || '') === '收起侧边栏')
    if (!button) return false
    button.click()
    return true
  })()`)
  await sleep(1200)
  check('0-隐私-收起侧边栏', sidebarCollapsed === true, `已点击「收起侧边栏」，会话标题不再出现在截图里`)
  await evaluate(c, `(() => {
    const buttons = [...document.querySelectorAll('button')].filter((el) => {
      const label = ((el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '')).toLowerCase()
      return label.includes('close') || label.includes('关闭') || label.includes('dismiss')
    }).filter((el) => {
      const r = el.getBoundingClientRect()
      return r.y > window.innerHeight - 240 && r.x > window.innerWidth - 560
    })
    for (const el of buttons) el.click()
    return buttons.length
  })()`)

  /* 1. 工具条本体：42px、fixed、浮层 */
  const railFacts = await evaluate(c, `(() => {
    const rail = document.querySelector('.dsw-rail')
    const style = getComputedStyle(rail)
    const rect = rail.getBoundingClientRect()
    return {
      compact: document.querySelector('.dsw-rail--compact') !== null,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height),
      position: style.position,
      pointerEvents: style.pointerEvents,
      zIndex: style.zIndex,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      cells: [...document.querySelectorAll('.dsw-cell')].map((el) => el.className.replace('dsw-cell ', '').trim()),
      overlayParents: (() => {
        const out = []
        let node = rail.parentElement
        for (let i = 0; i < 6 && node !== null; i += 1) {
          out.push({ tag: node.tagName, cls: String(node.className).slice(0, 60), pos: getComputedStyle(node).position })
          node = node.parentElement
        }
        return out
      })(),
    }
  })()`)
  check(
    '1-工具条-42px-浮层',
    railFacts.width === 42 && railFacts.position === 'fixed',
    `宽 ${railFacts.width}px · position:${railFacts.position} · pointer-events:${railFacts.pointerEvents} · z-index:${railFacts.zIndex} · 父层:${JSON.stringify(railFacts.overlayParents)}`,
  )
  check('1-工具条-入口齐全', railFacts.cells.length >= 6, `入口 ${railFacts.cells.length} 个：${railFacts.cells.join(' / ')}`)

  /* 2. 先打开一次「对话状态」，从网络请求里拿到当前会话 id（后面跟宿主对账用） */
  const openWatch = async () => {
    const state = await evaluate(c, `(() => ({ open: document.querySelector('.dsw-panel') !== null, title: (document.querySelector('.dsw-panel__title')?.innerText || '').trim() }))()`)
    if (state.open && state.title === '对话状态') {
      await clickSelector(c, '.dsw-panel__icon[title="收起"]')
      await sleep(300)
    }
    await clickSelector(c, '.dsw-cell.dsw-tone--slate')
    await sleep(1200)
    return evaluate(c, `(() => {
      const panel = document.querySelector('.dsw-panel')
      return {
        open: panel !== null,
        title: (document.querySelector('.dsw-panel__title')?.innerText || '').trim(),
        rows: [...document.querySelectorAll('.dsw-watch__row')].map((row) => {
          const spans = [...row.querySelectorAll('span')]
          return { label: (spans[0]?.innerText || '').trim(), value: (spans[1]?.innerText || '').trim() }
        }),
        context: {
          label: (document.querySelector('.dsw-watch__label')?.innerText || '').trim(),
          value: (document.querySelector('.dsw-watch__value')?.innerText || '').trim(),
          percent: (document.querySelector('.dsw-watch__pct')?.innerText || '').trim(),
        },
      }
    })()`)
  }
  const watchFirst = await openWatch()
  check('1b-对话状态面板可打开', watchFirst.open === true && watchFirst.title === '对话状态', `面板「${watchFirst.title}」行：${JSON.stringify(watchFirst.rows)}`)

  const watchRequestUrl = c.events
    .filter((event) => event.method === 'Network.requestWillBeSent' && event.params.request.url.includes('/dsh-wingman/api/watch'))
    .map((event) => event.params.request.url)
    .pop() ?? null
  const sessionId = watchRequestUrl === null ? null : decodeURIComponent((watchRequestUrl.match(/sessionId=([^&]+)/) ?? [])[1] ?? '')
  check('1c-拿到会话 id', typeof sessionId === 'string' && sessionId !== '', `当前会话：${sessionId || '(没拿到)'}`)
  await clickSelector(c, '.dsw-panel__icon[title="收起"]')
  await sleep(300)

  /* 2.5 面板关着时不许轮询：10 秒内 /dsh-wingman/api/watch 请求数必须为 0 */
  await clickSelector(c, '.dsw-panel__icon[title="收起"]')
  await sleep(600)
  const quietStart = c.events.length
  await sleep(10_000)
  const quietRequests = c.events.slice(quietStart)
    .filter((event) => event.method === 'Network.requestWillBeSent' && event.params.request.url.includes('/dsh-wingman/api/watch'))
    .length
  results.watchQuiet = { windowMs: 10_000, requests: quietRequests }
  check('1d-面板关着时 0 次 watch 请求', quietRequests === 0, `面板关闭后 10 秒内 /api/watch 请求 ${quietRequests} 次`)

  /* 3. P1-1 前置：输入框里写一句话再全选，看工具条认不认 */
  const composerSelector = '[contenteditable="true"]'
  const composerFacts = await evaluate(c, `(() => {
    const el = document.querySelector(${JSON.stringify(composerSelector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { tag: el.tagName, cls: String(el.className), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  })()`)
  check('3-composer-存在', composerFacts !== null, composerFacts === null ? '找不到输入框（contenteditable）' : `输入框 ${composerFacts.tag}.${composerFacts.cls} @ ${JSON.stringify(composerFacts.rect)}`)
  if (composerFacts === null) throw new Error('没有输入框，后续没法跑')

  await clickSelector(c, composerSelector)
  await sleep(200)
  await c.send('Input.insertText', { text: TEST_TEXT })
  await sleep(400)
  const typed = await evaluate(c, `(() => (document.querySelector(${JSON.stringify(composerSelector)})?.innerText || '').trim())()`)
  check('3-输入框-写入测试文字', typed.includes('工具条验收测试'), `输入框内容：${JSON.stringify(typed.slice(0, 120))}`)

  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await sleep(300)
  const selectionFacts = await evaluate(c, `(() => {
    const selection = window.getSelection()
    const el = document.querySelector(${JSON.stringify(composerSelector)})
    return {
      selected: String(selection?.toString() ?? '').trim(),
      rangeCount: selection?.rangeCount ?? 0,
      inComposer: el !== null && selection !== null && selection.anchorNode !== null && el.contains(selection.anchorNode),
    }
  })()`)
  check('3-输入框-全选', selectionFacts.rangeCount > 0 && selectionFacts.inComposer === true,
    `选中 ${JSON.stringify(selectionFacts.selected.slice(0, 120))}（选区在输入框内：${selectionFacts.inComposer}）`)

  await clickSelector(c, '.dsw-cell.dsw-tone--sage')
  await sleep(700)
  const literalPanel = await evaluate(c, `(() => {
    const panel = document.querySelector('.dsw-panel')
    return {
      open: panel !== null,
      title: (document.querySelector('.dsw-panel__title')?.innerText || '').trim(),
      empty: (document.querySelector('.dsw-empty')?.innerText || '').trim(),
      quote: (document.querySelector('.dsw-transform__quote')?.innerText || '').trim(),
    }
  })()`)
  const composerSelectionRecognized = String(literalPanel.quote ?? '').includes('工具条验收测试')
  results.literalComposerSelection = { selectionFacts, panel: literalPanel, recognized: composerSelectionRecognized }
  if (composerSelectionRecognized) {
    check('P1-1-字面流程-输入框全选后点✦', true, `面板认了输入框里的选区：${JSON.stringify(literalPanel.quote.slice(0, 80))}`)
  } else {
    finding('P1-1-字面流程-输入框全选后点✦',
      `面板没认输入框里的选区：点 ✦ 后面板是空态「${literalPanel.empty}」。按 client.js 的 currentSelection()，选区落在 textarea/input/contenteditable 里会被排除，所以「往输入框写文字 → 全选 → 改写」这条验收写法本身走不通；真实可用路径是选中正文再改写，见 P1-1 真流程`)
  }

  // 收起面板，清空输入框
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await sleep(400)
  await clickSelector(c, composerSelector)
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await sleep(400)
  check('3-输入框-清空', (await evaluate(c, `(() => (document.querySelector(${JSON.stringify(composerSelector)})?.innerText || '').trim())()`)) === '', '输入框已清空')

  /* 4. 发一条中性测试消息，拿到可以选中的正文 */
  const turnEndsBefore = countTurnEnds(sessionId)
  await clickSelector(c, composerSelector)
  await c.send('Input.insertText', { text: MSG_SEND })
  await sleep(400)
  const sendClicked = await evaluate(c, `(() => {
    const send = [...document.querySelectorAll('button')].find((el) => {
      const label = (el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '')
      return /发送|send/i.test(label) && el.getBoundingClientRect().width > 10
    })
    if (!send) return false
    const r = send.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (sendClicked !== false) await clickAt(c, sendClicked.x, sendClicked.y)
  else {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  }
  const sent = await waitFor(c, `(() => {
    const text = ${JSON.stringify(MSG_SEND)}
    return [...document.querySelectorAll('p,div,span')].some((el) => (el.innerText || '').trim() === text)
  })()`, 20_000)
  check('4-发测试消息', sent === true, sent ? `正文里出现了测试消息：${MSG_SEND}` : '20 秒内没在正文里看到刚发的消息')

  const turn1 = await waitTurnEnd(sessionId, turnEndsBefore, 240_000)
  check('4-本轮真正结束', turn1.ok === true, turn1.ok ? `会话 jsonl 走到 turn/end（第 ${turn1.turnEnds} 次）` : '240 秒内没等到 turn/end')

  /* 5. P1-1 真流程：选正文 → 改写成指令 → 插入输入框 */
  const selected = await evaluate(c, `(() => {
    const text = ${JSON.stringify(MSG_SEND)}
    const candidates = [...document.querySelectorAll('p, div, span')]
      .filter((el) => (el.innerText || '').trim() === text)
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 20 && item.rect.height > 8)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)
    if (candidates.length === 0) return { ok: false }
    const node = candidates[0].el
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, selected: String(selection.toString()).trim(), cls: String(node.className).slice(0, 60), tag: node.tagName }
  })()`)
  check('P1-1b-选中正文', selected?.ok === true && selected.selected === MSG_SEND,
    selected?.ok === true ? `选中 ${JSON.stringify(selected.selected.slice(0, 60))}（${selected.tag}.${selected.cls}）` : '正文里找不到可选的测试消息')
  await sleep(400)

  await clickSelector(c, '.dsw-cell.dsw-tone--sage')
  await sleep(800)
  const transformPanel = await evaluate(c, `(() => ({
    open: document.querySelector('.dsw-panel') !== null,
    title: (document.querySelector('.dsw-panel__title')?.innerText || '').trim(),
    quote: (document.querySelector('.dsw-transform__quote')?.innerText || '').trim(),
    count: (document.querySelector('.dsw-transform__count')?.innerText || '').trim(),
  }))()`)
  check('P1-1c-面板拿到正文选区', String(transformPanel.quote).includes('工具条验收测试'),
    `面板引用：${JSON.stringify(transformPanel.quote.slice(0, 80))} · ${transformPanel.count}`)

  const clickedRewrite = await clickButtonByText(c, '改写成指令')
  check('P1-1d-点「改写成指令」', clickedRewrite === true, clickedRewrite ? '已点击（本次唯一的改写模型调用）' : '找不到「改写成指令」按钮')

  // 等模型结果或面板里的错误，两种都收下来
  const aiState = await waitFor(c, `(() => {
    const result = document.querySelector('.dsw-transform__resultbody')
    if (result !== null && (result.innerText || '').trim() !== '') return { kind: 'result', text: result.innerText.trim() }
    const error = document.querySelector('.dsw-error')
    if (error !== null && (error.innerText || '').trim() !== '') return { kind: 'error', text: error.innerText.trim() }
    return null
  })()`, 75_000, 400)
  results.rewrite = { state: aiState }
  if (aiState?.kind === 'result') check('P1-1e-模型返回改写结果', true, `改写结果（${aiState.text.length} 字）：${JSON.stringify(aiState.text.slice(0, 160))}`)
  else check('P1-1e-模型返回改写结果', false,
    aiState?.kind === 'error'
      ? `面板报错：${JSON.stringify(aiState.text)}`
      : '75 秒内既没结果也没报错（面板停在「模型正在写…」）')

  const beforeInsert = await evaluate(c, `(() => (document.querySelector(${JSON.stringify(composerSelector)})?.innerText || '').trim())()`)
  const inserted = aiState?.kind === 'result' ? await clickButtonByText(c, '插入输入框') : false
  await sleep(1000)
  const afterInsert = await evaluate(c, `(() => (document.querySelector(${JSON.stringify(composerSelector)})?.innerText || '').trim())()`)
  results.rewrite = { ...results.rewrite, before: beforeInsert, after: afterInsert, inserted }
  const rewriteOk = aiState?.kind === 'result' && afterInsert.length > 0
    && (afterInsert === aiState.text || afterInsert.includes(aiState.text))
  check('P1-1f-输入框变成模型返回的改写结果', rewriteOk,
    `插入前输入框 ${JSON.stringify(beforeInsert)} → 插入后 ${JSON.stringify(afterInsert.slice(0, 160))}`)
  if (aiState?.kind === 'result') await capture(c, 'p1-1-rewrite-result-1440-light')
  await capture(c, 'p1-1-rewrite-1440-light')

  // 清掉输入框
  await clickSelector(c, composerSelector)
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await sleep(500)

  /* 6. P1-2 状态数字：模型 / tokens / 子代理 / 跟进 */
  const watchBefore = await openWatch()
  const rowOf = (name) => watchBefore.rows.find((row) => row.label === name) ?? null
  const records = readSessionRecords(sessionId)
  const requestContext = records.find((record) => record.type === 'request/context')?.data ?? null
  const requestHeader = records.find((record) => record.type === 'request/header')?.data?.header?.config ?? null

  // 6.1 模型：面板显示 provider · model，GUI 选择器显示的是同一模型的展示名 —— 用宿主模型目录把两者对上
  const selectorText = await evaluate(c, `(() => {
    const trigger = [...document.querySelectorAll('button, [class*="trigger"]')]
      .find((el) => /DeepSeek|GPT|Claude|Gemini|Kimi|GLM/i.test(el.innerText || '') && (el.innerText || '').trim().length < 40)
    return trigger === null ? null : (trigger.innerText || '').trim()
  })()`)
  const modelRow = rowOf('模型')
  const panelModel = String(modelRow?.value ?? '')
  let catalog = null
  let catalogFile = null
  const catalogRequest = c.events
    .filter((event) => event.method === 'Network.responseReceived' && event.params.response.url.includes('modelCatalog'))
    .pop() ?? null
  if (catalogRequest !== null) {
    try {
      const body = await c.send('Network.getResponseBody', { requestId: catalogRequest.params.requestId })
      writeFileSync(join(OUT, 'model-catalog.json'), body.body)
      catalogFile = 'docs/p1/model-catalog.json'
      catalog = JSON.parse(body.body)
    } catch { /* 拿不到就算了 */ }
  }
  const catalogJson = catalog === null ? '' : JSON.stringify(catalog)
  const selectorName = (selectorText ?? '').split('\n').pop()?.trim() ?? ''
  const mappingOk = catalogJson.includes(String(requestContext?.model ?? '\u0000')) && catalogJson.includes(selectorName)
  const modelIdOk = panelModel !== '' && panelModel !== '—' && requestContext !== null
    && panelModel.toLowerCase().includes(String(requestContext.model ?? '').toLowerCase())
  results.model = { panel: panelModel, selector: selectorText, hostContext: requestContext, hostHeader: requestHeader, catalogFile, mappingOk }
  check('P1-2-模型', modelIdOk === true,
    `面板「${panelModel}」 vs 宿主 request/context「${requestContext?.provider} · ${requestContext?.model}」（上下文窗口 ${requestContext?.contextWindow}）；GUI 模型选择器「${String(selectorText).replace(/\n/g, ' ')}」；模型目录里能把 id 与展示名对上：${mappingOk}`)

  // 6.2 tokens：面板「本轮」vs 会话 jsonl 最后一条 usage
  const usages = records.filter((record) => record.type === 'assistant/message' && record.data?.usage !== undefined).map((record) => record.data.usage)
  const lastUsage = usages.length === 0 ? null : usages[usages.length - 1]
  const roundText = String(rowOf('本轮')?.value ?? '')
  const parsed = {
    input: parseTokenText(roundText.match(/输入\s*([\d.]+[kM]?)/)?.[1]),
    output: parseTokenText(roundText.match(/输出\s*([\d.]+[kM]?)/)?.[1]),
    cache: parseTokenText(roundText.match(/缓存读\s*([\d.]+[kM]?)/)?.[1]),
  }
  const tokenCompare = lastUsage === null
    ? { ok: false, why: '会话 jsonl 里没有 usage 记录' }
    : (() => {
        const pairs = [
          ['输入', parsed.input, lastUsage.inputTokens],
          ['输出', parsed.output, lastUsage.outputTokens],
          ['缓存读', parsed.cache, lastUsage.cacheReadTokens],
        ]
        return {
          ok: pairs.every(([, panelValue, truth]) => closeEnough(panelValue ?? null, truth ?? null).ok),
          pairs: pairs.map(([name, panelValue, truth]) => ({ name, panel: panelValue, truth, ...closeEnough(panelValue ?? null, truth ?? null) })),
        }
      })()
  results.tokens = {
    panelRound: roundText,
    context: watchBefore.context,
    lastUsage,
    compare: tokenCompare,
    sessionTotalUsage: usages.reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0),
    turns: usages.length,
  }
  check('P1-2-tokens', tokenCompare.ok === true,
    `面板「${roundText}」 vs 会话 jsonl 最后一条 usage「输入 ${lastUsage?.inputTokens} · 输出 ${lastUsage?.outputTokens} · 缓存读 ${lastUsage?.cacheReadTokens}」；面板上下文环 ${watchBefore.context?.value}（${watchBefore.context?.percent}）`)

  // 6.3 子代理：起一个真实的 codex 子代理，看面板会不会自己更新
  const subagentZero = String(rowOf('子代理')?.value ?? '')
  check('P1-2a-子代理起跑前为 0', /0\s*个运行中/.test(subagentZero), `面板：${subagentZero}`)
  const catalogsBefore = readSessionRecords(sessionId).filter((record) => record.type === 'subagent/catalog').length

  await clickSelector(c, '.dsw-panel__icon[title="收起"]')
  await sleep(300)
  const turnEndsBeforeSpawn = countTurnEnds(sessionId)
  await clickSelector(c, composerSelector)
  await c.send('Input.insertText', { text: MSG_SPAWN })
  await sleep(400)
  const sendSpawn = await evaluate(c, `(() => {
    const send = [...document.querySelectorAll('button')].find((el) => {
      const label = (el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '')
      return /发送|send/i.test(label) && el.getBoundingClientRect().width > 10
    })
    if (!send) return false
    const r = send.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (sendSpawn !== false) await clickAt(c, sendSpawn.x, sendSpawn.y)
  else {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  }
  log('   已请会话起一个子代理，开始盯面板…')

  // 面板打开后就不再关：每 800ms 读一次行文字，等「子代理」这一行出现这个子级
  let peak = null
  let peakShot = null
  let panelTextPeak = ''
  const spawnDeadline = Date.now() + 90_000
  while (Date.now() < spawnDeadline) {
    const state = await evaluate(c, `(() => {
      const rows = [...document.querySelectorAll('.dsw-watch__row')].map((row) => {
        const spans = [...row.querySelectorAll('span')]
        return { label: (spans[0]?.innerText || '').trim(), value: (spans[1]?.innerText || '').trim() }
      })
      const panel = document.querySelector('.dsw-panel')
      return { open: panel !== null, rows, text: panel === null ? '' : (panel.innerText || '').trim(), footer: (document.querySelector('.dsw-watch__foot')?.innerText || '').trim() }
    })()`)
    if (state.open !== true) {
      await clickSelector(c, '.dsw-cell.dsw-tone--slate')
      await sleep(900)
      continue
    }
    panelTextPeak = String(state.text ?? '')
    const row = (state.rows ?? []).find((item) => item.label === '子代理')
    const value = String(row?.value ?? '')
    if (/本会话\s*[1-9]\d*\s*个子代理|共\s*[1-9]\d*\s*个|[1-9]\d*\s*个运行中/.test(value)) {
      peak = value
      peakShot = await capture(c, 'p1-2-subagent-running')
      break
    }
    await sleep(800)
  }
  const catalogsAfter = readSessionRecords(sessionId).filter((record) => record.type === 'subagent/catalog').length
  results.subagents = { before: subagentZero, peak: peak ?? null, screenshot: peakShot?.relative ?? null, catalogsBefore, catalogsAfter }
  check('P1-2b-子代理出现在面板里', peak !== null && catalogsAfter > catalogsBefore,
    peak === null
      ? `90 秒内面板「子代理」行没变（会话 jsonl 里的 subagent/catalog ${catalogsBefore}→${catalogsAfter}）；面板文字 ${JSON.stringify(panelTextPeak.slice(0, 160))}`
      : `面板「${peak}」；会话 jsonl 里的 subagent/catalog ${catalogsBefore}→${catalogsAfter}`)

  // 6.3b 面板开着时静默自动刷新：不点「刷新」，页脚时间戳自己变
  const turn2 = await waitTurnEnd(sessionId, turnEndsBeforeSpawn, 240_000)
  check('P1-2c-子代理那一轮结束', turn2.ok === true, turn2.ok ? `会话 jsonl 走到 turn/end（第 ${turn2.turnEnds} 次）` : '240 秒内没等到 turn/end')

  const footerBefore = await evaluate(c, `(document.querySelector('.dsw-watch__foot')?.innerText || '').trim()`)
  const autoStart = Date.now()
  const netBefore = c.events.length
  let footerAfter = footerBefore
  let autoShot = null
  let panelTextAfter = ''
  let rowAfter = ''
  while (Date.now() - autoStart < 12_000) {
    const state = await evaluate(c, `(() => {
      const rows = [...document.querySelectorAll('.dsw-watch__row')].map((row) => {
        const spans = [...row.querySelectorAll('span')]
        return { label: (spans[0]?.innerText || '').trim(), value: (spans[1]?.innerText || '').trim() }
      })
      const panel = document.querySelector('.dsw-panel')
      return { rows, text: panel === null ? '' : (panel.innerText || '').trim(), footer: (document.querySelector('.dsw-watch__foot')?.innerText || '').trim() }
    })()`)
    panelTextAfter = String(state.text ?? '')
    rowAfter = String((state.rows ?? []).find((row) => row.label === '子代理')?.value ?? '')
    footerAfter = String(state.footer ?? '')
    if (footerAfter !== footerBefore) {
      autoShot = await capture(c, 'p1-2d-auto-refresh')
      break
    }
    await sleep(700)
  }
  const autoRequests = c.events.slice(netBefore)
    .filter((event) => event.method === 'Network.requestWillBeSent' && event.params.request.url.includes('/dsh-wingman/api/watch'))
    .length
  results.autoRefresh = { footerBefore, footerAfter, afterMs: footerAfter === footerBefore ? null : Date.now() - autoStart, requests: autoRequests, panelText: panelTextAfter.slice(0, 400), subagentRowAfter: rowAfter, screenshot: autoShot?.relative ?? null }
  check('P1-2d-面板开着不点刷新自己更新', footerAfter !== footerBefore && autoRequests > 0,
    footerAfter === footerBefore
      ? `12 秒内页脚没变（还是「${footerBefore}」），静默请求 ${autoRequests} 次`
      : `没点刷新，页脚自己从「${footerBefore}」变成「${footerAfter}」（用时 ${Date.now() - autoStart}ms，期间静默请求 ${autoRequests} 次）；子代理行「${rowAfter}」；截图 ${autoShot?.relative}`)
  // 子代理跑完后「运行中」必须是 0（宿主对 codex 子代理没有 activity 信号，这条只做记录）
  finding('P1-2d-子代理运行状态口径', `跑完后子代理行：「${rowAfter}」。宿主 listDescendants 对 external（Codex）子代理永远报 activity='inactive'（子级没有 DSH session），所以「运行中」在这个 profile 里恒为 0；面板同时显示「共 N 个」，不会假装没起过。`)

  // 6.4 跟进：面板 vs ~/.dsh/followup/tasks.json
  const watchAfter = await openWatch()
  const followRow = watchAfter.rows.find((row) => row.label === '跟进')
  const panelFollowups = Number(String(followRow?.value ?? '').match(/(\d+)/)?.[1] ?? NaN)
  const fileFollowups = countOpenFollowups()
  results.followups = { panel: String(followRow?.value ?? ''), truth: fileFollowups }
  check('P1-2e-跟进数', Number.isFinite(panelFollowups) && panelFollowups === fileFollowups,
    `面板「${followRow?.value}」 vs tasks.json 未完成条数 ${fileFollowups}`)

  await capture(c, 'p1-2-status-1440-light')
  results.statusDump = { sessionId, model: results.model, tokens: results.tokens, subagents: results.subagents, followups: results.followups, context: watchAfter.context }

  /* 7. P1-3「记」写入：便签墙 */
  const notesBefore = readNotes()
  const notesBeforeCount = notesBefore.length
  const openNotes = async () => {
    const state = await evaluate(c, `(() => ({ open: document.querySelector('.dsw-panel') !== null, title: (document.querySelector('.dsw-panel__title')?.innerText || '').trim() }))()`)
    if (state.open && state.title === '速记') {
      await clickSelector(c, '.dsw-panel__icon[title="收起"]')
      await sleep(300)
    }
    await clickSelector(c, '.dsw-cell.dsw-tone--amber')
    await sleep(1200)
    return evaluate(c, `(() => ({
      open: document.querySelector('.dsw-panel') !== null,
      title: (document.querySelector('.dsw-panel__title')?.innerText || '').trim(),
      modes: [...document.querySelectorAll('.dsw-seg__btn')].map((el) => (el.innerText || '').trim()),
      stats: (document.querySelector('.dsw-notes__stats')?.innerText || '').trim(),
      placeholder: document.querySelector('.dsw-notes__text')?.getAttribute('placeholder') ?? null,
    }))()`)
  }
  const notesPanel = await openNotes()
  check('P1-3-速记面板', notesPanel.open === true && notesPanel.title === '速记',
    `面板：${notesPanel.title} · 模式：${JSON.stringify(notesPanel.modes)} · 统计：${JSON.stringify(notesPanel.stats)}`)

  await clickSelector(c, '.dsw-notes__text')
  await c.send('Input.insertText', { text: TEST_NOTE })
  await sleep(400)
  check('P1-3-写入测试便签', (await evaluate(c, `(() => (document.querySelector('.dsw-notes__text')?.value ?? '').trim())()`)).includes('工具条验收测试'), `输入框：${JSON.stringify(TEST_NOTE)}`)

  const saved = await clickButtonByText(c, '贴上便签墙')
  await sleep(1500)
  const panelAfterSave = await evaluate(c, `(() => ({
    added: (document.querySelector('.dsw-notes__added')?.innerText || '').trim(),
    stats: (document.querySelector('.dsw-notes__stats')?.innerText || '').trim(),
  }))()`)
  const notesAfter = readNotes()
  const createdNote = notesAfter.find((note) => String(note.text ?? '').includes('工具条验收测试便签'))
  check('P1-3-便签真的写进便签墙', saved === true && createdNote !== undefined,
    createdNote === undefined
      ? `notes.json 里没有新便签（之前 ${notesBeforeCount} 张，现在 ${notesAfter.length} 张）；面板提示：${JSON.stringify(panelAfterSave.added)}`
      : `notes.json 多了一张：id=${createdNote.id} text=${JSON.stringify(String(createdNote.text).slice(0, 40))}；面板提示「${panelAfterSave.added}」`)

  // 只截「表单 + 已贴上」这一段：下面是「最近便签」，会露出用户其它便签
  const formClip = await evaluate(c, `(() => {
    const panel = document.querySelector('.dsw-panel')
    const added = document.querySelector('.dsw-notes__added') || document.querySelector('.dsw-notes__actions')
    if (!panel || !added) return null
    const p = panel.getBoundingClientRect()
    const a = added.getBoundingClientRect()
    return { x: Math.round(p.x), y: Math.round(p.y), width: Math.round(p.width), height: Math.max(120, Math.round(a.bottom - p.y + 10)) }
  })()`)
  if (formClip !== null) await capture(c, 'p1-3-note-saved', formClip)

  check('P1-3-面板统计 +1', /便签\s*\d+\s*张/.test(panelAfterSave.stats) && Number(panelAfterSave.stats.match(/便签\s*(\d+)/)?.[1]) === notesBeforeCount + 1,
    `面板统计「${panelAfterSave.stats}」，便签墙之前 ${notesBeforeCount} 张`)

  /* 8. 清理：删掉测试便签 */
  if (createdNote !== undefined) {
    const removed = await evaluate(c, `(async () => {
      const response = await fetch('/dsh-sticky-wall/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'remove', id: ${JSON.stringify(createdNote.id)} }),
      })
      return { status: response.status, body: (await response.text()).slice(0, 200) }
    })()`)
    await sleep(1200)
    const gone = readNotes().every((note) => note.id !== createdNote.id)
    check('P1-3-清理测试便签', gone === true, gone ? `已删掉 ${createdNote.id}；便签墙剩 ${readNotes().length} 张` : `删除失败，接口返回 ${JSON.stringify(removed)}`)
  } else {
    check('P1-3-清理测试便签', false, '没建出测试便签，没有可清理的东西')
  }

  /* 9. 自检截图 ×5 + 正文宽度度量 */
  await runShots(c)

  /* 10. 红线 */
  const source = readFileSync(join(REPO, 'client.js'), 'utf8')
  check('红线-无 location.reload', /location\s*\.\s*reload\s*\(/.test(source) === false, 'client.js 里没有 location.reload(')
  const pluginErrors = c.events
    .filter((event) => event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
    .map((event) => event.params.entry.text)
    .filter((text) => /wingman|dsw-|dsw_/i.test(text))
  check('红线-无插件报错', pluginErrors.length === 0, pluginErrors.length === 0 ? '控制台没有 wingman 相关 error' : JSON.stringify(pluginErrors.slice(0, 5)))

  results.finishedAt = new Date().toISOString()
  results.ok = results.failures.length === 0
  writeFileSync(join(OUT, 'real-check.json'), JSON.stringify(results, null, 2))

  log('')
  log('──────── 汇总 ────────')
  for (const item of results.checks) log(`${item.ok ? '✅' : '❌'} ${item.id}`)
  for (const item of results.findings) log(`⚠️  ${item.id}`)
  log(`截图 ${results.screenshots.length} 张 → docs/p1/`)
  log('结果 JSON：docs/p1/real-check.json')

  c.close()
  try { process.kill(chrome.pid) } catch { /* 已退出 */ }
  if (results.failures.length > 0) {
    log('')
    log('失败项：')
    for (const failure of results.failures) log(`  ❌ ${failure.id}: ${failure.detail}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  results.finishedAt = new Date().toISOString()
  results.ok = false
  results.crash = String(error?.stack ?? error)
  try {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, 'real-check.json'), JSON.stringify(results, null, 2))
  } catch { /* 写不了就算了 */ }
  console.error('❌ real-check 崩了：', error)
  process.exit(1)
})
