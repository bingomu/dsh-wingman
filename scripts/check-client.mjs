#!/usr/bin/env node
/**
 * client.js 自检 —— 面向一个事实：浏览器半侧一旦起不来，**整个桌面端都打不开**
 * （客户端启动会等所有 client 入口变成 active，任何一个 failed/pending 就直接弹崩溃卡）。
 *
 * 三道关：
 *   1. 解析：半保存的文件（`try {` 少了 catch）在这里就被拦下
 *   2. 声明：全大写常量必须在本文件里声明过。
 *      0.5.2 的「清诊断探针」把 API / SNAP_PX / zh / en 一起删了，这类误删只有静态检查抓得到
 *   3. 挂载：用桩把模块跑起来，跑 factory(require) + apply(ctx)，
 *      确认细条两处宿主 + 输入桥都注册上、字典也注册了（zh/en 缺失会在这里抛 ReferenceError）
 *
 * 用法：node scripts/check-client.mjs [client.js 路径]
 * 退出码：0 通过 / 1 有问题
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const file = path.resolve(process.argv[2] ?? 'client.js')
const source = fs.readFileSync(file, 'utf8')
const failures = []

const ok = (label) => process.stdout.write(`✅ ${label}\n`)
const bad = (label, detail) => {
  failures.push(label)
  process.stdout.write(`❌ ${label}\n   ${String(detail).split('\n').slice(0, 6).join('\n   ')}\n`)
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*/gm, ' ')
/** 去掉注释和字符串字面量，只留会真的被执行的标识符（模板串里的 ${} 一并丢掉，那部分由挂载检查兜底）。 */
const codeOnly = (text) => stripComments(text)
  .replace(/`(?:\\.|[^`\\])*`/g, ' ')
  .replace(/'(?:\\.|[^'\\])*'/g, ' ')
  .replace(/"(?:\\.|[^"\\])*"/g, ' ')

// ── 1. 解析 ────────────────────────────────────────────────────────────────
try {
  new vm.Script(source, { filename: file })
  ok(`解析通过（${source.split('\n').length} 行）`)
} catch (error) {
  bad('语法错误：客户端会 import failed，桌面端直接打不开', error.message)
  process.exit(1)
}

// ── 2. 全大写常量都声明过 ──────────────────────────────────────────────────
const CODE = codeOnly(source)
const ALLOWED = new Set(['JSON', 'URL', 'NaN', 'Infinity', 'CSS', 'DOM', 'MDN', 'CLI', 'API_URL_UNUSED'])
const declared = new Set()
for (const match of CODE.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1])
for (const match of CODE.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1])
const capsUsed = new Set()
for (const match of CODE.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) capsUsed.add(match[1])
const capsMissing = [...capsUsed].filter((name) => !declared.has(name) && !ALLOWED.has(name))
if (capsMissing.length === 0) {
  ok(`常量声明完整（用到 ${capsUsed.size} 个全大写名）`)
} else {
  bad('有常量在用但没声明：运行到就 ReferenceError', capsMissing.join(', '))
}

// ── 3. 字典覆盖 ────────────────────────────────────────────────────────────
function dictKeys(name) {
  const match = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n    \\}`).exec(source)
  if (match === null) return null
  return new Set([...match[1].matchAll(/^\s{4,}(\w+):/gm)].map((m) => m[1]))
}
const zhKeys = dictKeys('zh')
const enKeys = dictKeys('en')
const usedKeys = new Set([...source.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]))
if (zhKeys === null || enKeys === null) {
  bad('找不到 zh / en 字典：界面会退化成一个键名', '字典缺失或写法变了')
} else {
  const missing = [...usedKeys].filter((key) => !zhKeys.has(key) || !enKeys.has(key))
  if (missing.length === 0) ok(`字典覆盖 ${usedKeys.size} 个 t() 键（zh ${zhKeys.size} / en ${enKeys.size}）`)
  else bad('有 t() 键缺字典条目', missing.join(', '))
}

