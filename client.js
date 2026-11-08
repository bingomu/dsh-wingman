/**
 * Wingman · 浏览器半侧
 *
 * 宽栏（>1100px）在 `shell.overlay`（全帧浮层、默认点击穿透）挂一条贴正文左缘的细条：
 *   - 常驻 42px 宽，浮层不参与布局，聊天区宽度不变；
 * 窄栏（≤1100px）改成输入框上方一条 38px 高的横排，挂进 `conversation.input.dock` 的流里，
 * 占自己的位置、不压任何一个宿主控件（这个宽度下不再提供「收起」）。
 *   - 点「❝」滑出 308px 面板：常用指令列表 → 点一下插入输入框；
 *   - 「＋」打开「更多」，列出后续入口的排期；
 *   - 宽栏可拖动（顶部握把），位置/当前入口/钉住状态存本地。
 *
 * 另在 `conversation.input.dock` 挂一个空渲染的桥：那里有 `inputActions`，
 * 浮层里没有，所以由桥把写入能力交给细条，避免直接碰宿主的输入组件。
 *
 * 视觉全部走宿主主题 token；不读其它插件的 DOM、样式或组件源码。
 */

window.__ModuleLoader__.load({
  id: '@bingomu/dsh-wingman',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-wingman'
    const API = '/dsh-wingman/api/snippets'
    const WATCH_API = '/dsh-wingman/api/watch'
    const TRANSFORM_API = '/dsh-wingman/api/transform'
    const RECAP_API = '/dsh-wingman/api/recap'
    const TAIL_API = '/dsh-wingman/api/tail'
    const CUSTOM_API = '/dsh-wingman/api/custom'
    const REMINDERS_API = '/dsh-wingman/api/reminders'
    const RUN_API = '/dsh-wingman/api/run'
    const NOTE_API = '/dsh-sticky-wall/api/notes'
    const FOLLOWUP_API = '/followup'
    const POS_KEY = 'dsh-wingman/rail-pos/v1'
    const BLADE_KEY = 'dsh-wingman/blade/v1'
    const RAIL_PIN_KEY = 'dsh-wingman/rail-pin/v1'
    const PANEL_SIZE_KEY = 'dsh-wingman/panel-size/v2'
    const RAIL_HIDDEN_KEY = 'dsh-wingman/rail-hidden/v1'

    function readPanelSizes() {
      try {
        const match = document.cookie.split('; ').find((part) => part.startsWith(`${PANEL_SIZE_KEY}=`))
        if (match === undefined) return {}
        const parsed = JSON.parse(decodeURIComponent(match.split('=')[1]))
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writePanelSizes(sizes) {
      try {
        document.cookie = `${PANEL_SIZE_KEY}=${encodeURIComponent(JSON.stringify(sizes))}; path=/; max-age=31536000`
      } catch {
        // 存不了就算了。
      }
    }

    const PIN_KEY = 'dsh-wingman/pinned/v1'
    const SNAP_KEY = 'dsh-wingman/snap/v1'
    const SNAP_OFFSET_KEY = 'dsh-wingman/snap-offset/v1'
    const COMPACT_QUERY = '(max-width:1100px)'
    /** compact 横排时让开侧栏图标条（56px）的左边距，底部留 24px。 */
    const COMPACT_INSET = 60
    const COMPACT_BOTTOM = 24
    /** compact 底部抽屉的底边：抬到输入框上方，避免展开时盖住输入框与发送按钮。 */
    const COMPACT_PANEL_BOTTOM = 122
    /** 拖到离侧栏边缘这么近，松手就吸附。 */
    const SNAP_PX = 56

    /**
     * 桌面端每次重启都换端口，localStorage 按端口隔离、每次都丢；
     * Cookie 按 host 存，端口变了还在，所以位置/吸附/钉住/当前入口放这里。
     */
    const STATE_COOKIE = 'dsh_swiss_state'

    function readStore() {
      try {
        const prefix = `${STATE_COOKIE}=`
        const entry = String(document.cookie || '').split('; ').find((item) => item.startsWith(prefix))
        if (entry === undefined) return {}
        const parsed = JSON.parse(decodeURIComponent(entry.slice(prefix.length)))
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writeStore(patch) {
      try {
        const next = { ...readStore(), ...patch }
        document.cookie = `${STATE_COOKIE}=${encodeURIComponent(JSON.stringify(next))}; path=/; max-age=31536000; SameSite=Lax`
      } catch {
        // 存不了就算了，不影响使用。
      }
    }

    /* ------------------------------------------------------------ 文案 */

    const zh = {
      rail: '工具条',
      snippetsReset: '还原为示例',
      snippetsResetConfirm: '再点一次确认',
      snippetsResetDone: '已还原为示例',
      quotesClear: '清空',
      quotesClearConfirm: '再点一次确认',
      quotesCleared: '已清空',
      moreResetAll: '还原工具条',
      moreResetAllAction: '还原',
      moreResetAllConfirm: '再点一次确认',
      moreResetAllDone: '工具条已还原（顺序、隐藏、位置、吸附、收起）',
      snippets: '常用指令',
      roadmap: '设置',
      notes: '速记',
      close: '收起',
      pin: '钉住',
      unpin: '取消钉住',
      railPin: '钉住工具条（常亮显示）',
      railUnpin: '取消钉住（半透明）',
      railPinned: '已钉住',
      railUnpinned: '已取消钉住，鼠标移上去才显示',
      railClose: '收起工具条',
      railShow: '显示 Wingman 工具条',
      railDrag: '可拖动换位置',
      railMoved: '位置已记住',
      railHidden: '工具条已收起 · 点左边的羽毛图标可以再叫出来',
      railRestored: '工具条回来了',
      drag: '按住可拖动工具条',
      snap: '吸附到侧栏',
      snapOnHint: '已吸附到侧栏 · 点击取消吸附',
      snapOffHint: '未吸附 · 点击吸附到侧栏',
      unsnap: '取消吸附',
      snapped: '已吸附到侧栏',
      snapOff: '已取消吸附，可自由拖拽',
      snapFailed: '没量到侧栏位置，拖到边上试试',
      newSnippet: '＋ 新建',
      search: '搜索已存的指令…',
      all: '全部',
      empty: '还没有存过指令。点「＋ 新建」，把常写的那句存进来。',
      emptySearch: '没有匹配的指令。',
      titleField: '标题',
      groupField: '分组（可空）',
      bodyField: '内容；插入时 {光标} 会被去掉，其余原样进输入框',
      save: '保存',
      cancel: '取消',
      remove: '删除',
      edit: '编辑',
      inserted: '已插入输入框',
      noComposer: '先在会话里打开输入框再插入',
      insertFailed: '插入失败，可以手动复制',
      saved: '已保存',
      deleted: '已删除',
      loadFailed: '指令读取失败',
      uses: '{n} 次',
      roadmapTitle: '设置',
      watchContext: '这段对话用了多少',
      watchInput: '输入',
      watchOutput: '输出',
      watchCache: '缓存读',
      watchModel: '模型',
      watchRound: '本轮',
      watchSubagents: '子代理',
      watchFollowups: '跟进',
      watchRunning: '{n} 个运行中',
      watchTotal: '本会话 {n} 个子代理',
      watchOpen: '{n} 条未完成',
      watchRefresh: '刷新',
      watchNoSession: '先打开一个会话',
      watchWindow: '{n} 窗口',
      watchNoWindow: '窗口未知',
      watchNeedsRestart: '「状态」的取数接口还没生效——重启一次 DSH 就好',
      moreAvailable: '显示顺序',
      moreSettings: '工具条',
      moreSnap: '吸附到侧栏',
      moreReset: '位置',
      moreResetAction: '复位',
      expandRail: '展开其余 {n} 个',
      collapseRail: '收起',
      moreResetDone: '位置已复位，吸附保持开着',
      recapNoSession: '先打开一个会话',
      recapWorking: '正在读这段对话…',
      recapFailed: '复盘失败，稍后再试',
      recapRegenerate: '重新生成',
      recapInsert: '插入输入框',
      recapCopied: '已复制',
      recapSaved: '已存成便签',
      recapEmpty: '还没有内容',
      tailNoSession: '先打开一个会话',
      tailWorking: '正在翻上一个会话…',
      tailFailed: '读取失败，稍后再试',
      tailNoPrevious: '这个工作区还没有上一个会话',
      tailSource: '来自：{title}',
      tailInsert: '插入输入框',
      searchPlaceholder: '搜历史会话里的关键词…',
      searchWorking: '正在搜…',
      searchFailed: '搜索失败，稍后再试',
      searchEmpty: '没有找到，换个词试试',
      searchUntitled: '未命名会话',
      searchNoSnippet: '（没有摘要）',
      searchInserted: '已插入匹配的段落',
      quotesLoading: '正在读引用…',
      quotesFailed: '读取失败，稍后再试',
      quotesEmpty: '这段会话还没有引用过内容',
      quotesInserted: '已插回输入框',
      quotesDelete: '删除',
      recentWorking: '正在找最近改过的文件…',
      recentFailed: '读取失败，稍后再试',
      recentEmpty: '这个目录里最近没有改动',
      recentRefresh: '刷新',
      recentInserted: '已插入 @ 路径',
      customTitle: '自定义入口',
      customAdd: '＋ 新建',
      customCancel: '取消',
      customSave: '保存',
      customDelete: '删除',
      customName: '名称，例如「打开项目文件夹」',
      customTarget: '路径或命令，例如 /Users/you/project 或 npm run check',
      customCwdInput: '工作目录（可选，运行命令时用）',
      customKindOpen: '打开路径',
      customKindRun: '运行命令',
      customEmpty: '还没有自定义入口',
      customNeedFields: '名称和目标都要填',
      customSaveFailed: '保存失败，稍后再试',
      customNeedsRestart: '自定义入口还没生效——重启一次 DSH',
      customDeleteFailed: '删除失败，稍后再试',
      customRun: '执行',
      customRunning: '执行中…',
      customRunFailed: '执行失败',
      customCwd: '工作目录：{path}',
      moreUp: '上移一位',
      moreShow: '在工具条上显示',
      moreHide: '从工具条隐藏',
      moreDown: '下移一位',
      updatedAt: '更新于 {time}',
      noteMode: '便签',
      reminderMode: '提醒',
      reminderNeedTime: '先选一个提醒时间',
      reminderSave: '设好提醒',
      reminderSaved: '提醒已设好',
      reminderUpcoming: '即将提醒',
      reminderEmpty: '还没有提醒',
      reminderDone: '标记完成',
      reminder1h: '1 小时后',
      reminderTonight: '今晚 20:00',
      reminderTomorrow: '明天 10:00',
      followupMode: '跟进',
      notePlaceholder: '写一句，Enter 贴上便签墙（Shift+Enter 换行）',
      followupPlaceholder: '写一条跟进，Enter 加入清单',
      duePlaceholder: '什么时候（可选：明天 / 周五 / 3天后）',
      saveNote: '贴上便签墙',
      saveFollowup: '加入跟进',
      noteSaved: '已贴到便签墙',
      followupSaved: '已加入跟进清单',
      noteDown: '便签墙没有响应，确认 dsh-sticky-wall 在运行',
      followupDown: '跟进插件没有响应，确认 dsh-followup 在运行',
      noteCount: '便签 {n} 张',
      followupOpen: '跟进 {n} 条未完成',
      enterHint: 'Enter 保存 · Shift+Enter 换行',
      justAddedNote: '已贴上：{text}',
      justAddedFollowup: '已加入跟进：{text}',
      recentNotes: '最近便签',
      recentFollowups: '最近未完成',
      recentEmpty: '还没有',
      transformHint: '选中文字：引用 / 存下来 / 交给模型',
      transformIdleHint: '选中文字：先在正文里选中一段',
      transformChars: '{n} 字',
      transformNote: '存成便签',
      transformSnippet: '存进常用指令',
      transformQuote: '引用插入',
      transformCopy: '复制',
      transformNoteSaved: '已存成便签',
      transformSnippetSaved: '已存进常用指令',
      transformSnippetFailed: '存指令失败',
      transformQuoted: '已插入输入框',
      transformCopied: '已复制',
      transformCopyFailed: '复制失败',
      transformEmpty: '先在正文里选中一段文字',
      transformDialog: '对话',
      transformKeep: '留存',
      transformQuoteComment: '评论后引用',
      transformCommentPlaceholder: '写一句评论，会和上面的引用一起进输入框',
      transformInsertComment: '插入到输入框',
      transformAi: '让模型处理',
      transformPrompt: '改写成指令',
      transformSummary: '提炼要点',
      transformTranslate: '译成中文',
      transformTranslateEn: '译成英文',
      transformExplain: '解释这段',
      transformTests: '生成测试用例',
      transformFollowup: '存成跟进',
      transformFollowupSaved: '已存成跟进',
      transformThinking: '模型正在写…',
      panelResize: '拖动调整面板大小',
      summaryCurrent: '这轮',
      summaryPrevious: '上个会话',
      summaryWorking: '正在总结…',
      summaryFailed: '总结失败，稍后再试',
      summaryEmpty: '没有可用的内容',
      summaryInsert: '插入输入框',
      summaryInserted: '小结已插入',
      aiTransport: '模型连接失败（已自动重试一次）。检查网络或模型配置后再试。',
      aiAuth: '模型鉴权失败，检查 API Key 或模型配置。',
      aiFailed: '模型调用失败',
      transformFailed: '模型调用失败，稍后再试',
      transformInsert: '插入输入框',
      transformResultSave: '存进常用指令',
      transformCopiedResult: '已复制结果',
    }

    const en = {
      rail: 'Tool strip',
      snippetsReset: 'Restore samples',
      snippetsResetConfirm: 'Click again to confirm',
      snippetsResetDone: 'Samples restored',
      quotesClear: 'Clear',
      quotesClearConfirm: 'Click again to confirm',
      quotesCleared: 'Cleared',
      moreResetAll: 'Reset the strip',
      moreResetAllAction: 'Reset',
      moreResetAllConfirm: 'Click again to confirm',
      moreResetAllDone: 'Strip reset (order, hidden, position, snap, collapse)',
      snippets: 'Snippets',
      roadmap: 'Settings',
      notes: 'Note',
      close: 'Close',
      pin: 'Pin',
      unpin: 'Unpin',
      railPin: 'Pin the strip (always visible)',
      railUnpin: 'Unpin (semi-transparent)',
      railPinned: 'Pinned',
      railUnpinned: 'Unpinned — shows on hover',
      railClose: 'Hide toolbar',
      railShow: 'Show the Wingman toolbar',
      railDrag: 'drag to move',
      railMoved: 'Position saved',
      railHidden: 'Toolbar hidden — click the little feather on the left edge to bring it back',
      railRestored: 'Toolbar is back',
      drag: 'Hold to drag the strip',
      snap: 'Snap to sidebar',
      snapOnHint: 'Snapped to the sidebar · click to unsnap',
      snapOffHint: 'Not snapped · click to snap',
      unsnap: 'Unsnap',
      snapped: 'Snapped to the sidebar',
      snapOff: 'Unsnapped — drag anywhere',
      snapFailed: 'Could not measure the sidebar — drag near the edge',
      newSnippet: '+ New',
      search: 'Search snippets…',
      all: 'All',
      empty: 'No snippets yet. Use “+ New” to save a prompt you keep retyping.',
      emptySearch: 'No matching snippet.',
      titleField: 'Title',
      groupField: 'Group (optional)',
      bodyField: 'Body; {cursor} is stripped on insert, everything else goes into the composer',
      save: 'Save',
      cancel: 'Cancel',
      remove: 'Delete',
      edit: 'Edit',
      inserted: 'Inserted into the composer',
      noComposer: 'Open a conversation first',
      insertFailed: 'Insert failed — copy it manually',
      saved: 'Saved',
      deleted: 'Deleted',
      loadFailed: 'Could not load snippets',
      uses: '{n}×',
      roadmapTitle: 'Settings',
      watchContext: 'Context',
      watchInput: 'in',
      watchOutput: 'out',
      watchCache: 'cache',
      watchModel: 'Model',
      watchRound: 'This round',
      watchSubagents: 'Subagents',
      watchFollowups: 'Follow-ups',
      watchRunning: '{n} running',
      watchTotal: '{n} subagents this session',
      watchOpen: '{n} open',
      watchRefresh: 'Refresh',
      watchNoSession: 'Open a conversation first',
      watchWindow: '{n} window',
      watchNoWindow: 'window unknown',
      watchNeedsRestart: 'The status endpoint is not live yet — restart DSH once',
      moreAvailable: 'Order',
      moreSettings: 'Strip',
      moreSnap: 'Snap to sidebar',
      moreReset: 'Position',
      moreResetAction: 'Reset',
      expandRail: 'Show {n} more',
      collapseRail: 'Collapse',
      moreResetDone: 'Position reset; snapping stays on',
      recapNoSession: 'Open a conversation first',
      recapWorking: 'Reading the conversation…',
      recapFailed: 'Recap failed — try again',
      recapRegenerate: 'Regenerate',
      recapInsert: 'Insert into composer',
      recapCopied: 'Copied',
      recapSaved: 'Saved as a note',
      recapEmpty: 'Nothing yet',
      tailNoSession: 'Open a conversation first',
      tailWorking: 'Reading the previous session…',
      tailFailed: 'Could not read it — try again',
      tailNoPrevious: 'No previous session in this workspace',
      tailSource: 'From: {title}',
      tailInsert: 'Insert into composer',
      searchPlaceholder: 'Search keywords in past conversations…',
      searchWorking: 'Searching…',
      searchFailed: 'Search failed — try again',
      searchEmpty: 'Nothing found — try another word',
      searchUntitled: 'Untitled session',
      searchNoSnippet: '(no snippet)',
      searchInserted: 'Snippet inserted',
      quotesLoading: 'Reading quotes…',
      quotesFailed: 'Could not load quotes',
      quotesEmpty: 'No quotes in this conversation yet',
      quotesInserted: 'Inserted into composer',
      quotesDelete: 'Delete',
      recentWorking: 'Looking for recent files…',
      recentFailed: 'Could not read the directory',
      recentEmpty: 'Nothing changed recently here',
      recentRefresh: 'Refresh',
      recentInserted: 'Reference inserted',
      customTitle: 'Custom entries',
      customAdd: '＋ New',
      customCancel: 'Cancel',
      customSave: 'Save',
      customDelete: 'Delete',
      customName: 'Name, e.g. “Open project folder”',
      customTarget: 'Path or command, e.g. /Users/you/project or npm run check',
      customCwdInput: 'Working directory (optional, for commands)',
      customKindOpen: 'Open path',
      customKindRun: 'Run command',
      customEmpty: 'No custom entries yet',
      customNeedFields: 'Name and target are required',
      customSaveFailed: 'Save failed — try again',
      customNeedsRestart: 'Custom entries are not live yet — restart DSH once',
      customDeleteFailed: 'Delete failed — try again',
      customRun: 'Run',
      customRunning: 'Running…',
      customRunFailed: 'Run failed',
      customCwd: 'Working directory: {path}',
      moreUp: 'Move up',
      moreShow: 'Show on the strip',
      moreHide: 'Hide from the strip',
      moreDown: 'Move down',
      updatedAt: 'updated {time}',
      noteMode: 'Note',
      reminderMode: 'Remind',
      reminderNeedTime: 'Pick a time first',
      reminderSave: 'Set reminder',
      reminderSaved: 'Reminder set',
      reminderUpcoming: 'Upcoming',
      reminderEmpty: 'No reminders yet',
      reminderDone: 'Mark done',
      reminder1h: 'In 1 hour',
      reminderTonight: 'Tonight 20:00',
      reminderTomorrow: 'Tomorrow 10:00',
      followupMode: 'Follow-up',
      notePlaceholder: 'One line — Enter puts it on the sticky wall (Shift+Enter for a new line)',
      followupPlaceholder: 'One line — Enter adds it to the follow-up list',
      duePlaceholder: 'When (optional: tomorrow / Friday / in 3 days)',
      saveNote: 'Save note',
      saveFollowup: 'Add follow-up',
      noteSaved: 'Saved to the sticky wall',
      followupSaved: 'Added to the follow-up list',
      noteDown: 'Sticky wall not responding — is dsh-sticky-wall running?',
      followupDown: 'Follow-ups not responding — is dsh-followup running?',
      noteCount: '{n} notes',
      followupOpen: '{n} follow-ups open',
      enterHint: 'Enter saves · Shift+Enter for a new line',
      justAddedNote: 'Saved: {text}',
      justAddedFollowup: 'Added: {text}',
      recentNotes: 'Recent notes',
      recentFollowups: 'Recent open',
      recentEmpty: 'Nothing yet',
      transformHint: 'Process: save, quote or hand the selection to the model',
      transformIdleHint: 'Process: select some text first',
      transformChars: '{n} chars',
      transformNote: 'Save as note',
      transformSnippet: 'Save as snippet',
      transformQuote: 'Quote into composer',
      transformCopy: 'Copy',
      transformNoteSaved: 'Saved as a note',
      transformSnippetSaved: 'Saved as a snippet',
      transformSnippetFailed: 'Could not save the snippet',
      transformQuoted: 'Inserted into the composer',
      transformCopied: 'Copied',
      transformCopyFailed: 'Copy failed',
      transformEmpty: 'Select some text first',
      transformDialog: 'Conversation',
      transformKeep: 'Keep',
      transformQuoteComment: 'Quote + comment',
      transformCommentPlaceholder: 'One line — goes into the composer with the quote',
      transformInsertComment: 'Insert into composer',
      transformAi: 'Ask the model',
      transformPrompt: 'Rewrite as a prompt',
      transformSummary: 'Extract key points',
      transformTranslate: 'Translate to Chinese',
      transformTranslateEn: 'Translate to English',
      transformExplain: 'Explain this',
      transformTests: 'Draft test cases',
      transformFollowup: 'Save as follow-up',
      transformFollowupSaved: 'Saved as a follow-up',
      transformThinking: 'Model is writing…',
      panelResize: 'Drag to resize',
      summaryCurrent: 'This thread',
      summaryPrevious: 'Previous',
      summaryWorking: 'Summarising…',
      summaryFailed: 'Summary failed — try again',
      summaryEmpty: 'Nothing to summarise',
      summaryInsert: 'Insert',
      summaryInserted: 'Summary inserted',
      aiTransport: 'Model connection failed (retried once). Check network or model settings.',
      aiAuth: 'Model authentication failed. Check the API key or model settings.',
      aiFailed: 'Model call failed',
      transformFailed: 'Model call failed — try again',
      transformInsert: 'Insert into composer',
      transformResultSave: 'Save as snippet',
      transformCopiedResult: 'Result copied',
    }
    /* ------------------------------------------------------------ 工具 */

    function localeIdOf(service) {
      try {
        const snapshot = service !== null && service !== undefined && typeof service.getLocale === 'function' ? service.getLocale() : undefined
        const active = snapshot !== null && snapshot !== undefined ? snapshot.active || snapshot.id || snapshot.locale : undefined
        if (typeof active === 'string' && active.toLowerCase().indexOf('zh') === 0) return 'zh'
        if (typeof active === 'string' && active !== '') return 'en'
      } catch {
        // 回退到 navigator。
      }
      try {
        const language = typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : ''
        if (language.toLowerCase().indexOf('zh') === 0) return 'zh'
      } catch {
        // 没有 navigator。
      }
      return 'en'
    }

    function makeT(bound, locale) {
      const fallback = locale === 'zh' ? zh : en
      return (key, params) => {
        let text
        try {
          text = typeof bound === 'function' ? bound(key, params) : undefined
        } catch {
          text = undefined
        }
        if (typeof text !== 'string' || text === '' || text === key) text = fallback[key]
        if (typeof text !== 'string') text = key
        if (params !== undefined && params !== null) {
          for (const name of Object.keys(params)) text = text.split(`{${name}}`).join(String(params[name]))
        }
        return text
      }
    }

    function readJsonFlag(key, fallback) {
      const value = readStore()[key]
      return typeof value === 'boolean' ? value : fallback
    }

    function writeFlag(key, value) {
      writeStore({ [key]: value === true })
    }

    function readNumber(key, fallback) {
      const value = readStore()[key]
      return Number.isFinite(value) ? value : fallback
    }

    function writeNumber(key, value) {
      writeStore({ [key]: value })
    }

    function clampPos(position) {
      const width = typeof window === 'undefined' ? 1600 : window.innerWidth
      const height = typeof window === 'undefined' ? 960 : window.innerHeight
      return {
        left: Math.max(0, Math.min(Math.max(0, width - 64), Math.round(position.left))),
        top: Math.max(8, Math.min(Math.max(8, height - 150), Math.round(position.top))),
      }
    }

    function defaultPos() {
      const height = typeof window === 'undefined' ? 960 : window.innerHeight
      // 工具条现在有十来颗，按真实高度的一半往上抬，视觉上才是居中
      return { left: 344, top: Math.max(16, Math.round((height - 460) / 2)) }
    }

    function loadPos() {
      const stored = readStore().pos
      if (stored !== null && stored !== undefined && Number.isFinite(stored.left) && Number.isFinite(stored.top)) {
        return clampPos(stored)
      }
      return defaultPos()
    }

    function savePos(position) {
      writeStore({ pos: position })
    }


    /* ------------------------------------------------------------ 图标 */

    /** 所有图标统一：viewBox 16、线宽 1.5、无填充、圆角端点。 */
    function icon(paths, options = {}) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: options.size ?? 16,
        height: options.size ?? 16,
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      }, paths.map((d, index) => h('path', {
        key: index,
        d,
        stroke: 'currentColor',
        strokeWidth: options.stroke ?? 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        ...(options.fillPaths === true ? { fill: 'currentColor', stroke: 'none' } : {}),
      })))
    }

    const ICONS = {
      notes: () => icon(['M11.6 2.6l1.8 1.8-7.4 7.4-2.6.8.8-2.6z', 'M4 13.4h8']),
      snippets: () => icon(['M3.5 4.2h9v5.2H7l-2.6 2.2v-2.2H3.5z', 'M6 6.6h4.4']),
      transform: () => icon(['M8 3.2l1.3 3.3 3.3 1.3-3.3 1.3L8 12.8l-1.3-3.7L3.4 7.8l3.3-1.3z']),
      recap: () => icon(['M5.4 4.4L2.6 8l2.8 3.6', 'M2.6 8h6.2a3.6 3.6 0 0 1 0 7.2H6.8']),
      tail: () => icon(['M4.4 3.6v8.8h7.2', 'M7.2 6.4l4 3.2-4 3.2']),
      recent: () => icon(['M4.4 2.6h4.2l3 3v7.8H4.4z', 'M8.6 2.6v3h3']),
      quotes: () => icon(['M3.6 5.4h3.2v3.2H5.2c0 1 .5 1.7 1.4 2', 'M9.2 5.4h3.2v3.2h-1.6c0 1 .5 1.7 1.4 2']),
      search: () => icon(['M6.8 3.4a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8z', 'M9.4 9.4l3 3']),
      watch: () => icon(['M8 2.8a5.2 5.2 0 1 1-5.2 5.2', 'M8 5.6V8l1.8 1.2']),
      summary: () => icon(['M4.4 2.8h4.8l2.8 2.8v7.6H4.4z', 'M9.2 2.8v2.8h2.8', 'M6.3 8h3.4', 'M6.3 10.2h3.4']),
      settings: () => icon(['M3 4.6h10', 'M3 8h10', 'M3 11.4h10', 'M6.2 3.4v2.4', 'M9.8 6.8v2.4', 'M6.2 10.2v2.4']),
      customOpen: () => icon(['M2.6 5.2h4l1.4 1.8h5.4v6H2.6z', 'M2.6 5.2V4h4.2l1.2 1.2']),
      customRun: () => icon(['M2.6 3.6h10.8v8.8H2.6z', 'M5 6.2l2 2-2 2', 'M8.8 10.4h2.6']),
    }

    /**
     * 收起态的那枚小图标：一片羽毛。
     * 线稿画法（stroke=currentColor），在深浅主题下都跟着文字色走，不用另配一套颜色；
     * 22px 下只保留「羽片 + 中轴 + 一道分叉」三笔，再细就糊成一团。
     */
    function FeatherIcon(options = {}) {
      const size = options.size ?? 22
      return h('svg', {
        viewBox: '0 0 20 20',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block' },
      },
      h('g', {
        transform: 'translate(1.4,1.4) scale(0.72)',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('path', { d: 'M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z' }),
      h('line', { x1: 16, y1: 8, x2: 2, y2: 22 }),
      h('line', { x1: 17.5, y1: 15, x2: 9, y2: 15 }),
      ),
      )
    }

    /* ------------------------------------------------------------ 选区 */

    /**
     * 读当前选区；落在输入框、文本域或我们自己的面板里都不算。
     * 只读 window.getSelection()，不碰宿主组件。
     */
    function currentSelection(excludeNodes) {
      try {
        const selection = window.getSelection()
        if (selection === null || selection === undefined || selection.rangeCount === 0) return ''
        const text = String(selection.toString() ?? '').trim()
        if (text.length < 3) return ''
        const anchor = selection.anchorNode
        const element = anchor === null || anchor === undefined
          ? null
          : (anchor.nodeType === 1 ? anchor : anchor.parentElement)
        if (element !== null && element !== undefined) {
          for (const node of excludeNodes) {
            if (node !== null && node !== undefined && node.contains(element)) return ''
          }
          const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : ''
          if (tag === 'textarea' || tag === 'input' || element.isContentEditable === true) return ''
        }
        return text.slice(0, 6000)
      } catch {
        return ''
      }
    }

    /* ------------------------------------------------------------ 吸附测量 */

    // 先试几个可能存在的布局变量；名字对不上就退回几何测量。
    const SIDEBAR_VARS = [
      '--dsh-sidebar-width',
      '--dsw-sidebar-width',
      '--dsh-layout-sidebar-width',
      '--dsw-layout-sidebar-width',
    ]

    function edgeFromVars() {
      try {
        const computed = getComputedStyle(document.documentElement)
        for (const name of SIDEBAR_VARS) {
          const value = parseFloat(computed.getPropertyValue(name))
          if (Number.isFinite(value) && value >= 40 && value <= window.innerWidth * 0.45) return Math.round(value)
        }
      } catch {
        // 没有变量就继续。
      }
      return null
    }

    function chainOf(element) {
      const chain = []
      let current = element
      while (current !== null && current !== undefined) {
        chain.push(current)
        current = current.parentElement
      }
      return chain
    }

    function hitAt(x, y, excludeNodes) {
      const element = document.elementFromPoint(x, y)
      if (element === null || element === undefined) return null
      for (const node of excludeNodes) {
        if (node !== null && node !== undefined && node.contains(element)) return null
      }
      return element
    }

    /**
     * 侧栏的特征：贴着窗口左缘、又窄又高的一列。
     * 从左边缘几个像素开始，沿祖先链找「left≈0、宽度 40~45%、高度≥60%」里最宽的那一个，
     * 它的 right 就是侧栏右缘。比“取两点求共同祖先”稳，不会掉进正文里居中的内层容器。
     */
    function sidebarEdge(excludeNodes, y) {
      const width = window.innerWidth
      const height = window.innerHeight
      for (const x of [2, 8, 16]) {
        const element = hitAt(x, y, excludeNodes)
        if (element === null) continue
        let node = element
        let best = null
        while (node !== null && node !== document.body) {
          const rect = node.getBoundingClientRect()
          if (rect.left <= 4 && rect.width >= 40 && rect.width <= width * 0.45 && rect.height >= height * 0.5) {
            if (best === null || rect.width > best.width) best = { width: rect.width, right: rect.right }
          }
          node = node.parentElement
        }
        if (best !== null) return Math.round(best.right)
      }
      return null
    }

    /** 兜底：正文中心点与最左点求最近共同祖先，取正文一侧子节点的 left。 */
    function lcaEdge(excludeNodes) {
      const width = window.innerWidth
      const height = window.innerHeight
      const y = Math.max(60, Math.round(height * 0.42))
      const centerElement = hitAt(Math.round(width / 2), y, excludeNodes)
      let leftElement = null
      for (const x of [6, 14, 24]) {
        const found = hitAt(x, y, excludeNodes)
        if (found !== null) {
          leftElement = found
          break
        }
      }
      if (centerElement === null || leftElement === null) return null
      const centerChain = chainOf(centerElement)
      const leftChain = new Set(chainOf(leftElement))
      const common = centerChain.find((node) => leftChain.has(node))
      if (common === undefined) return null
      const index = centerChain.indexOf(common)
      const contentColumn = index > 0 ? centerChain[index - 1] : null
      if (contentColumn === null || contentColumn === common) return null
      const rect = contentColumn.getBoundingClientRect()
      if (!Number.isFinite(rect.left) || rect.left < 40 || rect.left > width * 0.35) return null
      return Math.round(rect.left)
    }

    /**
     * 正文列的左缘 = 侧栏右缘。
     *
     * 从屏幕中心的命中点往上走，记下「最外层、但仍然是一列」的容器：
     * 要求高度 ≥50% 视口、宽度 ≥40% 视口、且 left > 8（排除整屏外壳）。
     * 一个都找不到（例如整屏都是同一层），说明正文贴着窗口左缘，返回 0。
     */
    function contentColumnLeft(excludeNodes) {
      try {
        const width = window.innerWidth
        const height = window.innerHeight
        const y = Math.max(60, Math.round(height * 0.42))
        const element = hitAt(Math.round(width / 2), y, excludeNodes)
        if (element === null) return null
        let node = element
        let best = null
        let sawWide = false
        while (node !== null && node !== document.body) {
          const rect = node.getBoundingClientRect()
          if (rect.height >= height * 0.5 && rect.width >= width * 0.4) {
            sawWide = true
            if (rect.left > 8) best = { left: rect.left }
          }
          node = node.parentElement
        }
        if (best !== null) return Math.max(0, Math.round(best.left))
        return sawWide ? 0 : null
      } catch {
        return null
      }
    }

    /**
     * 侧栏是否已收起：最左边一点与屏幕中心点若共享同一个「宽容器」，
     * 说明左侧没有独立的侧栏，正文一直铺到窗口左缘 → 吸附点应为 0。
     */
    function collapsedEdge(excludeNodes) {
      try {
        const width = window.innerWidth
        const height = window.innerHeight
        const y = Math.max(60, Math.round(height * 0.42))
        const leftElement = hitAt(2, y, excludeNodes)
        const centerElement = hitAt(Math.round(width / 2), y, excludeNodes)
        if (leftElement === null || centerElement === null) return null
        const centerSet = new Set(chainOf(centerElement))
        let node = leftElement
        while (node !== null && node !== document.body) {
          if (centerSet.has(node)) {
            const rect = node.getBoundingClientRect()
            return rect.width >= width * 0.6 ? 0 : null
          }
          node = node.parentElement
        }
        return null
      } catch {
        return null
      }
    }

    /** 被全屏浮层（设置弹窗、模态框）盖住时不要重新测量，否则工具条会跟着乱跳。 */
    function isObscured(excludeNodes) {
      try {
        const y = Math.max(60, Math.round(window.innerHeight * 0.42))
        const element = hitAt(2, y, excludeNodes)
        if (element === null) return false
        let node = element
        while (node !== null && node !== document.body) {
          const rect = node.getBoundingClientRect()
          const style = window.getComputedStyle(node)
          if (rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9 && (style.position === 'fixed' || style.position === 'absolute')) {
            return true
          }
          node = node.parentElement
        }
        return false
      } catch {
        return false
      }
    }

    function measureEdge(excludeNodes) {
      try {
        const height = window.innerHeight
        for (const ratio of [0.3, 0.45, 0.65]) {
          const found = sidebarEdge(excludeNodes, Math.max(60, Math.round(height * ratio)))
          if (found !== null && found >= 40 && found <= window.innerWidth * 0.45) return found
        }
        const collapsed = collapsedEdge(excludeNodes)
        if (collapsed !== null) return collapsed
        const contentEdge = contentColumnLeft(excludeNodes)
        if (contentEdge !== null) return contentEdge
        const fallback = lcaEdge(excludeNodes)
        if (fallback !== null) return fallback
        return edgeFromVars()
      } catch {
        return edgeFromVars()
      }
    }

    /* ------------------------------------------------------------ 输入桥 */

    // 浮层拿不到 inputActions，由 input.dock 里的空组件把它交出来。
    const inputBridge = { actions: null, sessionId: null }
    /** 窄栏时把横排条挂进输入框 dock 的容器节点（在流里，不浮层）。 */
    const dockHost = { node: null }

    function InputBridge(props) {
      const dockRef = useRef(null)
      useEffect(() => {
        dockHost.node = dockRef.current
        return () => {
          if (dockHost.node === dockRef.current) dockHost.node = null
        }
      })
      const actions = props !== null && props !== undefined ? props.inputActions : null
      const sessionId = props !== null && props !== undefined && typeof props.sessionId === 'string' ? props.sessionId : null
      inputBridge.actions = actions === undefined ? null : actions
      inputBridge.sessionId = sessionId
      useEffect(() => {
        inputBridge.actions = actions === undefined ? null : actions
        inputBridge.sessionId = sessionId
        return () => {
          if (inputBridge.actions === actions) inputBridge.actions = null
          if (inputBridge.sessionId === sessionId) inputBridge.sessionId = null
        }
      }, [actions, sessionId])
      // 窄栏时的横排条会挂进这个节点：它在输入框 dock 的流里，天然不压任何控件。
      return h('div', { className: 'dsw-dock', ref: dockRef })
    }

    function insertIntoComposer(text) {
      const actions = inputBridge.actions
      if (actions === null || actions === undefined) return 'no-composer'
      try {
        const insertion = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined
        if (typeof actions.insertText === 'function') {
          actions.insertText(text, insertion)
          return 'ok'
        }
        if (typeof actions.setDraft === 'function') {
          actions.setDraft(text)
          return 'ok'
        }
      } catch (error) {
        console.warn('[dsh-wingman] 插入输入框失败：', error)
        return 'failed'
      }
      return 'no-composer'
    }

    /* ------------------------------------------------------------ 常用指令面板 */

    /** 快捷时间：把「1 小时后 / 今晚 20:00 / 明天 10:00」算成 datetime-local 字符串。 */
    function quickRemind(key) {
      const now = new Date()
      if (key === 'in1h') now.setHours(now.getHours() + 1)
      if (key === 'tonight') now.setHours(20, 0, 0, 0)
      if (key === 'tomorrow') {
        now.setDate(now.getDate() + 1)
        now.setHours(10, 0, 0, 0)
      }
      const pad = (value) => String(value).padStart(2, '0')
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
    }

    /** 把模型侧的错误翻译成人话；认不出来的原样返回。 */
    function aiErrorText(t, message) {
      const text = typeof message === 'string' ? message : ''
      if (/transport|network|timed? ?out|econn|socket|fetch failed/i.test(text)) return t('aiTransport')
      if (/api ?key|unauthor|401|invalid.*key|forbidden|403/i.test(text)) return t('aiAuth')
      if (text === '') return t('aiFailed')
      return text
    }

    function usesText(t, n) {
      return t('uses', { n })
    }

    function SnippetsPanel(props) {
      const { t, onClose, onInsert, flash } = props
      const [items, setItems] = useState([])
      const [loaded, setLoaded] = useState(false)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [query, setQuery] = useState('')
      const [group, setGroup] = useState('all')
      const [draft, setDraft] = useState(null)
      const [confirmReset, setConfirmReset] = useState(false)

      const load = useCallback(async () => {
        try {
          const response = await fetch(API, { headers: { accept: 'application/json' } })
          const data = await response.json()
          if (data !== null && data !== undefined && data.ok === true) {
            setItems(Array.isArray(data.value?.items) ? data.value.items : [])
            setError(null)
          } else {
            setError(data?.error?.message ?? t('loadFailed'))
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setLoaded(true)
        }
      }, [t])

      useEffect(() => {
        void load()
      }, [load])

      const commit = useCallback(async (nextItems) => {
        setBusy(true)
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'save', items: nextItems }),
          })
          const data = await response.json()
          if (data !== null && data !== undefined && data.ok === true) {
            setItems(Array.isArray(data.value?.items) ? data.value.items : [])
            setError(null)
            return true
          }
          setError(data?.error?.message ?? t('insertFailed'))
          return false
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          return false
        } finally {
          setBusy(false)
        }
      }, [t])

      const markUsed = useCallback(async (id) => {
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'use', id }),
          })
          const data = await response.json()
          if (data !== null && data !== undefined && data.ok === true && Array.isArray(data.value?.items)) {
            setItems(data.value.items)
          }
        } catch {
          // 计数失败不影响插入。
        }
      }, [])

      const groups = useMemo(() => {
        const seen = []
        for (const item of items) {
          const name = item.group
          if (typeof name === 'string' && name !== '' && !seen.includes(name)) seen.push(name)
        }
        return ['all', ...seen]
      }, [items])

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const list = items.filter((item) => {
          if (group !== 'all' && item.group !== group) return false
          if (needle === '') return true
          const haystack = `${item.title}\n${item.body}\n${item.group ?? ''}`.toLowerCase()
          return haystack.includes(needle)
        })
        return list.sort((a, b) => {
          const pinned = (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0)
          if (pinned !== 0) return pinned
          const used = (b.uses ?? 0) - (a.uses ?? 0)
          if (used !== 0) return used
          return String(a.title).localeCompare(String(b.title))
        })
      }, [items, query, group])

      const startNew = useCallback(() => {
        setDraft({ id: null, title: '', group: group === 'all' ? '' : group, body: '' })
      }, [group])

      const startEdit = useCallback((item) => {
        setDraft({ id: item.id, title: item.title, group: item.group ?? '', body: item.body })
      }, [])

      const saveDraft = useCallback(async () => {
        const candidate = draft
        if (candidate === null) return
        const title = candidate.title.trim()
        const body = candidate.body
        if (title === '' && body.trim() === '') return
        const now = Date.now()
        const next = draft.id === null
          ? [...items, { id: `s-${now.toString(36)}-local`, title: title === '' ? body.trim().split('\n')[0].slice(0, 120) : title, group: candidate.group.trim(), body, pinned: false, uses: 0, createdAt: now, updatedAt: now }]
          : items.map((item) => (item.id === draft.id ? { ...item, title: title === '' ? body.trim().split('\n')[0].slice(0, 120) : title, group: candidate.group.trim(), body, updatedAt: now } : item))
        const saved = await commit(next)
        if (saved) {
          setDraft(null)
          flash(t('saved'))
        }
      }, [commit, draft, items, flash, t])

      const removeDraft = useCallback(async () => {
        if (draft === null) return
        const next = items.filter((item) => item.id !== draft.id)
        const saved = await commit(next)
        if (saved) {
          setDraft(null)
          flash(t('deleted'))
        }
      }, [commit, draft, items, flash, t])

      const removeItem = useCallback(async (item) => {
        const next = items.filter((entry) => entry.id !== item.id)
        const saved = await commit(next)
        if (saved) flash(t('deleted'))
      }, [commit, items, flash, t])

      const useItem = useCallback((item) => {
        const text = String(item.body ?? '').split('{光标}').join('')
        const result = onInsert(text)
        if (result === 'ok') {
          void markUsed(item.id)
          flash(t('inserted'))
          onClose()
          return
        }
        flash(result === 'no-composer' ? t('noComposer') : t('insertFailed'))
      }, [onInsert, markUsed, flash, onClose, t])

      if (draft !== null) {
        return h('div', { className: 'dsw-panel__body' },
          h('div', { className: 'dsw-form' },
            h('input', {
              className: 'dsw-input',
              placeholder: t('titleField'),
              value: draft.title,
              autoFocus: true,
              onChange: (event) => setDraft({ ...draft, title: event.target.value }),
            }),
            h('input', {
              className: 'dsw-input',
              placeholder: t('groupField'),
              value: draft.group,
              list: 'dsw-swiss-groups',
              onChange: (event) => setDraft({ ...draft, group: event.target.value }),
            }),
            h('datalist', { id: 'dsw-swiss-groups' },
              groups.filter((name) => name !== 'all').map((name) => h('option', { key: name, value: name })),
            ),
            h('textarea', {
              className: 'dsw-textarea',
              placeholder: t('bodyField'),
              value: draft.body,
              rows: 8,
              onChange: (event) => setDraft({ ...draft, body: event.target.value }),
            }),
            h('div', { className: 'dsw-form__actions' },
              h('button', { type: 'button', className: 'dsw-btn dsw-btn--primary', disabled: busy, onClick: () => { void saveDraft() } }, t('save')),
              h('button', { type: 'button', className: 'dsw-btn', onClick: () => setDraft(null) }, t('cancel')),
              draft.id === null ? null : h('button', { type: 'button', className: 'dsw-btn dsw-btn--danger', onClick: () => { void removeDraft() } }, t('remove')),
            ),
          ),
        )
      }

      return h('div', { className: 'dsw-panel__body' },
        h('div', { className: 'dsw-toolbar' },
          h('input', {
            className: 'dsw-input dsw-input--search',
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', {
            type: 'button',
            className: 'dsw-btn dsw-btn--compact',
            title: t('snippetsReset'),
            onClick: async () => {
              if (confirmReset !== true) {
                setConfirmReset(true)
                window.setTimeout(() => setConfirmReset(false), 3000)
                return
              }
              setConfirmReset(false)
              try {
                const response = await fetch(API, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ op: 'reset' }),
                })
                const payload = await response.json()
                if (payload?.ok === true) {
                  setItems(Array.isArray(payload.value?.items) ? payload.value.items : [])
                  flash(t('snippetsResetDone'))
                }
              } catch {
                // 失败就保持原样。
              }
            },
          }, confirmReset ? t('snippetsResetConfirm') : '↺'),
          h('button', { type: 'button', className: 'dsw-btn dsw-btn--primary dsw-btn--compact', onClick: startNew }, t('newSnippet')),
        ),
        groups.length > 1
          ? h('div', { className: 'dsw-chips' }, groups.map((name) =>
            h('button', {
              key: name,
              type: 'button',
              className: `dsw-chip${group === name ? ' dsw-chip--active' : ''}`,
              onClick: () => setGroup(name),
            }, name === 'all' ? t('all') : name)))
          : null,
        error === null ? null : h('div', { className: 'dsw-error' }, error),
        h('div', { className: 'dsw-list' },
          loaded === false
            ? h('div', { className: 'dsw-empty' }, '…')
            : visible.length === 0
              ? h('div', { className: 'dsw-empty' }, items.length === 0 ? t('empty') : t('emptySearch'))
              : visible.map((item) => h('div', {
                key: item.id,
                className: 'dsw-row',
                role: 'button',
                tabIndex: 0,
                title: item.body,
                onClick: () => useItem(item),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    useItem(item)
                  }
                },
              },
              h('div', { className: 'dsw-row__main' },
                h('div', { className: 'dsw-row__title' },
                  item.pinned === true ? h('span', { className: 'dsw-row__pin', 'aria-hidden': true }, '·') : null,
                  item.title,
                ),
                h('div', { className: 'dsw-row__meta' },
                  item.group ? h('span', { className: 'dsw-row__group' }, item.group) : null,
                  h('span', null, usesText(t, item.uses ?? 0)),
                ),
              ),
              h('div', { className: 'dsw-row__actions' },
                h('button', {
                  type: 'button',
                  className: 'dsw-iconbtn',
                  title: t('edit'),
                  onClick: (event) => {
                    event.stopPropagation()
                    startEdit(item)
                  },
                }, '✎'),
                h('button', {
                  type: 'button',
                  className: 'dsw-iconbtn',
                  title: t('remove'),
                  onClick: (event) => {
                    event.stopPropagation()
                    void removeItem(item)
                  },
                }, '×'),
              ),
            )),
        ),
      )
    }

    /* ------------------------------------------------------------ 看 */

    function formatTokens(value) {
      if (!Number.isFinite(value)) return '—'
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
      return String(Math.round(value))
    }

    function WatchPanel(props) {
      const { t } = props
      const [state, setState] = useState({ loading: true, data: null, error: null })

      const load = useCallback(async (silent = false) => {
        // 静默刷新（面板开着时每 4 秒一次）不置 loading、不把好数据换成错误态，
        // 否则面板会一闪一闪，网络抖一下就整块空掉。
        if (!silent) setState((current) => ({ ...current, loading: true, error: null }))
        try {
          const sessionId = inputBridge.sessionId
          const url = typeof sessionId === 'string' && sessionId !== ''
            ? `${WATCH_API}?sessionId=${encodeURIComponent(sessionId)}`
            : WATCH_API
          const response = await fetch(url, { headers: { accept: 'application/json' } })
          const payload = await response.json()
          if (payload !== null && payload !== undefined && payload.ok === true) {
            setState({ loading: false, data: payload.value, error: null })
          } else if (payload?.error?.code === 'not_found') {
            if (silent) return
            setState({ loading: false, data: null, error: t('watchNeedsRestart') })
          } else {
            if (silent) return
            setState({ loading: false, data: null, error: aiErrorText(t, payload?.error?.message) })
          }
        } catch (failure) {
          if (silent) return
          setState({ loading: false, data: null, error: t('watchNeedsRestart') })
        }
      }, [t])

      useEffect(() => {
        void load()
      }, [load])

      // 面板开着的时候自己更新：子代理跑完、跟进被划掉，用户不用去点「刷新」。
      // 面板一关（组件卸载）就停，后台不轮询。
      useEffect(() => {
        // 注意：本组件后面有个 `const window = ...`（上下文窗口），会遮住全局 window，
        // 所以这里必须用 globalThis 拿定时器。
        const timer = globalThis.setInterval(() => {
          if (document.visibilityState === 'hidden') return
          void load(true)
        }, 4000)
        return () => globalThis.clearInterval(timer)
      }, [load])

      const data = state.data
      const tokens = data?.tokens ?? null
      const model = data?.model ?? null
      const window = model !== null && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null
      const used = tokens !== null && Number.isFinite(tokens.total) ? tokens.total : null
      const percent = used !== null && window !== null ? Math.max(0, Math.min(100, Math.round((used / window) * 100))) : null
      const radius = 26
      const circumference = 2 * Math.PI * radius
      const ringColor = percent === null
        ? 'var(--dsw-alias-border-l2)'
        : percent >= 90
          ? 'var(--dsw-alias-state-error-primary)'
          : percent >= 75
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-primary)'

      // 子代理：running 有值才是「正在跑」；只有 total 时说成「本会话 N 个子代理」，不谎报运行中。
      const subagentText = (() => {
        const info = data?.subagents
        if (info === null || info === undefined) return '—'
        const total = Number.isFinite(info.total) ? info.total : null
        const running = Number.isFinite(info.running) ? info.running : null
        if (running !== null) {
          // 宿主对「external（Codex）子代理」没有 activity 信号，永远报 inactive；
          // 这种情况下把「共 N 个」补在后面，别让用户以为什么都没起。
          if (running > 0) return t('watchRunning', { n: running })
          return total !== null && total > 0
            ? `${t('watchRunning', { n: running })} · ${t('watchTotal', { n: total })}`
            : t('watchRunning', { n: running })
        }
        return total === null ? '—' : t('watchTotal', { n: total })
      })()

      const rows = [
        ['watchModel', model === null ? '—' : `${model.provider ?? ''} · ${model.model ?? ''}`.replace(/^ · /, '')],
        ['watchRound', tokens === null ? '—' : `${t('watchInput')} ${formatTokens(tokens.input)} · ${t('watchOutput')} ${formatTokens(tokens.output)}${tokens.cacheRead !== null ? ` · ${t('watchCache')} ${formatTokens(tokens.cacheRead)}` : ''}`],
        ['watchSubagents', subagentText],
        ['watchFollowups', data?.followups === null || data?.followups === undefined ? '—' : t('watchOpen', { n: data.followups.open })],
      ]

      return h('div', { className: 'dsw-panel__body' },
        h('div', { className: 'dsw-watch' },
          h('div', { className: 'dsw-watch__ring' },
            h('svg', { viewBox: '0 0 64 64', width: 64, height: 64, 'aria-hidden': true },
              h('circle', { cx: 32, cy: 32, r: radius, fill: 'none', stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 6 }),
              h('circle', {
                cx: 32,
                cy: 32,
                r: radius,
                fill: 'none',
                stroke: ringColor,
                strokeWidth: 6,
                strokeLinecap: 'round',
                strokeDasharray: `${circumference} ${circumference}`,
                strokeDashoffset: percent === null ? circumference : circumference * (1 - percent / 100),
                transform: 'rotate(-90 32 32)',
                style: { transition: 'stroke-dashoffset .3s ease' },
              }),
            ),
            h('div', { className: 'dsw-watch__pct' }, percent === null ? '—' : `${percent}%`),
          ),
          h('div', { className: 'dsw-watch__meta' },
            h('div', { className: 'dsw-watch__label' }, t('watchContext')),
            h('div', { className: 'dsw-watch__value' }, used === null || window === null ? '—' : `${formatTokens(used)} / ${formatTokens(window)}`),
            h('div', { className: 'dsw-watch__hint' }, window === null ? t('watchNoWindow') : t('watchWindow', { n: formatTokens(window) })),
          ),
        ),
        state.error === null ? null : h('div', { className: 'dsw-error' }, state.error),
        h('div', { className: 'dsw-watch__rows' }, rows.map(([key, value]) => h('div', { key, className: 'dsw-watch__row' },
          h('span', null, t(key)),
          h('span', { className: 'dsw-watch__val' }, state.loading && key !== 'watchFollowups' ? '…' : value),
        ))),
        h('div', { className: 'dsw-watch__foot' },
          h('span', null, inputBridge.sessionId === null ? t('watchNoSession') : t('updatedAt', { time: new Date().toLocaleTimeString() })),
          h('button', { type: 'button', className: 'dsw-btn dsw-btn--compact', onClick: () => { void load() } }, t('watchRefresh')),
        ),
      )
    }

    /* ------------------------------------------------------------ 记 */

    function NotesPanel(props) {
      const { t, onClose, flash } = props
      const [mode, setMode] = useState('note')
      const [text, setText] = useState('')
      const [due, setDue] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [stats, setStats] = useState(null)

      const [justAdded, setJustAdded] = useState(null)
      const [recent, setRecent] = useState({ notes: [], followups: [] })
      const [remindAt, setRemindAt] = useState('')
      const [reminders, setReminders] = useState([])

      const load = useCallback(async () => {
        const nextStats = { notes: null, open: null }
        const nextRecent = { notes: [], followups: [] }
        try {
          const response = await fetch(NOTE_API, { headers: { accept: 'application/json' } })
          const payload = await response.json()
          const notes = payload?.ok === true && Array.isArray(payload.value?.notes) ? payload.value.notes : null
          if (notes !== null) {
            nextStats.notes = notes.length
            nextRecent.notes = [...notes].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 3)
          }
        } catch {
          // 便签墙不在就算了。
        }
        try {
          const response = await fetch(`${FOLLOWUP_API}/list`, { headers: { accept: 'application/json' } })
          const payload = await response.json()
          const tasks = payload?.ok === true && Array.isArray(payload.value?.tasks) ? payload.value.tasks : null
          if (tasks !== null) {
            const open = tasks.filter((task) => task !== null && typeof task === 'object' && task.done !== true)
            nextStats.open = open.length
            nextRecent.followups = open.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 3)
          }
        } catch {
          // 跟进插件不在就算了。
        }
        try {
          const response = await fetch(REMINDERS_API, { headers: { accept: 'application/json' } })
          const payload = await response.json()
          if (payload?.ok === true && Array.isArray(payload.value?.items)) setReminders(payload.value.items)
        } catch {
          // 提醒服务不在就算了。
        }
        setStats(nextStats)
        setRecent(nextRecent)
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const submit = useCallback(async () => {
        const value = text.trim()
        if (value === '' || busy) return
        setBusy(true)
        setError(null)
        try {
          if (mode === 'reminder') {
            const when = new Date(remindAt).getTime()
            if (!Number.isFinite(when)) throw new Error(t('reminderNeedTime'))
            const response = await fetch(REMINDERS_API, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ op: 'add', text: value, dueAt: when }),
            })
            const payload = await response.json()
            if (payload?.ok !== true) throw new Error(payload?.error?.message ?? 'failed')
            flash(t('reminderSaved'))
            setText('')
            setRemindAt('')
            setJustAdded(null)
            void load()
            return
          }

          if (mode === 'note') {
            const response = await fetch(NOTE_API, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ op: 'add', text: value, color: 'amber' }),
            })
            const payload = await response.json()
            if (payload?.ok !== true) throw new Error(payload?.error?.message ?? 'failed')
            flash(t('noteSaved'))
          } else {
            const response = await fetch(`${FOLLOWUP_API}/add`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                title: value,
                due: due.trim() === '' ? undefined : due.trim(),
                sessionId: inputBridge.sessionId ?? undefined,
              }),
            })
            const payload = await response.json()
            if (payload?.ok !== true) throw new Error(payload?.error?.message ?? 'failed')
            flash(t('followupSaved'))
          }
          setText('')
          setDue('')
          setJustAdded({ kind: mode, text: value })
          void load()
        } catch (failure) {
          const detail = String(failure?.message ?? failure)
          setError(detail === 'failed' || detail.includes('fetch') ? t(mode === 'note' ? 'noteDown' : 'followupDown') : detail)
        } finally {
          setBusy(false)
        }
      }, [text, due, remindAt, mode, busy, onClose, flash, t])

      const onKeyDown = (event) => {
        if (event.key !== 'Enter') return
        if (event.shiftKey) return
        event.preventDefault()
        void submit()
      }

      const statsText = stats === null
        ? ''
        : [
          stats.notes === null ? null : t('noteCount', { n: stats.notes }),
          stats.open === null ? null : t('followupOpen', { n: stats.open }),
        ].filter(Boolean).join(' · ')

      return h('div', { className: 'dsw-panel__body' },
        h('div', { className: 'dsw-seg' },
          h('button', {
            type: 'button',
            className: `dsw-seg__btn${mode === 'note' ? ' dsw-seg__btn--on' : ''}`,
            onClick: () => setMode('note'),
          }, t('noteMode')),
          h('button', {
            type: 'button',
            className: `dsw-seg__btn${mode === 'followup' ? ' dsw-seg__btn--on' : ''}`,
            onClick: () => setMode('followup'),
          }, t('followupMode')),
          h('button', {
            type: 'button',
            className: `dsw-seg__btn${mode === 'reminder' ? ' dsw-seg__btn--on' : ''}`,
            onClick: () => {
              setMode('reminder')
              if (remindAt === '') setRemindAt(quickRemind('in1h'))
            },
          }, t('reminderMode')),
        ),
        h('div', { className: 'dsw-notes' },
          h('textarea', {
            className: 'dsw-notes__text',
            rows: 4,
            autoFocus: true,
            placeholder: mode === 'note' ? t('notePlaceholder') : t('followupPlaceholder'),
            value: text,
            onChange: (event) => setText(event.target.value),
            onKeyDown,
          }),
          mode === 'followup'
            ? h('input', {
              className: 'dsw-input',
              placeholder: t('duePlaceholder'),
              value: due,
              onChange: (event) => setDue(event.target.value),
              onKeyDown,
            })
            : mode === 'reminder'
              ? h('div', { className: 'dsw-remind' },
                h('input', {
                  className: 'dsw-input',
                  type: 'datetime-local',
                  value: remindAt,
                  onChange: (event) => setRemindAt(event.target.value),
                }),
                h('div', { className: 'dsw-remind__chips' },
                  [['in1h', t('reminder1h')], ['tonight', t('reminderTonight')], ['tomorrow', t('reminderTomorrow')]].map(([key, label]) => h('button', {
                    key,
                    type: 'button',
                    className: 'dsw-chip',
                    onClick: () => setRemindAt(quickRemind(key)),
                  }, label)),
                ),
              )
              : null,
          error === null ? null : h('div', { className: 'dsw-error' }, error),
          h('div', { className: 'dsw-notes__actions' },
            h('span', { className: 'dsw-notes__hint' }, t('enterHint')),
            h('button', {
              type: 'button',
              className: 'dsw-btn dsw-btn--primary',
              disabled: busy || text.trim() === '',
              onClick: () => { void submit() },
            }, mode === 'note' ? t('saveNote') : mode === 'followup' ? t('saveFollowup') : t('reminderSave')),
          ),
          justAdded === null
            ? null
            : h('div', { className: 'dsw-notes__added' },
              t(justAdded.kind === 'note' ? 'justAddedNote' : 'justAddedFollowup', { text: justAdded.text.slice(0, 40) })),
          mode === 'reminder'
            ? h('div', { className: 'dsw-notes__section' }, t('reminderUpcoming'))
            : h('div', { className: 'dsw-notes__section' }, t(mode === 'note' ? 'recentNotes' : 'recentFollowups')),
          mode === 'reminder'
            ? (reminders.filter((item) => item.done !== true).length === 0
              ? h('div', { className: 'dsw-notes__empty' }, t('reminderEmpty'))
              : reminders.filter((item) => item.done !== true).slice(0, 5).map((item) => h('div', { key: item.id, className: 'dsw-notes__item' },
                h('span', { className: 'dsw-notes__itemtext' }, item.text),
                h('span', { className: 'dsw-notes__due' }, new Date(item.dueAt).toLocaleString()),
                h('button', {
                  type: 'button',
                  className: 'dsw-iconbtn',
                  title: t('reminderDone'),
                  onClick: async () => {
                    await fetch(REMINDERS_API, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ op: 'done', id: item.id }),
                    })
                    void load()
                  },
                }, '✓'),
              )))
            : null,
          mode === 'reminder'
            ? null
            : (mode === 'note' ? recent.notes : recent.followups).length === 0
            ? h('div', { className: 'dsw-notes__empty' }, t('recentEmpty'))
            : (mode === 'note' ? recent.notes : recent.followups).map((item, index) => h('div', { className: 'dsw-notes__item', key: `${mode}-${index}` },
              h('span', { className: 'dsw-notes__itemtext' }, String(item.text ?? item.title ?? '').slice(0, 44)),
              item.dueAt ? h('span', { className: 'dsw-notes__due' }, new Date(item.dueAt).toLocaleDateString()) : null,
            )),
          statsText === '' ? null : h('div', { className: 'dsw-notes__stats' }, statsText),
        ),
      )
    }

    /* ------------------------------------------------------------ 转 */

    function TransformPanel(props) {
      const { t, text, onInsert, onClose, flash } = props
      const excerpt = String(text ?? '').trim()
      const [busy, setBusy] = useState('')
      const [ai, setAi] = useState({ action: '', result: '', error: null })
      const [commentMode, setCommentMode] = useState(false)
      const [comment, setComment] = useState('')

      const saveAsSnippet = useCallback(async (body, group, fallbackTitle) => {
        const current = await fetch(API, { headers: { accept: 'application/json' } })
        const currentPayload = await current.json()
        const items = currentPayload?.ok === true && Array.isArray(currentPayload.value?.items) ? currentPayload.value.items : []
        const firstLine = String(body).trim().split('\n')[0].slice(0, 40) || fallbackTitle
        const now = Date.now()
        const next = [...items, {
          id: `s-${now.toString(36)}-sel`,
          title: firstLine,
          group,
          body: String(body),
          pinned: false,
          uses: 0,
          createdAt: now,
          updatedAt: now,
        }]
        const response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'save', items: next }),
        })
        const payload = await response.json()
        if (payload?.ok !== true) throw new Error(payload?.error?.message ?? 'failed')
      }, [])

      const saveNote = useCallback(async () => {
        setBusy('note')
        try {
          const response = await fetch(NOTE_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'add', text: `${excerpt}\n\n—— 摘自对话`, color: 'sky', category: '摘录' }),
          })
          const payload = await response.json()
          if (payload?.ok !== true) throw new Error(payload?.error?.message ?? 'failed')
          flash(t('transformNoteSaved'))
          onClose()
        } catch {
          flash(t('noteDown'))
        } finally {
          setBusy('')
        }
      }, [excerpt, flash, onClose, t])

      const saveSnippet = useCallback(async () => {
        setBusy('snippet')
        try {
          await saveAsSnippet(excerpt, '摘录', '摘录')
          flash(t('transformSnippetSaved'))
          onClose()
        } catch {
          flash(t('transformSnippetFailed'))
        } finally {
          setBusy('')
        }
      }, [excerpt, saveAsSnippet, flash, onClose, t])

      const quoteIt = useCallback(() => {
        const quoted = excerpt.split('\n').map((line) => `> ${line}`).join('\n')
        const result = onInsert(`${quoted}\n\n`)
        flash(result === 'ok' ? t('transformQuoted') : t('noComposer'))
        if (result === 'ok') {
          onClose()
        }
      }, [excerpt, onInsert, flash, onClose, t])

      const quoteWithComment = useCallback(() => {
        const quoted = excerpt.split('\n').map((line) => `> ${line}`).join('\n')
        const words = comment.trim()
        const text = words === '' ? `${quoted}\n\n` : `${quoted}\n\n${words}\n\n`
        const result = onInsert(text)
        flash(result === 'ok' ? t('transformQuoted') : t('noComposer'))
        if (result === 'ok') {
          setComment('')
          setCommentMode(false)
          onClose()
        }
      }, [excerpt, comment, onInsert, flash, onClose, t])

      const saveFollowup = useCallback(async () => {
        setBusy('followup')
        try {
          const title = excerpt.split('\n')[0].slice(0, 80) || '来自对话的跟进'
          const response = await fetch(`${FOLLOWUP_API}/add`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              title,
              note: excerpt.slice(0, 2000),
              sessionId: inputBridge.sessionId ?? undefined,
            }),
          })
          const payload = await response.json()
          if (payload?.ok !== true) throw new Error(payload?.error?.message ?? 'failed')
          flash(t('transformFollowupSaved'))
          onClose()
        } catch {
          flash(t('followupDown'))
        } finally {
          setBusy('')
        }
      }, [excerpt, flash, onClose, t])

      const copyIt = useCallback(async (value, doneKey) => {
        try {
          await navigator.clipboard.writeText(value)
          flash(t(doneKey))
        } catch {
          flash(t('transformCopyFailed'))
        }
      }, [flash, t])

      const runAi = useCallback(async (action) => {
        setBusy(action)
        setAi({ action, result: '', error: null })
        try {
          const response = await fetch(TRANSFORM_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: inputBridge.sessionId ?? undefined,
              action,
              text: excerpt,
            }),
          })
          const payload = await response.json()
          if (payload?.ok === true) {
            setAi({ action, result: String(payload.value?.text ?? ''), error: null })
          } else {
            setAi({ action, result: '', error: aiErrorText(t, payload?.error?.message) })
          }
        } catch {
          setAi({ action, result: '', error: t('transformFailed') })
        } finally {
          setBusy('')
        }
      }, [excerpt, t])

      if (excerpt === '') {
        return h('div', { className: 'dsw-panel__body' }, h('div', { className: 'dsw-empty' }, t('transformEmpty')))
      }

      const aiActions = [
        ['prompt', t('transformPrompt')],
        ['summary', t('transformSummary')],
        ['explain', t('transformExplain')],
        ['tests', t('transformTests')],
        ['translate', t('transformTranslate')],
        ['translateEn', t('transformTranslateEn')],
      ]

      return h('div', { className: 'dsw-panel__body' },
        h('div', { className: 'dsw-transform' },
          h('div', { className: 'dsw-transform__quote' }, excerpt.length > 400 ? `${excerpt.slice(0, 400)}…` : excerpt),
          h('div', { className: 'dsw-transform__count' }, t('transformChars', { n: excerpt.length })),
          h('div', { className: 'dsw-transform__section' }, t('transformDialog')),
          h('div', { className: 'dsw-transform__actions' },
            h('button', { type: 'button', className: 'dsw-btn', disabled: busy !== '', onClick: quoteIt }, t('transformQuote')),
            h('button', {
              type: 'button',
              className: `dsw-btn${commentMode ? ' dsw-btn--primary' : ''}`,
              disabled: busy !== '',
              onClick: () => setCommentMode((current) => !current),
            }, t('transformQuoteComment')),
          ),
          commentMode
            ? h('div', { className: 'dsw-transform__comment' },
              h('textarea', {
                className: 'dsw-notes__text',
                rows: 2,
                autoFocus: true,
                placeholder: t('transformCommentPlaceholder'),
                value: comment,
                onChange: (event) => setComment(event.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'dsw-btn dsw-btn--primary dsw-btn--compact',
                disabled: busy !== '',
                onClick: quoteWithComment,
              }, t('transformInsertComment')),
            )
            : null,
          h('div', { className: 'dsw-transform__section' }, t('transformKeep')),
          h('div', { className: 'dsw-transform__actions' },
            h('button', { type: 'button', className: 'dsw-btn', disabled: busy !== '', onClick: () => { void saveNote() } }, t('transformNote')),
            h('button', { type: 'button', className: 'dsw-btn', disabled: busy !== '', onClick: () => { void saveSnippet() } }, t('transformSnippet')),
            h('button', { type: 'button', className: 'dsw-btn', disabled: busy !== '', onClick: () => { void copyIt(excerpt, 'transformCopied') } }, t('transformCopy')),
            h('button', { type: 'button', className: 'dsw-btn', disabled: busy !== '', onClick: () => { void saveFollowup() } }, t('transformFollowup')),
          ),
          h('div', { className: 'dsw-transform__section' }, t('transformAi')),
          h('div', { className: 'dsw-transform__actions' }, aiActions.map(([key, label]) => h('button', {
            key,
            type: 'button',
            className: 'dsw-btn dsw-btn--compact',
            disabled: busy !== '',
            onClick: () => { void runAi(key) },
          }, busy === key ? t('transformThinking') : label))),
          ai.error === null ? null : h('div', { className: 'dsw-error' }, ai.error),
          ai.result === '' ? null : h('div', { className: 'dsw-transform__result' },
            h('div', { className: 'dsw-transform__resultbody' }, ai.result),
            h('div', { className: 'dsw-transform__actions dsw-transform__actions--end' },
              h('button', { type: 'button', className: 'dsw-btn', onClick: () => { void copyIt(ai.result, 'transformCopiedResult') } }, t('transformCopy')),
              h('button', {
                type: 'button',
                className: 'dsw-btn',
                onClick: async () => {
                  try {
                    await saveAsSnippet(ai.result, '改写', '改写结果')
                    flash(t('transformSnippetSaved'))
                  } catch {
                    flash(t('transformSnippetFailed'))
                  }
                },
              }, t('transformResultSave')),
              h('button', {
                type: 'button',
                className: 'dsw-btn dsw-btn--primary',
                onClick: () => {
                  const result = onInsert(`${ai.result}\n\n`)
                  flash(result === 'ok' ? t('transformQuoted') : t('noComposer'))
                  if (result === 'ok') onClose()
                },
              }, t('transformInsert')),
            ),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------ 说到哪了 */

    const RECAP_CACHE = new Map()




    /* ------------------------------------------------------------ 自定义入口 */

    function CustomPanel(props) {
      const { t, entry, flash } = props
      const [state, setState] = useState({ running: false, output: '', ok: null })

      const run = useCallback(async () => {
        setState({ running: true, output: '', ok: null })
        try {
          const response = await fetch(RUN_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: entry.id }),
          })
          const payload = await response.json()
          if (payload?.ok === true) {
            setState({ running: false, output: String(payload.value?.output ?? ''), ok: payload.value?.ok === true })
          } else {
            setState({ running: false, output: payload?.error?.message ?? t('customRunFailed'), ok: false })
          }
        } catch {
          setState({ running: false, output: t('customRunFailed'), ok: false })
        }
      }, [entry.id, t])

      return h('div', { className: 'dsw-panel__body' },
        h('div', { className: 'dsw-custom' },
          h('div', { className: 'dsw-custom__meta' },
            h('span', { className: 'dsw-custom__kind' }, entry.kind === 'open' ? t('customKindOpen') : t('customKindRun')),
            h('code', { className: 'dsw-custom__target' }, entry.target),
          ),
          entry.cwd ? h('div', { className: 'dsw-custom__cwd' }, t('customCwd', { path: entry.cwd })) : null,
          h('div', { className: 'dsw-custom__actions' },
            h('button', {
              type: 'button',
              className: 'dsw-btn dsw-btn--primary',
              disabled: state.running,
              onClick: () => { void run() },
            }, state.running ? t('customRunning') : t('customRun')),
          ),
          state.output === '' ? null : h('pre', { className: `dsw-custom__output${state.ok === false ? ' dsw-custom__output--bad' : ''}` }, state.output),
        ),
      )
    }


    /* ------------------------------------------------------------ 会话小结 */

    function SummaryPanel(props) {
      const { t, onInsert, onClose, flash } = props
      const sessionId = inputBridge.sessionId
      const [mode, setMode] = useState('current')
      const [state, setState] = useState({ loading: false, text: '', error: null })

      const run = useCallback(async (which) => {
        setState({ loading: true, text: '', error: null })
        const api = which === 'previous' ? TAIL_API : RECAP_API
        try {
          const response = await fetch(api, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const payload = await response.json()
          if (payload?.ok === true) {
            setState({ loading: false, text: typeof payload.value?.text === 'string' ? payload.value.text : '', error: null })
          } else {
            setState({ loading: false, text: '', error: aiErrorText(t, payload?.error?.message) })
          }
        } catch {
          setState({ loading: false, text: '', error: t('summaryFailed') })
        }
      }, [sessionId, t])

      useEffect(() => {
        void run(mode)
      }, [])

      const pick = (next) => {
        setMode(next)
        void run(next)
      }

      return h('div', { className: 'dsw-panel__body' },
        h('div', { className: 'dsw-summary' },
          h('div', { className: 'dsw-seg' },
            h('button', {
              type: 'button',
              className: `dsw-seg__btn${mode === 'current' ? ' dsw-seg__btn--on' : ''}`,
              onClick: () => pick('current'),
            }, t('summaryCurrent')),
            h('button', {
              type: 'button',
              className: `dsw-seg__btn${mode === 'previous' ? ' dsw-seg__btn--on' : ''}`,
              onClick: () => pick('previous'),
            }, t('summaryPrevious')),
          ),
          state.loading
            ? h('div', { className: 'dsw-empty' }, t('summaryWorking'))
            : state.error !== null
              ? h('div', { className: 'dsw-error' }, state.error)
              : state.text === ''
                ? h('div', { className: 'dsw-empty' }, t('summaryEmpty'))
                : h('div', { className: 'dsw-summary__text' }, state.text),
          h('div', { className: 'dsw-summary__actions' },
            h('button', { type: 'button', className: 'dsw-btn dsw-btn--compact', onClick: () => { void run(mode) } }, t('recapRegenerate')),
            h('button', {
              type: 'button',
              className: 'dsw-btn dsw-btn--primary dsw-btn--compact',
              disabled: state.text === '',
              onClick: () => {
                const result = onInsert(`${state.text}\n\n`)
                if (result === 'ok') {
                  flash(t('summaryInserted'))
                  onClose()
                } else {
                  flash(t('noComposer'))
                }
              },
            }, t('summaryInsert')),
          ),
        ),
      )
    }


    /* ------------------------------------------------------------ 更多 */

    const BLADES = [
      {
        id: 'notes',
        order: 10,
        mark: '✎',
        title: { zh: '速记', en: 'Note' },
        short: { zh: '随手写一句，存成便签或跟进', en: 'One line to a note or a follow-up' },
        body: { zh: '一行速记成便签、一行速加成跟进，面板自动收回；与便签墙、跟进共用同一份数据。', en: 'One line to a sticky note or a follow-up, then the panel closes itself; shares data with the sticky wall and follow-ups.' },
        state: 'live',
        tone: 'amber',
      },
      {
        id: 'snippets',
        order: 30,
        mark: '❝',
        title: { zh: '常用指令', en: 'Snippets' },
        short: { zh: '存起来的常用说法，点一下插进输入框', en: 'Saved prompts, one click into the composer' },
        body: { zh: '把常用的指令存起来，点一下插进输入框。', en: 'Save the prompts you retype; one click puts them in the composer.' },
        state: 'live',
        tone: 'blue',
      },
      {
        id: 'transform',
        order: 20,
        mark: '✦',
        title: { zh: '选中文字', en: 'Process' },
        short: { zh: '选中一段后：引用、存下来、或交给模型', en: 'Selection: save, quote or hand to the model' },
        body: { zh: '选中一段：存成便签或常用指令、引用插入、复制，或交给模型改写成指令 / 提炼要点 / 译成中文。', en: 'Selection to note, snippet, quote or copy — or hand it to the model to rewrite, summarise or translate.' },
        state: 'live',
        tone: 'sage',
      },
      {
        id: 'summary',
        order: 40,
        mark: '≡',
        title: { zh: '会话小结', en: 'Summary' },
        short: { zh: '这轮讲了什么，或从上一个会话接到哪', en: 'Recap this thread, or resume the last one' },
        body: { zh: '两个按钮：总结当前会话，或从上一个有内容的会话接一句开场。', en: 'Two buttons: summarise this thread, or pick up the previous one.' },
        state: 'live',
        tone: 'rose',
      },
      {
        id: 'watch',
        order: 90,
        mark: '◔',
        title: { zh: '对话状态', en: 'Status' },
        short: { zh: '这段对话占了多少、在跑什么、还有几条跟进', en: 'Context, tokens, subagents, follow-ups' },
        body: { zh: '上下文占用环、未完成跟进数；一屏看本轮 token、运行中的子代理。', en: 'Context ring and open follow-ups; one screen for this round\'s tokens and running subagents.' },
        state: 'live',
        tone: 'slate',
      },
    ]

    /** 入口色板：一个入口一个色，按入口自己的 tone 取；不按渲染顺序临时分配。 */
    const TONES = {
      amber: '#f6d993',
      sage: '#c4e3b6',
      blue: '#bed7f5',
      rose: '#eecbdb',
      slate: '#d3dae6',
      lavender: '#ded5f1',
      gray: '#dadde0',
    }

    /** 只有真正能点的入口才占颜色；规划中的留在「更多」里。 */
    const LIVE_BLADES = BLADES.filter((item) => item.state === 'live').sort((a, b) => a.order - b.order)

    /** 默认按「使用频次」排；用户在「更多」里调过的顺序存在 Cookie 里。 */
    const ORDER_VERSION = 2
    const DEFAULT_ORDER = LIVE_BLADES.map((item) => item.id)

    function normalizeOrder(raw) {
      const list = Array.isArray(raw) ? raw.filter((id) => DEFAULT_ORDER.includes(id)) : []
      for (const id of DEFAULT_ORDER) {
        if (list.includes(id)) continue
        // 新入口插在「默认顺序里它前面那个」后面，而不是一律甩到末尾
        const defaultIndex = DEFAULT_ORDER.indexOf(id)
        let insertAt = list.length
        for (let i = defaultIndex - 1; i >= 0; i -= 1) {
          const at = list.indexOf(DEFAULT_ORDER[i])
          if (at >= 0) {
            insertAt = at + 1
            break
          }
        }
        list.splice(insertAt, 0, id)
      }
      return list
    }

    /** 齿轮的 8 条短齿：从半径 5.1 伸到 7.1，贴着厚环，避免看起来像太阳。 */
    const GEAR_TEETH = (() => {
      const parts = []
      for (let index = 0; index < 8; index += 1) {
        const angle = (Math.PI / 4) * index - Math.PI / 2
        const inner = 5.1
        const outer = 7.1
        parts.push(`M${(8 + Math.cos(angle) * inner).toFixed(2)} ${(8 + Math.sin(angle) * inner).toFixed(2)}L${(8 + Math.cos(angle) * outer).toFixed(2)} ${(8 + Math.sin(angle) * outer).toFixed(2)}`)
      }
      return parts.join('')
    })()

    const VERSION = '1.0.2'

    function EyeIcon(props) {
      return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M1.6 8s2.4-4 6.4-4 6.4 4 6.4 4-2.4 4-6.4 4-6.4-4-6.4-4z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('circle', { cx: 8, cy: 8, r: 1.8, fill: 'currentColor' }),
        props.off === true ? h('path', { d: 'M2.6 13.4L13.4 2.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }) : null,
      )
    }

    function MorePanel(props) {
      const {
        t, locale, onPick, onMoveTo, blades, hidden, onToggleHidden,
        snap, onToggleSnap, onResetPosition, customItems, onCustomReload, onResetAll,
      } = props
      const [formOpen, setFormOpen] = useState(false)
      const [draft, setDraft] = useState({ name: '', kind: 'open', target: '', cwd: '' })
      const [customBusy, setCustomBusy] = useState(false)
      const [customError, setCustomError] = useState(null)
      const [confirmAll, setConfirmAll] = useState(false)

      const saveCustom = async () => {
        if (draft.name.trim() === '' || draft.target.trim() === '') {
          setCustomError(t('customNeedFields'))
          return
        }
        setCustomBusy(true)
        setCustomError(null)
        try {
          const response = await fetch(CUSTOM_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              op: 'save',
              items: [...customItems, { name: draft.name.trim(), kind: draft.kind, target: draft.target.trim(), cwd: draft.cwd.trim() }],
            }),
          })
          const payload = await response.json()
          if (payload?.ok === true) {
            setDraft({ name: '', kind: 'open', target: '', cwd: '' })
            setFormOpen(false)
            await onCustomReload()
          } else if (payload?.error?.code === 'not_found') {
            setCustomError(t('customNeedsRestart'))
          } else {
            setCustomError(payload?.error?.message ?? t('customSaveFailed'))
          }
        } catch {
          setCustomError(t('customNeedsRestart'))
        } finally {
          setCustomBusy(false)
        }
      }

      const deleteCustom = async (id) => {
        setCustomBusy(true)
        try {
          await fetch(CUSTOM_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'delete', id }),
          })
          await onCustomReload()
        } catch {
          // 忽略。
        } finally {
          setCustomBusy(false)
        }
      }
      const rowRefs = useRef([])
      const pressRef = useRef(null)
      const suppressClick = useRef(false)
      const [dragId, setDragId] = useState(null)

      const beginPress = (entryId, index, event) => {
        if (event.button !== 0) return
        // 不 preventDefault，否则点击打开也会被拦；改用 CSS 的 user-select 挡选中
        try {
          const selection = window.getSelection()
          if (selection !== null && selection !== undefined) selection.removeAllRanges()
        } catch {
          // 清不掉也没关系。
        }
        pressRef.current = { id: entryId, index, startY: event.clientY, timer: null, active: false }
        pressRef.current.timer = window.setTimeout(() => {
          const state = pressRef.current
          if (state === null) return
          state.active = true
          setDragId(entryId)
        }, 160)
      }

      const onPointerMove = (event) => {
        const state = pressRef.current
        if (state === null) return
        if (!state.active) {
          if (Math.abs(event.clientY - state.startY) > 10) {
            window.clearTimeout(state.timer)
            pressRef.current = null
          }
          return
        }
        let target = state.index
        rowRefs.current.forEach((element, index) => {
          if (element === null || element === undefined) return
          const rect = element.getBoundingClientRect()
          if (event.clientY >= rect.top && event.clientY <= rect.bottom) target = index
        })
        if (target !== state.index) {
          onMoveTo(state.id, target)
          state.index = target
        }
      }

      const endPress = () => {
        const state = pressRef.current
        if (state !== null) {
          window.clearTimeout(state.timer)
          if (state.active) suppressClick.current = true
        }
        pressRef.current = null
        setDragId(null)
      }

      const openEntry = (entryId) => {
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        onPick(entryId)
      }

      return h('div', { className: 'dsw-panel__body' },
        h('div', { className: 'dsw-more' },
          h('div', { className: 'dsw-more__label' }, t('moreAvailable')),
          h('div', { className: 'dsw-more__list' },
            blades.map((entry, index) => h('div', {
              key: entry.id,
              ref: (element) => { rowRefs.current[index] = element },
              className: `dsw-more__row${dragId === entry.id ? ' dsw-more__row--dragging' : ''}${hidden.includes(entry.id) ? ' dsw-more__row--hidden' : ''}`,
              onPointerDown: (event) => beginPress(entry.id, index, event),
              onPointerMove,
              onPointerUp: endPress,
              onPointerCancel: endPress,
              onClick: () => openEntry(entry.id),
            },
            dragId === entry.id
              ? h('span', { className: 'dsw-more__hint', 'aria-hidden': true },
                h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, style: { display: 'block' } },
                  h('path', { d: 'M4.8 7.2L8 4l3.2 3.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                  h('path', { d: 'M4.8 8.8L8 12l3.2-3.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                ),
              )
              : h('span', { className: `dsw-more__dot dsw-more__dot--${entry.tone}`, 'aria-hidden': true }),
            h('span', { className: 'dsw-more__name' }, entry.title[locale] ?? entry.title.zh),
            h('span', { className: 'dsw-more__desc' }, entry.short[locale] ?? entry.short.zh),
            h('button', {
              type: 'button',
              className: 'dsw-more__eye',
              title: hidden.includes(entry.id) ? t('moreShow') : t('moreHide'),
              onClick: (event) => {
                event.stopPropagation()
                onToggleHidden(entry.id)
              },
            }, h(EyeIcon, { off: hidden.includes(entry.id) })),
            )),
          ),
          h('div', { className: 'dsw-more__label' }, t('moreSettings')),
          h('div', { className: 'dsw-more__list' },
            h('div', { className: 'dsw-more__row dsw-more__row--static' },
              h('span', { className: 'dsw-more__name' }, t('moreSnap')),
              h('button', {
                type: 'button',
                className: `dsw-switch${snap ? ' dsw-switch--on' : ''}`,
                'aria-pressed': snap,
                title: snap ? t('unsnap') : t('snap'),
                onClick: onToggleSnap,
              }, h('span', { className: 'dsw-switch__knob' })),
            ),
            h('div', { className: 'dsw-more__row dsw-more__row--static' },
              h('span', { className: 'dsw-more__name' }, t('moreReset')),
              h('button', { type: 'button', className: 'dsw-btn dsw-btn--compact', onClick: onResetPosition }, t('moreResetAction')),
            ),
            h('div', { className: 'dsw-more__row dsw-more__row--static' },
              h('span', { className: 'dsw-more__name' }, t('moreResetAll')),
              h('button', {
                type: 'button',
                className: 'dsw-btn dsw-btn--compact',
                onClick: async () => {
                  if (confirmAll !== true) {
                    setConfirmAll(true)
                    window.setTimeout(() => setConfirmAll(false), 3000)
                    return
                  }
                  setConfirmAll(false)
                  onResetAll()
                },
              }, confirmAll ? t('moreResetAllConfirm') : t('moreResetAllAction')),
            ),
          ),
          h('div', { className: 'dsw-more__label' }, t('customTitle')),
          h('div', { className: 'dsw-more__list' },
            customItems.length === 0 && !formOpen
              ? h('div', { className: 'dsw-notes__empty' }, t('customEmpty'))
              : customItems.map((item) => h('div', { key: item.id, className: 'dsw-more__row dsw-more__row--static' },
                h('span', { className: 'dsw-more__name' }, item.name),
                h('span', { className: 'dsw-more__desc' }, item.kind === 'open' ? t('customKindOpen') : t('customKindRun')),
                h('button', {
                  type: 'button',
                  className: 'dsw-more__eye',
                  title: t('customDelete'),
                  onClick: () => { void deleteCustom(item.id) },
                }, '×'),
              )),
            formOpen
              ? h('div', { className: 'dsw-customform' },
                h('input', {
                  className: 'dsw-input',
                  placeholder: t('customName'),
                  value: draft.name,
                  onChange: (event) => setDraft({ ...draft, name: event.target.value }),
                }),
                h('select', {
                  className: 'dsw-input',
                  value: draft.kind,
                  onChange: (event) => setDraft({ ...draft, kind: event.target.value }),
                },
                h('option', { value: 'open' }, t('customKindOpen')),
                h('option', { value: 'run' }, t('customKindRun')),
                ),
                h('input', {
                  className: 'dsw-input',
                  placeholder: t('customTarget'),
                  value: draft.target,
                  onChange: (event) => setDraft({ ...draft, target: event.target.value }),
                }),
                h('input', {
                  className: 'dsw-input',
                  placeholder: t('customCwdInput'),
                  value: draft.cwd,
                  onChange: (event) => setDraft({ ...draft, cwd: event.target.value }),
                }),
                customError === null ? null : h('div', { className: 'dsw-error' }, customError),
                h('div', { className: 'dsw-customform__actions' },
                  h('button', { type: 'button', className: 'dsw-btn dsw-btn--compact', onClick: () => setFormOpen(false) }, t('customCancel')),
                  h('button', {
                    type: 'button',
                    className: 'dsw-btn dsw-btn--primary dsw-btn--compact',
                    disabled: customBusy,
                    onClick: () => { void saveCustom() },
                  }, t('customSave')),
                ),
              )
              : h('button', {
                type: 'button',
                className: 'dsw-btn dsw-btn--compact',
                onClick: () => setFormOpen(true),
              }, t('customAdd')),
          ),
          h('div', { className: 'dsw-more__foot' }, `v${VERSION}`),
        ),
      )
    }

    /* ------------------------------------------------------------ 细条 */

    function RailView(props = {}) {
      const locale = useMemo(() => localeIdOf(null), [])
      const t = useMemo(() => makeT(null, locale), [locale])

      const [open, setOpen] = useState(false)
      const [blade, setBlade] = useState(() => readStore().blade ?? 'snippets')
      const [pinned, setPinned] = useState(() => readJsonFlag(PIN_KEY, false))
      const [position, setPosition] = useState(loadPos)
      const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia(COMPACT_QUERY).matches)
      // compact 横排时贴在侧栏右缘外侧：侧栏收起是 56px，展开是 280px，
      // 写死一个 left 一定会撞上其中一种状态（这正是「压住宿主账号菜单」的根因）。
      const [compactInset, setCompactInset] = useState(COMPACT_INSET)
      // 窄栏时横排条要挂进输入框 dock；dock 由 InputBridge 在另一处渲染，所以轮询等它就位。
      const [dockNode, setDockNode] = useState(null)
      /** 窄栏且 dock 容器就位时，横排条挂进输入框 dock（在流里），不再浮层定位。 */
      const docked = compact && dockNode !== null && dockNode.isConnected !== false
      const [order, setOrder] = useState(() => {
        const stored = readStore()
        if (stored.orderVersion === ORDER_VERSION) return normalizeOrder(stored.order)
        // 版本对不上：按新频率顺序重置一次，避免旧顺序挡住新的默认排序
        writeStore({ order: DEFAULT_ORDER, orderVersion: ORDER_VERSION })
        return DEFAULT_ORDER
      })
      const [hidden, setHidden] = useState(() => {
        const raw = readStore().hidden
        return Array.isArray(raw) ? raw.filter((id) => DEFAULT_ORDER.includes(id)) : []
      })
      const [customItems, setCustomItems] = useState([])

      const loadCustom = useCallback(async () => {
        try {
          const response = await fetch(CUSTOM_API, { headers: { accept: 'application/json' } })
          const payload = await response.json()
          if (payload?.ok === true && Array.isArray(payload.value?.items)) setCustomItems(payload.value.items)
        } catch {
          // 没有自定义入口就不显示。
        }
      }, [])

      useEffect(() => {
        void loadCustom()
      }, [loadCustom])

      const ordered = useMemo(() => order.map((id) => BLADES.find((item) => item.id === id)).filter((item) => item !== undefined), [order])
      const blades = useMemo(() => ordered.filter((item) => !hidden.includes(item.id)), [ordered, hidden])

      const stripAll = useMemo(() => {
        const custom = customItems.map((item) => ({
          id: item.id,
          custom: true,
          kind: item.kind,
          tone: 'lavender',
          mark: '',
          title: { zh: item.name, en: item.name },
          short: { zh: item.kind === 'open' ? '打开路径' : '运行命令', en: item.kind === 'open' ? 'Open path' : 'Run command' },
        }))
        return [...blades, ...custom]
      }, [blades, customItems])
      const [toast, setToast] = useState('')
      const [snap, setSnap] = useState(() => readJsonFlag(SNAP_KEY, true))
      const [snapOffset, setSnapOffset] = useState(() => readNumber(SNAP_OFFSET_KEY, 0))
      const [edge, setEdge] = useState(null)
      const [dragging, setDragging] = useState(false)
      const [guide, setGuide] = useState(null)
      const [panelSizes, setPanelSizes] = useState(() => readPanelSizes())
      const [tip, setTip] = useState(null)
      const [railPinned, setRailPinned] = useState(() => readJsonFlag(RAIL_PIN_KEY, false))
      const [railHidden, setRailHidden] = useState(() => readJsonFlag(RAIL_HIDDEN_KEY, false))
      const [selection, setSelection] = useState('')
      const [transformText, setTransformText] = useState('')

      const railRef = useRef(null)
      const panelRef = useRef(null)
      const toastTimer = useRef(null)
      const livePos = useRef({ left: position.left, top: position.top })

      const flash = useCallback((message) => {
        setToast(message)
        if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
        toastTimer.current = window.setTimeout(() => {
          setToast('')
          toastTimer.current = null
        }, 1800)
      }, [])

      // 收起 / 叫回整条工具条：× 之后贴边只留一枚小箭头，点它回来。
      // 不做「关掉就彻底没了」——工具条是唯一入口，没收入口的关闭就是把用户关在门外。
      const hideRail = useCallback(() => {
        setOpen(false)
        setRailHidden(true)
        writeFlag(RAIL_HIDDEN_KEY, true)
        flash(t('railHidden'))
      }, [flash, t])

      const showRail = useCallback(() => {
        setRailHidden(false)
        writeFlag(RAIL_HIDDEN_KEY, false)
        flash(t('railRestored'))
      }, [flash, t])

      useEffect(() => () => {
        if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
      }, [])

      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const query = window.matchMedia(COMPACT_QUERY)
        const onChange = () => setCompact(query.matches)
        query.addEventListener('change', onChange)
        return () => query.removeEventListener('change', onChange)
      }, [])


      useEffect(() => {
        if (!compact) {
          setDockNode(null)
          return undefined
        }
        const pick = () => {
          const node = dockHost.node
          if (node === null || node.isConnected === false) return
          setDockNode((current) => (current === node ? current : node))
        }
        pick()
        // 切换会话/宿主重排都会换掉 dock 节点，所以要一直跟，不能只找一次。
        const timer = globalThis.setInterval(pick, 400)
        return () => globalThis.clearInterval(timer)
      }, [compact])

      // compact（≤1100px）时实时跟侧栏右缘：侧栏折叠/展开都会改边；
      // 只跟这条边的位置走，不碰宿主的布局。
      useEffect(() => {
        if (!compact) return undefined
        let alive = true
        const measure = () => {
          if (!alive) return
          const found = measureEdge([railRef.current, panelRef.current])
          if (found === null) return
          if (found < 40 || found > window.innerWidth * 0.45) return
          setCompactInset(Math.max(COMPACT_INSET, Math.round(found + 4)))
        }
        measure()
        const timer = window.setInterval(measure, 800)
        window.addEventListener('resize', measure)
        return () => {
          alive = false
          window.clearInterval(timer)
          window.removeEventListener('resize', measure)
        }
      }, [compact])

      // 到点提醒：每 30 秒看一次，只提示一次
      useEffect(() => {
        const notified = new Set()
        const check = async () => {
          try {
            const response = await fetch(REMINDERS_API, { headers: { accept: 'application/json' } })
            const payload = await response.json()
            if (payload?.ok !== true) return
            const now = Date.now()
            for (const item of payload.value?.items ?? []) {
              if (item === null || item === undefined || item.done === true) continue
              if (!Number.isFinite(item.dueAt) || item.dueAt > now) continue
              if (notified.has(item.id)) continue
              notified.add(item.id)
              flash(`⏰ ${item.text}`)
            }
          } catch {
            // 提醒服务不在就算了。
          }
        }
        void check()
        const timer = window.setInterval(check, 30000)
        return () => window.clearInterval(timer)
      }, [flash])

      // 选中正文时浮出「转」；只在选区来自正文、且不是输入框时算数。
      useEffect(() => {
        let timer = null
        const read = () => {
          setSelection(currentSelection([railRef.current, panelRef.current]))
        }
        const onChange = () => {
          if (timer !== null) window.clearTimeout(timer)
          timer = window.setTimeout(read, 120)
        }
        document.addEventListener('selectionchange', onChange)
        return () => {
          document.removeEventListener('selectionchange', onChange)
          if (timer !== null) window.clearTimeout(timer)
        }
      }, [])

      // 吸附时跟随侧栏：侧栏折叠/展开、窗口缩放，都会让边缘移动。
      useEffect(() => {
        if (!snap) return undefined
        let alive = true
        const measure = () => {
          // 收起时工具条不在 DOM 里，排除列表给空数组，边缘照旧跟着侧栏走。
          const excludes = railHidden ? [] : [railRef.current, panelRef.current]
          if (isObscured(excludes)) return
          const found = measureEdge(excludes)
          if (alive && found !== null) setEdge(found)
        }
        measure()
        const timer = window.setInterval(measure, 600)
        window.addEventListener('resize', measure)
        return () => {
          alive = false
          window.clearInterval(timer)
          window.removeEventListener('resize', measure)
        }
      }, [snap, open, railHidden])

      // 第一次显示（没有存过位置）时按真实高度垂直居中
      useEffect(() => {
        if (readStore().pos !== undefined) return
        const node = railRef.current
        if (node === null || node === undefined) return
        const height = node.offsetHeight
        if (!Number.isFinite(height) || height <= 0) return
        const next = {
          left: position.left,
          top: Math.max(8, Math.round((window.innerHeight - height) / 2)),
        }
        setPosition(next)
        livePos.current = next
      }, [])

      // 点外面收起（钉住时不收）。
      useEffect(() => {
        if (!open || pinned) return undefined
        const onDown = (event) => {
          if (railRef.current !== null && railRef.current.contains(event.target)) return
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [open, pinned])

      // Esc 收起；⌘1 / ⌘2 直开。
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && open) {
            setOpen(false)
            return
          }
          if (!(event.metaKey || event.ctrlKey)) return
          // 工具条收起时不接快捷键：面板没有锚点，直接开在半空里更奇怪。
          if (railHidden) return
          const target = event.target
          const tag = target !== null && target !== undefined && typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
          if (tag === 'input' || tag === 'textarea' || target?.isContentEditable === true) return
          // ⌘1–⌘4 按「使用频次」顺序打开对应便签
          const digit = ['1', '2', '3', '4', '5'].indexOf(event.key)
          if (digit >= 0 && blades[digit] !== undefined) {
            event.preventDefault()
            setBlade(blades[digit].id)
            setOpen(true)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, railHidden])

      const choose = useCallback((next) => {
        if (next === 'transform') {
          const fresh = currentSelection([railRef.current, panelRef.current])
          setTransformText(fresh !== '' ? fresh : selection)
        }
        setBlade(next)
        writeStore({ blade: next })
        setOpen((current) => (blade === next ? !current : true))
      }, [blade, selection])

      const dragArmed = useRef(false)
      const holdRef = useRef(null)

      const beginDrag = useCallback((event) => {
        dragArmed.current = true
        const start = {
          x: event.clientX,
          y: event.clientY,
          left: snap && edge !== null ? edge : position.left,
          top: position.top,
        }
        livePos.current = { left: start.left, top: start.top }
        setDragging(true)

        // 拖动期间只测一次边缘：每次移动都测是卡顿的主因
        const found = measureEdge([railRef.current, panelRef.current])
        if (found !== null) setEdge(found)

        let frame = 0
        let pending = null
        const apply = (moveEvent) => {
          const next = clampPos({
            left: start.left + (moveEvent.clientX - start.x),
            top: start.top + (moveEvent.clientY - start.y),
          })
          if (found !== null && next.left < found) next.left = found
          livePos.current = next
          setPosition(next)
          if (found !== null) setGuide(Math.abs(next.left - found) <= SNAP_PX ? found : null)
        }
        // 按帧合并 pointermove：一帧最多更新一次
        const onMove = (moveEvent) => {
          pending = moveEvent
          if (frame !== 0) return
          frame = window.requestAnimationFrame(() => {
            frame = 0
            if (pending !== null) apply(pending)
          })
        }
        const onUp = () => {
          if (frame !== 0) {
            window.cancelAnimationFrame(frame)
            frame = 0
            if (pending !== null) apply(pending)
          }
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setDragging(false)
          setGuide(null)
          const current = livePos.current
          const found = edge ?? measureEdge([railRef.current, panelRef.current])
          if (found !== null) {
            const near = Math.abs(current.left - found) <= SNAP_PX
            setSnap(near)
            writeFlag(SNAP_KEY, near)
            if (near) {
              setEdge(found)
              const offset = Math.max(-140, Math.min(140, Math.round(current.left - found)))
              setSnapOffset(offset)
              writeNumber(SNAP_OFFSET_KEY, offset)
            }
          } else {
            setSnap(false)
            writeFlag(SNAP_KEY, false)
          }
          savePos(current)
          window.setTimeout(() => { dragArmed.current = false }, 0)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }, [snap, edge, position.left, position.top])


      /**
       * 工具条任意位置都能拖：按下后移动超过 4px 判定为拖动；
       * 只按不移动仍是点击，所以不会误挡打开面板。
       */
      const onRailPointerDown = useCallback((event) => {
        if (event.button !== 0) return
        const target = event.target
        if (target !== null && target !== undefined && typeof target.closest === 'function') {
          if (target.closest('.dsw-magnet') !== null) return
        }
        const startX = event.clientX
        const startY = event.clientY
        let armed = false
        const onMove = (moveEvent) => {
          if (armed) return
          if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) <= 4) return
          armed = true
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          beginDrag({ clientX: startX, clientY: startY })
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }, [beginDrag])

      const toggleSnap = useCallback(() => {
        const next = !snap
        setSnap(next)
        writeFlag(SNAP_KEY, next)
        if (next) {
          const found = measureEdge([railRef.current, panelRef.current])
          if (found !== null) {
            setEdge(found)
            flash(t('snapped'))
          } else {
            flash(t('snapFailed'))
          }
        } else {
          flash(t('snapOff'))
        }
      }, [snap, flash, t])

      const moveBladeTo = useCallback((id, target) => {
        setOrder((current) => {
          const next = current.slice()
          const index = next.indexOf(id)
          if (index < 0 || target < 0 || target >= next.length || target === index) return current
          next.splice(index, 1)
          next.splice(target, 0, id)
          writeStore({ order: next })
          return next
        })
      }, [])

      const toggleHidden = useCallback((id) => {
        setHidden((current) => {
          const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
          writeStore({ hidden: next })
          return next
        })
      }, [])

      const resetAll = useCallback(() => {
        setOrder(DEFAULT_ORDER)
        setHidden([])
        writeStore({ order: DEFAULT_ORDER, hidden: [] })
        setRailHidden(false)
        writeFlag(RAIL_HIDDEN_KEY, false)
        setSnap(true)
        writeFlag(SNAP_KEY, true)
        setSnapOffset(0)
        writeNumber(SNAP_OFFSET_KEY, 0)
        const next = defaultPos()
        setPosition(next)
        livePos.current = next
        savePos(next)
        flash(t('moreResetAllDone'))
      }, [flash, t])

      const resetPosition = useCallback(() => {
        const railHeight = railRef.current !== null && railRef.current !== undefined
          ? railRef.current.offsetHeight
          : 460
        const next = {
          left: snap && edge !== null ? edge + snapOffset : position.left,
          top: Math.max(8, Math.round((window.innerHeight - railHeight) / 2)),
        }
        setPosition(next)
        livePos.current = next
        savePos(next)
        setSnapOffset(0)
        writeNumber(SNAP_OFFSET_KEY, 0)
        setSnap(true)
        writeFlag(SNAP_KEY, true)
        const found = measureEdge([railRef.current, panelRef.current])
        if (found !== null) setEdge(found)
        flash(t('moreResetDone'))
      }, [flash, t])

      const togglePinned = useCallback(() => {
        setPinned((current) => {
          writeFlag(PIN_KEY, !current)
          return !current
        })
      }, [])

      const freeLeft = position.left
      const snappedLeft = edge === null ? freeLeft : edge + snapOffset
      const baseLeft = compact ? 14 : (dragging ? freeLeft : (snap && edge !== null ? snappedLeft : freeLeft))
      // 自由态也不许停在侧栏里：拖进去会自动推回侧栏右缘
      const railLeft = compact ? 14 : (!snap && edge !== null ? Math.max(baseLeft, edge) : baseLeft)
      const panelLeft = compact ? 12 : railLeft + 48
      const panelTop = compact
        ? 'auto'
        : Math.max(12, Math.min((typeof window === 'undefined' ? 960 : window.innerHeight) - 440, position.top - 26))
      // 收起后只剩一枚 30px 的小图标：位置贴着工具条原来的边上，不另起一套坐标。
      const featherLeft = (snap && edge !== null ? snappedLeft : railLeft) + 6
      const featherTop = position.top + 8
      const earStyle = compact
        ? { left: compactInset, bottom: COMPACT_BOTTOM }
        : { left: featherLeft, top: featherTop }

      // 羽毛也能拖：拖到哪就停在哪，松手时贴着侧栏照样吸附；没拖动就是"展开"。
      const featherDrag = useRef(null)
      const flyMoved = useRef(false)

      const onFlyDown = useCallback((event) => {
        if (compact) return
        if (event.button !== undefined && event.button !== 0) return
        featherDrag.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: featherLeft,
          top: featherTop,
          moved: false,
        }
        setTip(null)
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 不支持捕获也能拖到手边 */ }
      }, [compact, featherLeft, featherTop])

      const onFlyMove = useCallback((event) => {
        const drag = featherDrag.current
        if (drag === null || drag.id !== event.pointerId) return
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
        drag.moved = true
        const next = clampPos({ left: drag.left + dx, top: drag.top + dy })
        if (edge !== null && next.left < edge) next.left = edge
        livePos.current = { left: next.left - 6, top: next.top - 8 }
        setPosition(livePos.current)
      }, [edge])

      const onFlyUp = useCallback((event) => {
        const drag = featherDrag.current
        if (drag === null || drag.id !== event.pointerId) return
        featherDrag.current = null
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* ignore */ }
        if (!drag.moved) return
        flyMoved.current = true
        // 拖完浏览器会补一个 click：吃掉它；万一没补，下一拍自动复位
        window.setTimeout(() => { flyMoved.current = false }, 0)
        const current = livePos.current
        const found = measureEdge([])
        if (found !== null) {
          const near = Math.abs(current.left - found) <= SNAP_PX
          setSnap(near)
          writeFlag(SNAP_KEY, near)
          if (near) {
            const offset = Math.max(-140, Math.min(140, Math.round(current.left - found)))
            setSnapOffset(offset)
            writeNumber(SNAP_OFFSET_KEY, offset)
            setEdge(found)
          }
        }
        savePos(current)
        flash(t('railMoved'))
      }, [flash, t])

      const onFlyCancel = useCallback(() => {
        featherDrag.current = null
      }, [])
      const activeBlade = BLADES.find((item) => item.id === blade)
      const activeTone = activeBlade !== undefined
        ? TONES[activeBlade.tone] ?? 'var(--dsw-alias-border-l1)'
        : blade === 'settings'
          ? TONES.gray
          : customItems.some((item) => item.id === blade)
            ? TONES.lavender
            : 'var(--dsw-alias-border-l1)'
      const viewportW = typeof window === 'undefined' ? 1280 : window.innerWidth
      const viewportH = typeof window === 'undefined' ? 900 : window.innerHeight
      const maxPanelW = Math.max(280, Math.min(620, viewportW - panelLeft - 20))
      const maxPanelH = Math.max(220, viewportH - panelTop - 20)
      const storedSize = panelSizes[blade] ?? null
      const wantW = storedSize === null ? 308 : Math.min(Math.max(storedSize.w, 280), maxPanelW)
      const wantH = storedSize === null ? null : Math.min(Math.max(storedSize.h, 220), maxPanelH)
      // 面板在 compact 下是底部抽屉：底边抬到输入框之上，展开时不会盖住输入框和发送按钮。
      const panelStyle = compact
        ? { left: compactInset, right: 12, bottom: COMPACT_PANEL_BOTTOM, width: 'auto', maxHeight: `calc(100vh - ${COMPACT_PANEL_BOTTOM + 80}px)`, '--tab': activeTone }
        : {
          left: panelLeft,
          top: panelTop,
          width: wantW,
          ...(wantH === null ? {} : { height: wantH }),
          maxHeight: `min(82vh, ${maxPanelH}px)`,
          '--tab': activeTone,
        }

      // compact（≤1100px）横排：让开左侧 56px 的侧栏图标条——用户名/头像按钮就压在那里，
      // 之前的 left:14 会把「账号菜单」和「收起侧栏」整个盖掉。
      // 窄栏：声明式地把横排条 portal 进输入框 dock（React 管理挂载，不会有「节点掉回 body」的竞争）。
      const wrapDock = (node) => (docked ? createPortal(node, dockNode) : node)

      const railStyle = docked
        ? {}
        : compact
          ? { left: compactInset, top: 'auto', bottom: COMPACT_BOTTOM }
          : { left: railLeft, top: position.top }

      const handleInsert = useCallback((text) => insertIntoComposer(text), [])

      const panel = open
        ? h('div', {
          ref: panelRef,
          className: `dsw-panel${compact ? ' dsw-panel--compact' : ''}`,
          style: panelStyle,
          role: 'dialog',
          'aria-label': activeBlade === undefined ? t('roadmapTitle') : (activeBlade.title[locale] ?? activeBlade.title.zh),
        },
        h('div', { className: 'dsw-panel__head' },
          h('div', { className: 'dsw-panel__title' }, activeBlade === undefined ? t('roadmapTitle') : (activeBlade.title[locale] ?? activeBlade.title.zh)),
          h('button', {
            type: 'button',
            className: `dsw-panel__icon${pinned ? ' dsw-panel__icon--on' : ''}`,
            title: pinned ? t('unpin') : t('pin'),
            onClick: togglePinned,
          }, '📌'),
          h('button', { type: 'button', className: 'dsw-panel__icon', title: t('close'), onClick: () => setOpen(false) }, '×'),
        ),
        compact
          ? null
          : h('div', {
            className: 'dsw-panel__resize',
            title: t('panelResize'),
            onPointerDown: (event) => {
              event.preventDefault()
              event.stopPropagation()
              const node = panelRef.current
              const base = {
                w: node === null ? 308 : node.offsetWidth,
                h: node === null ? 320 : node.offsetHeight,
              }
              const startX = event.clientX
              const startY = event.clientY
              const onMove = (moveEvent) => {
                const nextW = Math.min(Math.max(280, base.w + (moveEvent.clientX - startX)), maxPanelW)
                const nextH = Math.min(Math.max(220, base.h + (moveEvent.clientY - startY)), maxPanelH)
                setPanelSizes((current) => ({ ...current, [blade]: { w: nextW, h: nextH } }))
              }
              const onUp = () => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                setPanelSizes((current) => {
                  writePanelSizes(current)
                  return current
                })
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            },
          },
          h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': true, style: { display: 'block' } },
            h('path', { d: 'M11 4.5L4.5 11', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
            h('path', { d: 'M11 8.5L8.5 11', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
          )),
        blade === 'snippets'
          ? h(SnippetsPanel, { t, locale, onClose: () => setOpen(false), onInsert: handleInsert, flash })
          : blade === 'watch'
            ? h(WatchPanel, { t })
            : blade === 'notes'
              ? h(NotesPanel, { t, onClose: () => setOpen(false), flash })
              : blade === 'summary'
              ? h(SummaryPanel, { t, onInsert: handleInsert, onClose: () => setOpen(false), flash })
              : blade === 'transform'
                ? h(TransformPanel, { t, text: transformText, onInsert: handleInsert, onClose: () => setOpen(false), flash })
                : customItems.some((item) => item.id === blade)
                ? h(CustomPanel, {
                  t,
                  entry: customItems.find((item) => item.id === blade),
                  onClose: () => setOpen(false),
                  flash,
                })
                : h(MorePanel, {
                t,
                locale,
                onPick: (id) => choose(id),
                onMoveTo: moveBladeTo,
                blades: ordered,
                hidden,
                onToggleHidden: toggleHidden,
                snap,
                onToggleSnap: toggleSnap,
                onResetPosition: resetPosition,
                onResetAll: resetAll,
                customItems,
                onCustomReload: loadCustom,
              }),
        )
        : null

      return h(React.Fragment, null,
        railHidden && !compact
          ? h('button', {
            type: 'button',
            className: 'dsw-wing',
            style: earStyle,
            title: `${t('railShow')} · ${t('railDrag')}`,
            'aria-label': t('railShow'),
            onMouseEnter: (event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setTip({ text: t('railShow'), top: rect.top + rect.height / 2 })
            },
            onMouseLeave: () => setTip(null),
            onPointerDown: onFlyDown,
            onPointerMove: onFlyMove,
            onPointerUp: onFlyUp,
            onPointerCancel: onFlyCancel,
            onClick: () => {
              // 刚拖过就别当成点击（指针抬起后浏览器仍会补一个 click）
              if (flyMoved.current) { flyMoved.current = false; return }
              showRail()
            },
          }, h(FeatherIcon, { size: 22 }))
          : wrapDock(h('div', {
          ref: railRef,
          onPointerDown: docked ? undefined : onRailPointerDown,
          className: `dsw-rail${compact ? ' dsw-rail--compact' : ''}${docked ? ' dsw-rail--docked' : ''}${!compact && snap && edge !== null ? ' dsw-rail--snapped' : ''}${dragging ? ' dsw-rail--dragging' : ''}${railPinned ? '' : ' dsw-rail--dim'}`,
          style: railStyle,
          'aria-label': t('rail'),
        },
        h('div', {
          className: `dsw-grip${railPinned ? ' dsw-grip--on' : ''}`,
          onMouseEnter: (event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setTip({ text: railPinned ? t('railUnpin') : t('railPin'), top: rect.top + rect.height / 2 })
          },
          onMouseLeave: () => setTip(null),
          onClick: () => {
            if (dragArmed.current) {
              dragArmed.current = false
              return
            }
            const next = !railPinned
            setRailPinned(next)
            writeFlag(RAIL_PIN_KEY, next)
            flash(next ? t('railPinned') : t('railUnpinned'))
          },
        }, h('span', { className: 'dsw-grip__pin' }, '📌')),
        stripAll.map((item) => h('button', {
          key: item.id,
          type: 'button',
          className: `dsw-cell dsw-tone--${item.tone}${open && blade === item.id ? ' dsw-cell--active' : ''}${item.id === 'transform' ? (selection === '' ? ' dsw-cell--idle' : ' dsw-cell--ready') : ''}`,
          onMouseEnter: (event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            const text = item.id === 'transform'
              ? (selection === '' ? t('transformIdleHint') : t('transformHint'))
              : (item.title[locale] ?? item.title.zh)
            setTip({ text, top: rect.top + rect.height / 2 })
          },
          onMouseLeave: () => setTip(null),
          onPointerDown: item.id === 'transform'
            ? () => {
              // 按下时立刻读一次选区：浏览器随后可能清掉它，但这一拍拿到就够
              const fresh = currentSelection([railRef.current, panelRef.current])
              if (fresh !== '') setTransformText(fresh)
            }
            : undefined,
          onClick: () => {
            if (dragArmed.current) {
              dragArmed.current = false
              return
            }
            choose(item.id)
          },
        }, (() => {
          const glyph = item.custom ? (item.kind === 'open' ? ICONS.customOpen : ICONS.customRun) : ICONS[item.id]
          return glyph === undefined ? (item.mark === '' ? null : item.mark) : h(glyph, { size: 18 })
        })())),
        h('button', {
          type: 'button',
          className: `dsw-cell dsw-tone--gray${open && blade === 'settings' ? ' dsw-cell--active' : ''}`,
          onMouseEnter: (event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setTip({ text: t('roadmap'), top: rect.top + rect.height / 2 })
          },
          onMouseLeave: () => setTip(null),
          onClick: () => choose('settings'),
        },
        h(ICONS.settings, { size: 18 })),
        h('button', {
          type: 'button',
          className: `dsw-magnet${snap ? ' dsw-magnet--on' : ''}`,
          onMouseEnter: (event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setTip({
              text: snap ? t('snapOnHint') : t('snapOffHint'),
              top: rect.top + rect.height / 2,
            })
          },
          onMouseLeave: () => setTip(null),
          'aria-pressed': snap,
          onClick: toggleSnap,
        },
        h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true, style: { display: 'block' } },
          // U 型吸铁石，开口朝左：右侧灰色圆弧，上臂红、下臂蓝
          h('path', { d: 'M10.4 2.6a5.4 5.4 0 0 1 0 10.8', fill: 'none', stroke: '#8b93a1', strokeWidth: 3.2, strokeLinecap: 'round' }),
          h('path', { d: 'M10.2 2.6H3.6', stroke: '#e0524a', strokeWidth: 3.2, strokeLinecap: 'round' }),
          h('path', { d: 'M10.2 13.4H3.6', stroke: '#3d7fd9', strokeWidth: 3.2, strokeLinecap: 'round' }),
          // 左端两极为稍亮的极面
          h('path', { d: 'M2.6 1.2v2.9', stroke: '#f6d3cf', strokeWidth: 3.2, strokeLinecap: 'butt' }),
          h('path', { d: 'M2.6 11.9v2.9', stroke: '#c7d8f0', strokeWidth: 3.2, strokeLinecap: 'butt' }),
        )),
        compact ? null : h('button', {
          type: 'button',
          className: 'dsw-rail__close',
          title: t('railClose'),
          'aria-label': t('railClose'),
          onPointerDown: (event) => {
            // 别让按下这一下变成拖动工具条
            event.stopPropagation()
          },
          onClick: hideRail,
        }, '×'),
        )),
        guide === null ? null : h('div', { className: 'dsw-guide', style: { left: guide } }),
        tip === null ? null : h('div', {
          className: 'dsw-tip',
          style: railLeft + 21 > window.innerWidth / 2
            ? { left: railLeft - 8, top: Math.max(16, Math.min(window.innerHeight - 24, tip.top)), transform: 'translate(-100%,-50%)' }
            : { left: railLeft + 50, top: Math.max(16, Math.min(window.innerHeight - 24, tip.top)) },
        }, tip.text),
        panel,
        toast === '' ? null : h('div', { className: 'dsw-toast', style: compact ? { left: 20, bottom: 84 } : { left: railLeft + 50, top: position.top + 150 } }, toast),
      )
    }

    /** 兜底：细条渲染抛错时不要静默消失，显示一块能看见的提示，并把错误写进控制台。 */
    function Rail(props = {}) {
      try {
        return RailView(props)
      } catch (error) {
        try {
          console.error('[dsh-wingman] 细条渲染失败：', error)
        } catch {
          // 控制台不可用。
        }
        const detail = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : String(error)
        return h('div', {
          className: 'dsw-crash',
          title: String(error !== null && error !== undefined && typeof error.stack === 'string' ? error.stack : detail),
        }, `⚠ 细条渲染失败：${detail.slice(0, 120)}`)
      }
    }

    /** 只让第一个成功挂载的宿主渲染细条，避免两个挂载点各画一条。 */
    let railOwner = null
    let railSeq = 0

    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom !== null && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      // 没有 react-dom 就退回原来的挂载方式
    }

    function RailHost(props = {}) {
      const idRef = useRef(null)
      if (idRef.current === null) {
        railSeq += 1
        idRef.current = `host-${railSeq}`
      }
      const [owned, setOwned] = useState(false)
      useEffect(() => {
        if (railOwner === null) {
          railOwner = idRef.current
          setOwned(true)
        }
        return () => {
          if (railOwner === idRef.current) railOwner = null
        }
      }, [])
      if (!owned) return null
      const node = h(Rail, props)
      if (createPortal === null || typeof document === 'undefined') return node
      return createPortal(node, document.body)
    }

    /* ------------------------------------------------------------ 样式 */

    const CSS = [
      '.dsw-rail{position:fixed;display:flex;flex-direction:column;align-items:stretch;gap:6px;width:42px;box-sizing:border-box;background:transparent;border:0;box-shadow:none;pointer-events:none;z-index:2147482000;user-select:none;-webkit-user-select:none;transition:left .16s ease,top .16s ease}',
      '.dsw-rail>*{pointer-events:auto}',
      '.dsw-cell{cursor:grab}',
      '.dsw-rail--dragging .dsw-cell{cursor:grabbing}',
      '.dsw-rail--compact{flex-direction:row;width:auto;align-items:center}',
      '.dsw-dock{display:flex;align-items:center;gap:4px;min-width:0;max-width:100%;padding:2px 0}',
      '.dsw-dock:empty{display:none}',
      '.dsw-dock::-webkit-scrollbar{display:none}',
      '.dsw-rail--docked{position:static!important;left:auto!important;top:auto!important;bottom:auto!important;right:auto!important;width:auto;max-width:100%;transform:none!important;opacity:1!important;transition:none!important}',
      '.dsw-rail--docked .dsw-grip,.dsw-rail--docked .dsw-magnet{display:none}',
      '.dsw-rail--docked .dsw-cell{width:38px;height:38px;border-radius:11px}',
      '.dsw-rail--docked .dsw-rail__close{position:static;margin:0 0 0 2px}',
      '.dsw-rail--dragging{transition:none;cursor:grabbing}',
      '.dsw-rail--dim{opacity:.4;transition:opacity .15s ease}',
      '.dsw-rail--dim:hover{opacity:1}',
      '.dsw-rail{transition:left .16s ease,top .16s ease,opacity .12s ease}',
      '.dsw-rail--dragging{transition:none !important}',
      '.dsw-grip{appearance:none;border:0;background:transparent;height:24px;width:100%;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:2px;cursor:grab;opacity:.6;touch-action:none;transition:opacity .12s ease,background .12s ease}',
      '.dsw-grip:hover{background:var(--dsw-alias-bg-layer-2);opacity:1}',
      '.dsw-grip--on{opacity:1;background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-grip__pin{font-size:13px;line-height:1}',
      '.dsw-grip:hover{opacity:1}',
      '.dsw-grip:active{cursor:grabbing}',
      '.dsw-grip svg{color:var(--dsw-alias-label-secondary);opacity:.9}',
      '.dsw-grip:hover svg{color:var(--dsw-alias-label-primary)}',
      '.dsw-rail--compact .dsw-grip{display:none}',
      '.dsw-cell{appearance:none;border:0;margin:0;width:42px;height:44px;border-radius:13px;background:var(--tab,#e9e9e9);color:var(--ink,#333);',
      'font:15px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;',
      'cursor:grab;position:relative;border:1px solid rgba(0,0,0,.07);box-shadow:0 2px 8px rgba(0,0,0,.12);transition:transform .12s ease,box-shadow .12s ease,filter .12s ease}',
      '.dsw-rail--snapped .dsw-cell{border-radius:0 13px 13px 0}',
      '.dsw-cell svg{width:18px;height:18px}',
      '.dsw-magnet svg{width:15px;height:15px}',
      '.dsw-more__eye svg,.dsw-more__hint svg,.dsw-iconbtn svg{width:14px;height:14px}',
      '.dsw-cell:hover{transform:translateY(-1px);filter:brightness(1.04);box-shadow:0 6px 16px rgba(0,0,0,.18)}',
      '.dsw-cell:active{transform:translateY(0) scale(.97)}',
      '.dsw-cell:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsw-cell--idle{opacity:1;filter:none}',
      '.dsw-cell--active{box-shadow:inset 0 0 0 2px rgba(0,0,0,.10),0 5px 14px rgba(0,0,0,.18)}',
      '.dsw-tone--amber{--tab:#f6d993;--ink:#54420f}',
      '.dsw-tone--sage{--tab:#c4e3b6;--ink:#1d4a22}',
      '.dsw-tone--sage.dsw-cell--ready{--tab:#a6dd99;--ink:#173f1c}',
      '.dsw-tone--blue{--tab:#bed7f5;--ink:#1f3f61}',
      '.dsw-tone--rose{--tab:#eecbdb;--ink:#5a2b3f}',
      '.dsw-tone--slate{--tab:#d3dae6;--ink:#36405a}',
      '.dsw-tone--lavender{--tab:#ded5f1;--ink:#42365e}',
      '.dsw-tone--gray{--tab:#dadde0;--ink:#4a5058}',
      '.dsw-tone--plain{--tab:var(--dsw-alias-bg-layer-1);--ink:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}',
      '.dsw-cell--neutral{--tab:var(--dsw-alias-bg-layer-1);--ink:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 1px 3px rgba(0,0,0,.06)}',
      '.dsw-magnet{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);width:42px;height:24px;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:.45;margin-top:-2px}',
      '.dsw-magnet:hover{background:var(--dsw-alias-bg-layer-2);opacity:.8}',
      '.dsw-magnet:active{transform:translateY(1px)}',
      '.dsw-magnet:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsw-grip:hover{opacity:.8}',
      '.dsw-magnet--on{opacity:.95;color:var(--dsw-alias-brand-primary)}',
      // 收起按钮：平时半透明，鼠标进工具条才浮出来一点；不抢颜色、不抢位置。
      '.dsw-rail__close{appearance:none;width:18px;height:18px;margin:2px auto 0;padding:0;border:0;border-radius:50%;',
      'background:transparent;color:var(--dsw-alias-label-secondary);font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;',
      'cursor:pointer;opacity:0;transition:opacity .12s ease,background .12s ease,color .12s ease}',
      '.dsw-rail:hover .dsw-rail__close,.dsw-rail--compact .dsw-rail__close{opacity:.5}',
      '.dsw-rail--compact .dsw-rail__close{margin:0 0 0 2px}',
      '.dsw-rail__close:hover{opacity:1;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);color:var(--dsw-alias-label-primary)}',
      '.dsw-rail__close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;opacity:1}',
      // 收起后的最小形态：一枚 30px 的羽毛图标，贴在同一条边上，点一下就回来。
      '.dsw-wing{position:fixed;z-index:2147482000;appearance:none;display:flex;align-items:center;justify-content:center;touch-action:none;cursor:grab;',
      'width:30px;height:30px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;',
      'background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 86%,transparent);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);',
      'color:var(--dsw-alias-label-secondary);box-shadow:0 4px 14px rgba(0,0,0,.14);cursor:pointer;opacity:.62;transition:opacity .14s ease,transform .14s ease,box-shadow .14s ease,color .14s ease}',
      '.dsw-wing:hover{opacity:1;transform:translateY(-1px) scale(1.05);box-shadow:0 8px 20px rgba(0,0,0,.2);color:var(--dsw-alias-label-primary)}',
      '.dsw-wing:active{transform:translateY(0) scale(.97);cursor:grabbing}',
      '.dsw-wing:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;opacity:1}',
      '.dsw-tip{position:fixed;z-index:2147482003;transform:translateY(-50%);pointer-events:none;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 9px;font-size:11.5px;line-height:1.3;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.14);animation:dsw-tip-in .12s ease}',
      '@keyframes dsw-tip-in{from{opacity:0}to{opacity:1}}',
      '.dsw-guide{position:fixed;top:0;bottom:0;width:2px;border-radius:2px;pointer-events:none;z-index:2147481999;background:var(--dsw-alias-label-secondary);opacity:.6;animation:dsw-guide-in .12s ease}',
      '@keyframes dsw-guide-in{from{opacity:0}to{opacity:1}}',

      '.dsw-transform{display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;min-height:0}',
      '.dsw-transform__quote{max-height:132px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border-left:3px solid #d9cdf1;border-radius:8px;padding:7px 9px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
      '.dsw-transform__count{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:-4px}',
            '.dsw-transform__actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      '.dsw-transform__actions--end{display:flex;justify-content:flex-end;flex-wrap:wrap}',
      '.dsw-transform__section{font-size:10.5px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);margin-top:4px}',
      '.dsw-transform__comment{display:flex;flex-direction:column;gap:6px}',
      '.dsw-transform__result{display:flex;flex-direction:column;gap:6px}',
      '.dsw-transform__resultbody{max-height:190px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 9px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
      '.dsw-transform__actions .dsw-btn{padding:6px 8px;font-size:12px}',
      '.dsw-seg{display:flex;gap:4px;padding:10px 10px 0}',
      '.dsw-seg__btn{flex:1;appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer}',
      '.dsw-seg__btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-seg__btn--on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsw-notes{display:flex;flex-direction:column;gap:7px;padding:9px 10px 10px}',
      '.dsw-notes__text{box-sizing:border-box;width:100%;min-height:104px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:9px;padding:8px 9px;font:12.5px/1.55 inherit;resize:vertical;outline:none}',
      '.dsw-notes__text:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dsw-notes__actions{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dsw-notes__hint{font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.7}',
      '.dsw-remind{display:flex;flex-direction:column;gap:6px}',
      '.dsw-remind__chips{display:flex;gap:5px;flex-wrap:wrap}',
      '.dsw-notes__added{font-size:11px;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);border-radius:7px;padding:5px 8px}',
      '.dsw-notes__section{font-size:10.5px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);margin-top:4px}',
      '.dsw-notes__item{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;padding:4px 6px;border-radius:7px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsw-notes__itemtext{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsw-notes__due{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-notes__empty{font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 6px}',
      '.dsw-notes__stats{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-watch{display:flex;gap:12px;align-items:center;padding:12px 12px 4px}',
      '.dsw-watch__ring{position:relative;width:64px;height:64px;flex:none}',
      '.dsw-watch__pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dsw-watch__meta{flex:1;min-width:0}',
      '.dsw-watch__label{font-size:10.5px;letter-spacing:.03em;color:var(--dsw-alias-label-secondary)}',
      '.dsw-watch__value{font-size:14px;font-weight:600;margin-top:2px}',
      '.dsw-watch__hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.8}',
      '.dsw-watch__rows{display:flex;flex-direction:column;gap:1px;padding:6px}',
      '.dsw-watch__row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:5px 7px;border-radius:8px;font-size:11.5px}',
      '.dsw-watch__row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-watch__row>span:first-child{color:var(--dsw-alias-label-secondary);flex:none}',
      '.dsw-watch__val{text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsw-watch__foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 12px 10px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-search{display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;min-height:0}',
      '.dsw-search__list{display:flex;flex-direction:column;gap:2px}',
      '.dsw-search__row{border-radius:8px}',
      '.dsw-search__row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-search__body{width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:6px 7px;cursor:pointer;display:flex;flex-direction:column;gap:2px}',
      '.dsw-search__snippet{font-size:11.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.dsw-search__meta{font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsw-summary{display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;min-height:0}',
      '.dsw-summary__text{font-size:12px;line-height:1.6;white-space:pre-wrap;user-select:text}',
      '.dsw-summary__actions{display:flex;justify-content:flex-end;gap:6px}',
      '.dsw-quotes{display:flex;flex-direction:column;gap:6px;padding:10px;overflow:auto;min-height:0}',
      '.dsw-quotes__list{display:flex;flex-direction:column;gap:2px}',
      '.dsw-quotes__row{display:flex;align-items:center;gap:6px;border-radius:7px;padding:2px 4px}',
      '.dsw-quotes__row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-quotes__text{flex:1;min-width:0;border:0;background:transparent;color:inherit;font:inherit;font-size:11.5px;text-align:left;padding:4px 2px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsw-quotes__time{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-quotes__actions{display:flex;gap:6px}',
      '.dsw-recent{display:flex;flex-direction:column;gap:6px;padding:10px;overflow:auto;min-height:0;user-select:none;-webkit-user-select:none}',
      '.dsw-recent__root{font-size:10.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.dsw-recent__list{display:flex;flex-direction:column;gap:1px}',
      '.dsw-recent__row{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border:0;background:transparent;color:inherit;font:inherit;font-size:11.5px;text-align:left;padding:6px 7px;border-radius:7px;cursor:pointer}',
      '.dsw-recent__row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-recent__name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsw-recent__time{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-recent__actions{display:flex;gap:6px;margin-top:2px}',
      '.dsw-custom{display:flex;flex-direction:column;gap:8px;padding:10px}',
      '.dsw-custom__meta{display:flex;flex-direction:column;gap:4px}',
      '.dsw-custom__kind{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-custom__target{font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-bg-layer-1);border-radius:7px;padding:6px 8px;word-break:break-all;white-space:pre-wrap}',
      '.dsw-custom__cwd{font-size:10.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.dsw-custom__actions{display:flex;gap:6px}',
      '.dsw-custom__output{margin:0;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 9px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}',
      '.dsw-custom__output--bad{color:var(--dsw-alias-state-error-primary)}',
      '.dsw-customform{display:flex;flex-direction:column;gap:6px;padding:6px 0}',
      '.dsw-customform__actions{display:flex;gap:6px;justify-content:flex-end}',
      '.dsw-recap{display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;min-height:0}',
      '.dsw-recap__text{white-space:pre-wrap;font-size:12.5px;line-height:1.6;background:var(--dsw-alias-bg-layer-1);border-radius:9px;padding:9px 10px;word-break:break-word}',
      '.dsw-recap__source{font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.dsw-recap__actions{display:flex;gap:6px;flex-wrap:wrap}',
      '.dsw-panel{position:fixed;z-index:2147482001;box-sizing:border-box;display:flex;flex-direction:column;max-height:min(74vh,580px);',
      'background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 82%,transparent);-webkit-backdrop-filter:blur(16px) saturate(1.04);backdrop-filter:blur(16px) saturate(1.04);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;overflow:hidden;pointer-events:auto;',
      'box-shadow:0 18px 48px rgba(0,0,0,.16),0 2px 8px rgba(0,0,0,.06);color:var(--dsw-alias-label-primary);',
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
      '.dsw-panel--compact{width:auto}',
      '.dsw-panel__head{display:flex;align-items:center;gap:4px;padding:9px 8px 8px 12px;border-top:3px solid var(--tab,var(--dsw-alias-border-l1));border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.dsw-panel__title{flex:1;min-width:0;font-weight:600;font-size:13px;letter-spacing:.01em}',
      '.dsw-panel__icon{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);width:26px;height:26px;border-radius:7px;cursor:pointer;font-size:13px;opacity:.55}',
      '.dsw-panel__icon:hover{background:var(--dsw-alias-bg-layer-2);opacity:1}',
      '.dsw-panel__icon--on{opacity:1;background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-panel__resize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;display:flex;align-items:flex-end;justify-content:flex-end;color:var(--dsw-alias-label-secondary);opacity:.45;cursor:nwse-resize;touch-action:none}',
      '.dsw-panel__resize:hover{opacity:.9}',
      '.dsw-panel__body{display:flex;flex-direction:column;min-height:0;flex:1}',
      '.dsw-toolbar{display:flex;gap:6px;padding:9px 10px 7px;flex:none}',
      '.dsw-input{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'border-radius:8px;padding:7px 9px;min-height:32px;font:12.5px/1.45 inherit;outline:none}',
      '.dsw-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}',
      '.dsw-input--search{flex:1;min-width:0}',
      '.dsw-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'border-radius:8px;padding:7px 8px;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;outline:none}',
      '.dsw-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dsw-chips{display:flex;gap:5px;padding:0 10px 8px;overflow-x:auto;flex:none;scrollbar-width:none}',
      '.dsw-chips::-webkit-scrollbar{display:none}',
      '.dsw-chip{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);',
      'border-radius:999px;padding:2px 9px;font-size:11.5px;cursor:pointer;white-space:nowrap}',
      '.dsw-chip:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-chip--active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}',
      '.dsw-list{overflow:auto;padding:0 6px 8px;flex:1;min-height:0}',
      '.dsw-row{display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:9px;cursor:pointer;outline:none}',
      '.dsw-row:hover,.dsw-row:focus-visible{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-row__main{flex:1;min-width:0}',
      '.dsw-row__title{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:4px}',
      '.dsw-row__pin{color:var(--dsw-alias-label-secondary);font-size:16px;line-height:0}',
      '.dsw-row__meta{display:flex;gap:6px;align-items:center;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.85;margin-top:1px}',
      '.dsw-row__group{max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsw-row__actions{display:flex;gap:1px;opacity:0;flex:none}',
      '.dsw-row:hover .dsw-row__actions,.dsw-row:focus-within .dsw-row__actions{opacity:1}',
      '.dsw-iconbtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:12px}',
      '.dsw-iconbtn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dsw-empty{padding:18px 14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
      '.dsw-error{padding:6px 12px;color:var(--dsw-alias-state-error-primary);font-size:11.5px}',
      '.dsw-form{display:flex;flex-direction:column;gap:7px;padding:10px}',
      '.dsw-form__actions{display:flex;gap:6px;margin-top:2px}',
      '.dsw-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);',
      'border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer}',
      '.dsw-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-btn:active{transform:translateY(1px)}',
      '.dsw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsw-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.dsw-btn--primary:hover{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);filter:brightness(1.08)}',
      '.dsw-btn--primary:active{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);filter:brightness(.92)}',
      '.dsw-btn--primary:disabled,.dsw-btn--primary:disabled:hover{opacity:1;background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);filter:none;cursor:not-allowed}',
      '.dsw-iconbtn:focus-visible,.dsw-more__eye:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsw-btn--primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-weight:600}',
      '.dsw-btn--danger{margin-left:auto;color:var(--dsw-alias-state-error-primary)}',
      '.dsw-btn--compact{white-space:nowrap;padding:5px 9px}',
      '.dsw-toast{position:fixed;z-index:2147482002;max-width:260px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:9px;padding:6px 10px;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
      'color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.14);pointer-events:none;animation:dsw-fade .16s ease}',
      '@keyframes dsw-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
      '.dsw-more{display:flex;flex-direction:column;gap:4px;padding:10px;overflow:auto;min-height:0;user-select:none;-webkit-user-select:none}',
      '.dsw-more__row{user-select:none;-webkit-user-select:none;touch-action:none}',
      '.dsw-more__label{font-size:10.5px;letter-spacing:.03em;color:var(--dsw-alias-label-secondary);margin-top:4px}',
      '.dsw-more__list{display:flex;flex-direction:column;gap:1px}',
      '.dsw-more__row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:5px 6px 5px 8px;border-radius:8px;font-size:12px}',
      '.dsw-more__open{flex:1;min-width:0;display:flex;align-items:center;gap:8px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;padding:2px 0;cursor:pointer}',
      '.dsw-more__eye{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;opacity:.7}',
      '.dsw-more__eye:hover{background:var(--dsw-alias-bg-layer-2);opacity:1}',
      '.dsw-more__row--hidden{opacity:.45}',
      '.dsw-more__hint{display:flex;align-items:center;justify-content:center;width:8px;color:var(--dsw-alias-brand-primary);flex:none;animation:dsw-nudge 1s ease-in-out infinite}',
      '@keyframes dsw-nudge{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}',
      '.dsw-more__row--dragging{outline:1px dashed var(--dsw-alias-label-secondary);outline-offset:-1px;background:var(--dsw-alias-bg-layer-2);border-radius:8px}',
      '.dsw-more__move:disabled{opacity:.25;cursor:default}',
      '.dsw-more__move:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-more__row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsw-more__row--static{cursor:default}',
      '.dsw-more__row--static:hover{background:transparent}',
      '.dsw-more__dot{width:8px;height:8px;border-radius:50%;flex:none}',
      '.dsw-more__dot--mint{background:#c9e7c6}',
      '.dsw-more__dot--sky{background:#c6dcf4}',
      '.dsw-more__dot--violet{background:#d9cdf1}',
      '.dsw-more__dot--stone{background:#e2e6ea}',
      '.dsw-more__name{flex:none;width:64px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsw-more__row--static .dsw-more__name{flex:1}',
      '.dsw-more__desc{flex:1;min-width:0;text-align:left;margin-left:2px;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsw-switch{width:32px;height:18px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;flex:none;padding:0}',
      '.dsw-switch--on{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}',
      '.dsw-switch__knob{position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .14s ease;display:block}',
      '.dsw-switch--on .dsw-switch__knob{left:15px}',
      '.dsw-more__foot{font-size:10px;color:var(--dsw-alias-label-secondary);opacity:.6;text-align:right;margin-top:6px}',
      '.dsw-crash{position:fixed;left:16px;top:50%;transform:translateY(-50%);z-index:2147481999;pointer-events:auto;background:#ffe1e1;color:#7a1f1f;border:1px solid #e3a3a3;border-radius:10px;padding:8px 10px;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;max-width:240px;box-shadow:0 6px 20px rgba(0,0,0,.15)}',
      '@media (prefers-reduced-motion:reduce){.dsw-toast{animation:none}}',
    ].join('')

    /* ------------------------------------------------------------ 入口 */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
        ctx.effect(() => {
          const existing = document.getElementById('dsh-wingman-style')
          if (existing !== null) return () => {}
          const style = document.createElement('style')
          style.id = 'dsh-wingman-style'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            if (style.parentNode !== null) style.parentNode.removeChild(style)
          }
        }, 'dsh-wingman: styles')

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-wingman: dictionaries')

        // 细条：挂到已验证能渲染的位置。第一个挂上的实例负责画，另一个渲染 null。
        const hosts = [
          ['conversation.input.dock', 'dsh-wingman:rail-dock', 92],
          ['conversation.header.leading', 'dsh-wingman:rail-header', 40],
        ]
        for (const [slotName, id, order] of hosts) {
          try {
            ctx.slots.inject(slotName, () => ctx.slots.register({
              name: slotName,
              id,
              order,
            }, RailHost))
          } catch (error) {
            console.warn(`[dsh-wingman] 细条注册到 ${slotName} 失败：`, error)
          }
        }

        try {
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'dsh-wingman:bridge',
            order: 90,
          }, InputBridge))
        } catch (error) {
          console.warn('[dsh-wingman] 输入桥注册失败：', error)
        }
        } catch (error) {
          console.warn('[dsh-wingman] apply 失败，插件已自我禁用：', error)
        }
      },
    }
  },
})
