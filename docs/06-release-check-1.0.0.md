# 发版前 checklist · dsh-wingman v1.0.0（2026-11-07 / 08）

> 结论：**全部通过，已发 v1.0.0。** 逐项证据如下；验收人（reviewer）的独立复测见 `docs/05-review-2026-11-07.md`。

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | P1-1 AI 改写：选中正文 → 改写成指令 → 写回输入框 | ✅ | 输入框 `""` → `"执行工具条验收测试，仅回复 OK。"`；`docs/p1/p1-1-rewrite-result-1440-light.png`；reviewer 独立复跑同样通过 |
| 2 | P1-2 状态数字：模型 / token / 跟进 | ✅ | 模型 `deepseek-account · deepseek-flash` = 宿主 `request/context` = GUI `DeepSeek-V4.1-Flash High`；token 输入 279 · 输出 2 · 缓存读 25.2k = 会话 jsonl 最后一条 usage；跟进 10 = `~/.dsh/followup/tasks.json` 未完成 10 条 |
| 3 | P1-2 状态数字：子代理 | ✅（宿主口径受限） | 改成按 `listDescendants` 的 `activity === 'running'` 计数，并同时显示「本会话 N 个子代理」；空闲会话 `/api/watch` 实测 `{total:0,running:0}`，跑过子代理的会话显示「0 个运行中 · 本会话 1 个子代理」 |
| 4 | P1-2 面板自动刷新 / 关着不请求 | ✅ | 开着 10 秒 2 次请求、页脚 8 秒前进两拍；关掉 6 秒 0 次 |
| 5 | P1-3 「记」写入便签墙 | ✅ | `notes.json` 3 → 4 → 3（测试条目已删）；`docs/p1/p1-3-note-saved.png` |
| 6 | `npm test` | ✅ | 35 / 35 通过 |
| 7 | `npm run check` | ✅ | 12 个 JS `node --check` + client.js 静态自检 6 项全绿 |
| 8 | 1100px 以上不压正文 | ✅ | 1440：rail 42px `fixed`，与正文/输入框/发送键/头像相交 0 |
| 9 | 1100px 以下不压正文与控件 | ✅ | 1099 / 1000 / 760 × 深/浅：横排条 `static` 在输入框上方，与正文/输入框/发送键/账号按钮/收起侧栏 相交全 0；窄栏不提供「收起」（`close`/`wing` 均 0） |
| 10 | 窄栏切会话 ×3（回归点） | ✅ | 每次切完 `static`、y 在视口内、`scrollHeight == innerHeight`、无多余滚动 |
| 11 | 深色 / 浅色 | ✅ | 同上六组各半；主题 token 全走宿主变量 |
| 12 | 包名三处同步 | ✅ | `package.json` / `cordis.patch.yml` / `client.js` 首行 id 均为 `@bingomu/dsh-wingman`；`scripts/check-client.mjs` 改成从 package.json 读，不再写死 |
| 13 | 打包文件 | ✅ | `npm pack` → `bingomu-dsh-wingman-1.0.0.tgz`，45 files，含 `README.en.md`、`screenshots.json`、`cordis.patch.yml`、`icon.svg`、`LICENSE`、`locale/*`；**不含 `docs/p1`** |
| 14 | 没有 `window.location.reload()` | ✅ | 全仓 grep 0 命中 |
| 15 | 从 GitHub tag 干净安装 | ✅ | 见 CHANGELOG / Release 附注；本机装 tag 后真实 GUI 里 rail 挂上、`__DSH_BOOT__.entries` 只有一条 |
| 16 | 截图红线 | ✅ | `assets/` 12 张 + `docs/p1/` 4 张逐张看过：无别人的会话标题、无私人提示词、无密钥；单张 ≤400KB |
| 17 | 市场条目 | ✅ | PR #12988：`tarball` 指向 v1.0.0；仓库年龄门 2026-11-08T13:36Z 后自动转绿 |

## 已知瑕疵（不阻塞，已拍板）

1. 架构图页脚仍写「对照 v0.33.3」：图是按 v0.33.3 代码验证的，HTTP 路由与服务接法这版没变；按「轻产品不重画架构图」的规矩不重导。
2. `assets/shot-settings-en.png` 页脚仍是 v0.33.3：宿主语言服务是中文，切语言要写用户全局偏好，为一个页脚版本号不做。
3. 内置三条示例指令是中文，英文界面里也显示中文（截图里能看到）；属产品取舍，后续可做本地化。