// ── 4. 用桩跑一遍 factory + apply ──────────────────────────────────────────
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: { language: 'zh-CN' },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
}
sandbox.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', parentNode: null, appendChild() {} }),
  head: { appendChild() {} },
  documentElement: {},
  body: {},
  elementFromPoint: () => null,
  addEventListener() {},
  removeEventListener() {},
}
sandbox.window = {
  innerWidth: 1600,
  innerHeight: 1000,
  document: sandbox.document,
  localStorage: sandbox.localStorage,
  navigator: sandbox.navigator,
  getComputedStyle: sandbox.getComputedStyle,
  getSelection: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
  setTimeout: sandbox.setTimeout,
  clearTimeout: sandbox.clearTimeout,
  setInterval: sandbox.setInterval,
  clearInterval: sandbox.clearInterval,
}
sandbox.globalThis = sandbox

let entry = null
sandbox.window.__ModuleLoader__ = { load: (value) => { entry = value } }

const hooks = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}


// CSS 选择器覆盖：代码里用到的静态 class 必须能找到对应规则
const cssSelectors = new Set([...source.matchAll(/\.(dsw-[a-z0-9_-]+)/g)].map((match) => match[1]))
const usedClasses = new Set()
for (const match of source.matchAll(/className:\s*['"]([^'"]+)['"]/g)) {
  for (const token of match[1].split(/\s+/)) {
    if (token.startsWith('dsw-') && !token.endsWith('--')) usedClasses.add(token)
  }
}
const missingClasses = [...usedClasses].filter((name) => !cssSelectors.has(name))
if (missingClasses.length > 0) {
  bad('有 class 没有对应样式', missingClasses.join(', '))
} else {
  ok(`样式覆盖完整（${usedClasses.size} 个静态 class）`)
}

// 组件引用完整性：h(SomePanel) 必须有对应的 function SomePanel(
const componentRefs = new Set([...source.matchAll(/\bh\(([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1]))
const knownNonComponents = new Set(['React', 'ICONS'])
const undefinedComponents = [...componentRefs].filter((name) => !knownNonComponents.has(name) && !new RegExp(`function ${name}\\s*\\(`).test(source))
if (undefinedComponents.length > 0) {
  bad('有组件被引用但没定义', undefinedComponents.join(', '))
} else {
  ok(`组件引用完整（${componentRefs.size} 个）`)
}

try {
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: file })
  if (entry === null) throw new Error('模块没有调用 window.__ModuleLoader__.load')
  if (entry.id !== 'dsh-wingman') throw new Error(`入口 id 不对：${entry.id}`)
  const plugin = entry.factory((name) => {
    if (name === 'react') return hooks
    throw new Error(`require 了未注入的包：${name}`)
  })
  if (typeof plugin?.apply !== 'function') throw new Error('factory 没有返回带 apply() 的插件对象')

  const registered = []
  const effects = []
  plugin.apply({
    effect: (fn, label) => {
      effects.push(label)
      fn()
      return () => {}
    },
    locale: { register: () => () => {} },
    slots: {
      inject: (_name, fn) => fn(),
      register: (descriptor) => {
        registered.push(descriptor.id)
        return () => {}
      },
    },
  })

  const expected = ['dsh-wingman:rail-dock', 'dsh-wingman:rail-header', 'dsh-wingman:bridge']
  const missingSlots = expected.filter((id) => !registered.includes(id))
  if (missingSlots.length > 0) throw new Error(`缺少 slot 注册：${missingSlots.join(', ')}（实际 ${registered.join(', ')}）`)
  if (!effects.includes('dsh-wingman: dictionaries')) throw new Error('字典没有注册（apply 里少了 locale.register）')
  ok(`挂载通过：${registered.join(' · ')}`)
} catch (error) {
  bad('挂载失败：客户端会显示「应用无法启动」，桌面端打不开', `${error.name}: ${error.message}`)
}

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} 项没过；这个版本的 client.js 不要装进 profile。\n`)
  process.exit(1)
}
process.stdout.write('\nclient.js 自检通过；可以安装/重启了。\n')
