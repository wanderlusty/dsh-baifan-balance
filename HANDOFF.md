# 交接文档 · dsh-baifan-balance

> 给接手这个插件的下一个 agent / 开发者。读完这份就够接手，不用翻聊天记录。
> 最后更新：2026-11-18，对应版本 **1.20.0**（本地改动，未提交/未发版）

---

## 一、这是什么

一个 **DSH（DeepSeek Harness）插件**，给「大白饭中转站」（白饭API，new-api 的二开）做**余额可视化 + 用量统计**。

用户侧看到的东西：

| 位置 | 内容 |
| --- | --- |
| 侧栏头像上方 | **账户余额**（整个账号还剩多少钱） |
| 输入框下方统计行 | **该 api key 自己的额度**（key额度） |
| 头像 → 设置 → **大白饭余额** | 凭据配置、显示与个性化、用量看板 |
| 输入框 | `/balance [account\|key\|today\|week]`（1.20.0 起**移除** `relay_balance` 工具） |
| 输入框 | `/balance [account\|key\|today\|week]` 斜杠命令 |

两个位置刻意显示**不同口径**，数值前会标「账户」或「key额度」，用户不会混淆。

---

## 二、代码结构

```
dsh-baifan-balance/
├── lib/index.js        ← Host 侧（Node/ESM，~1270 行）：命令、四条本地路由、凭据与换算
├── client.js           ← 浏览器侧（~1090 行）：两个 slot 组件 + 设置页
├── cordis.patch.yml    ← 往 profile 插入插件行（id: baifan-balance）
├── locale/{zh,en}.json ← Plugin Manager 里显示的标题/描述
├── icon.svg
├── package.json        ← dsh.bundle.patch + dsh.client 清单
├── README.md           ← 仓库首页（面向用户）
├── INSTALL.md          ← 面向终端用户的三步安装
├── FEATURES.md         ← 功能规格（唯一事实源）
└── HANDOFF.md          ← 本文件
```

**零依赖**：不 import 任何 `@deepseek-ai/*` 包，直接构造注册表接受的 JSON Schema 定义，也不做构建（`client.js` 用 `window.__ModuleLoader__.load` 手写模块）。

---

## 三、关键设计（这些是踩出来的，改动前务必看）

### 1. 两种凭据槽（不是两个并列渠道）

| 槽 | 凭据 | 接口 | 能查到 |
| --- | --- | --- | --- |
| account | 访问令牌（`nap_...`） | `GET /api/user/self` | 账户剩余/已用、账号、分组、请求数 |
| key | api key（`sk-...`） | `GET /api/usage/token/` | 该 key 自己的额度；**被授权时还带账户额度** |
| key（老站点回退） | `sk-...` | `/v1/dashboard/billing/*` | 只有 key 额度；不限额时返回哨兵值 |

**new-api 的关键事实**（都是实测出来的）：

- `GET /api/usage/token/` 返回 `{total_granted, total_available, total_used, unlimited_quota, name, user_quota?}`
- 只有当**该令牌**在站点「编辑 API 密钥 → 高级设置 → 允许查询用户额度」(`allow_user_quota_query`) 打开时，才多带 `user_quota`
- 老接口 `/v1/dashboard/billing/subscription` 受后台全局开关 `DisplayTokenStatEnabled` 控制：开着就是令牌级，且不限额令牌返回 `hard_limit_usd = 100000000`（哨兵，**不是真余额**）
- 单位换算：`quota / quota_per_unit × usd_exchange_rate`（当前站点 `500000` / `CNY` / `7`），**参数从 `/api/status` 现读**，不要写死
- Claude 语义 `/v1/messages` 的日志里 `prompt_tokens` **不含**缓存读，人工对账时容易算错

### 2. 「不限额」与负余额

站点对 `unlimited_quota: true` 的令牌会把 `remain_quota` 记成负数。插件把这种情况识别为 **无限制**，不显示负数、不参与低余额告警。

### 3. 静默回退是个坑（已修）

早期设计「key 查不通就回退显示账户余额」，导致用户以为下面看的是 key 的额度。现在：

- `keyMissing: true`（**根本没配** key）→ 才回退显示账户
- key 配了但查不通 → 下方红字 **「key 查不到」**，悬停给出具体原因

### 4. 路由注册必须用 `ctx.inject`

**这是最重要的一条。** 早期写法：

```js
const webServer = ctx.get('webServer')
if (webServer !== undefined) { …注册路由… }   // ❌ 启动早期取不到就永远不注册
```

DSH 重启时 `webServer` 尚未就绪 → 路由一条都不挂 → 界面 404，只能手动关开插件救回。现已改为：

```js
ctx.inject(['webServer'], (webCtx) => { …四条路由… })   // ✅ 等服务就绪
ctx.inject(['commands'],   (cmdCtx) => { …/balance… })
```

改动这一带时**不要退回 `ctx.get` + if**。

### 4b. 服务必须延迟取（与 4 同源的另一半坑）

`apply()` 里**不要**把 `ctx.get('credentials')` 之类的结果存进对象：插件可能先于该服务激活，那一刻拿到 `undefined` 并永久缓存。

```js
const services = { credentials: ctx.get('credentials'), … }   // ❌ 一次拿到 undefined 就永远没有
const services = { get credentials() { return ctx.get('credentials') }, … }  // ✅ 每次用时再取
```

症状：自动检测永远为空、账户凭据退回旧来源、一键授权按钮不出现。

### 5. 客户端共享状态

`client.js` 里有三个模块级 store：

- `settingsStore`：配置（`/config` 的 settings 部分），订阅式
- `summaryStore`：余额读数，**一个节拍器**（`ensureTicker`）伺候所有订阅者
- 设置页的 `submit()` 保存后会 `refreshSettings()` + `loadSummary(true)`，所以外面两处会同步更新

不要在组件里各自 `fetch`，否则会出现「设置页刷新了、外面没变」。

---

## 四、Host 侧接口（client 依赖，改签名要同步改）

```
GET  /baifan-balance/summary[?force=1]
  → { ok, configured, site, currency, checked_at,
      account?: {scope:'account', remaining, used, total, account, group, request_count, credential_name, …},
      key?:     {scope:'token', remaining, used, total, unlimited?, credential_name, credential_ref,
                 account_quota?: {remaining, used, total}},   ← 被授权时才有
      accountError?, keyError?, keyMissing? }

GET  /baifan-balance/config
  → { ok, baseUrl, timeoutMs, settings{…}, credentials{account,key}, autoRefs[{ref,tail}], canSaveConfig }

POST /baifan-balance/config      ← 保存配置；只接受本机 + 同源
  body: baseUrl?, timeoutMs?, surface?, refreshSeconds?, detail?, showIcon?, accent?,
        lowBalanceAccount?, lowBalanceKey?, autoDetectKey?,
        accessToken?, apiKey?（null = 清除，缺省 = 不改）

POST /baifan-balance/authorize-key
  → 用访问令牌把「当前这条 api key」的 allow_user_quota_query 打开；幂等
  → { ok, already, name }

GET  /baifan-balance/usage?days=7|14|30   ← 界面只给这三个按钮，路由本身把 days 夹到 1–30
  → { ok, days, totals{amount,count,average,tokens,cacheTokens}, daily[{date,count,amount,tokens}],
      models[{model,count,amount,tokens}], recent[{at,model,token,amount}] }
```

`/balance today|week` **不走这条路由**：直接复用同侧的 `readUsage(1|7)`（自然日区间），需要访问令牌；
`readUsage` 的第五个参数是 `signal`，命令调用时会把 AbortSignal 传进去。



**安全约定（勿削弱）**：四条路由都要求 `isLocalHost`（只认 `127.0.0.1` / `localhost` / `[::1]`，防 DNS rebinding）；写操作额外要求 `isSameOrigin`（Origin 与 Host 一致）。返回值里**永远不含完整密钥**，只有来源和末四位。

---

## 五、配置项（`config` 里）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://baifanapi.awstme.top` | 不带 `/v1`（会自动剥掉） |
| `timeoutMs` | 15000 | **整次查询**的总预算，不是单请求 |
| `surface` | `both` | `both` / `avatar` / `bottom` / `hidden` |
| `refreshSeconds` | 60 | 15–600 |
| `detail` | `standard` | `compact` / `standard` / `detailed`（控制悬停信息量与是否显示已用） |
| `showIcon` | true | 硬币图标 |
| `accent` | `auto` | `auto`/`brand`/`success`/`warn`；同时控制图标与看板柱子颜色 |
| `lowBalanceAccount` | 1 | 账户余额低于此值变红，0 关闭 |
| `lowBalanceKey` | 1 | key 额度低于此值变红，0 关闭 |
| `autoDetectKey` | true | 自动跟随 DSH 当前（默认）提供商的 api key |
| `key`/`token`/`accessToken` | — | 直接写配置里（优先级高于设置页） |

凭据优先级：**插件配置 > 设置页记录（credentials） > 环境变量 > 自动检测**。

> 1.20.0 起移除了「包目录下 `secret.json`」这一层：它只服务开发机，分发时忘删就是泄露凭据。
> 同时移除了 `relay_balance` 工具与其参数（`channel`/`key`/`base_url`），`/balance` 命令保留。

自动检测**优先跟随 DSH 当前（默认）提供商**：`agentDefaultModel.currentSelection().provider` → `llm.listConfigurableProviders()` 取 `settingsNs`/`settingsPath` → `settings.describe({redactSecrets:true})` 取 `apiKeyEnv` → 用该引用去凭据服务取 key。任一环节读不到时，退回固定顺序：`DABAIFAN_CESHI_API_KEY` → `DABAIFAN_API_KEY` → `BAIFAN_API_KEY` → `NEWAPI_API_KEY` → `OPENCODE_API_KEY`。结果缓存 60 秒（`describe()` 有磁盘 I/O）。设置页只显示「当前提供商」，**没有**手动选凭据的下拉。

---

## 六、用户（站长）明确的偏好

这些是反复调过的结论，改 UI 时别推翻：

1. **中文界面**，结果文本也中文；英文只用于 Plugin Manager 的元数据
2. **设置页自动保存**：选择框/复选框 onchange 即提交；数值/文本字段改过之后行内才出现「保存」；**底部没有全局保存按钮**
3. **分组标题**要醒目（13px、一级文字色），组间距 26px；控件列宽统一 **260px**
4. 用量看板**默认折叠**，标题行先给**今日/昨日**快捷摘要（按日期取值，跨天不会误标），再给所选天数总量；展开后可选 7/14/30 天；**统计按自然日**（今天 0 点往后推 N 天），不按滚动 24h
5. **不要显示 token 总量**（已按用户要求移除；接口仍返回 `tokens`/`cacheTokens` 字段，随时可加回）
6. 头像上方 = 账户，下方 = key，**不要合并成同一个数**
7. 低余额变**红**（`--dsw-alias-state-error-primary`），hover 不能把红色改成灰色

---

## 七、开发与验证

### 本地跑

```bash
cd D:\PRJ\baifan\dsh-baifan-balance
# 语法自检（Electron 自带 node）
"D:\deepseek-harness\DeepSeek Harness.exe" --check lib/index.js   # 需 ELECTRON_RUN_AS_NODE=1
```

### 装/重载（本机）

`plugin_manager` 工具：

```
set_bundle  target=dsh-baifan-balance  enabled=false
set_bundle  target=dsh-baifan-balance  enabled=true
```

`application: applied` 才算生效。**修改 client.js 后必须重载一次**，否则浏览器拿的是旧模块代。

### 接口验证（本机回环）

```powershell
$base = (从 runtime context 取当前 GUI 端口，例如 http://127.0.0.1:7113)
curl "$base/baifan-balance/summary?force=1"
curl "$base/baifan-balance/config"
curl "$base/baifan-balance/usage?days=7"
# 安全：外站 Host 应 403，跨站 POST 应 403
curl -H "Host: evil.example" "$base/baifan-balance/summary"
```

### 已备的自测脚本（`D:\PRJ\baifan\.dsh-probe\`）

| 脚本 | 测什么 |
| --- | --- |
| `check-config.js` | Host 配置读写 + 设置页渲染 |
| `check-split.js` | 两处口径分离、回退、标记 |
| `check-click.js` | 点击是否真的 `force=1` 重查 |
| `check-board.js` | 看板渲染 + 折叠标题的今日/昨日摘要 |
| `check-authorize.js` | 一键授权端到端（会**真的**建/删临时令牌） |
| `check-edge.js` | 无限额度、未配置、Host 校验 |

⚠️ 这些脚本是**按 state 下标**伪造 React hook 的。给 `SettingsPage` 加 `useState` 后，脚本里的 `slots[i] = …` 会错位，需要同步调整。更稳的写法是按 key 而不是下标。

路由改 `ctx.inject` 之后，Host 侧三个探针（`check-config` / `check-edge` / `check-authorize`）的假 ctx 曾同时缺 `effect`、不收集路由；现已补齐 `effect` 与共用的 `routeWebServer`。以后再动路由注册方式，先把这几处假 ctx 一起改掉，否则脚本会整批报 `webCtx.effect is not a function`。

`/balance today|week` 目前没有落盘的探针：验证方式是给 `lib/index.js` 造一个假 `commands.register` + 假 `fetch`（`/api/status`、`/api/data/self`、`/api/log/self` 三份响应），直接调 `handler({ rawInput })`，无需连真站点。

---

## 八、发布

**三个渠道都在用**：

| 渠道 | 命令 / 位置 |
| --- | --- |
| git（GitHub + AtomGit 双推） | `git push origin main && git push atomgit main`，tag `vX.Y.Z` |
| zip | `D:\PRJ\baifan\dist\dsh-baifan-balance-X.Y.Z.zip`（手工白名单拷贝，务必排除 `secret.json`） |
| npm | `npm publish --access public --otp=<6位码>`（账号开了 2FA，必须带 OTP；token 方式被 npm 限制） |

**发版检查清单**：

1. 改 `package.json` 的 `version`（升 patch/minor 按需）
2. `node --check lib/index.js` 与 `client.js`
3. 重载 bundle，确认三条路由 200
4. `npm pack --dry-run` 看文件列表（**不应含 secret.json / .dsh-probe**）
5. 打包 zip 后核对内容
6. `git tag -f vX.Y.Z && git push`（含 tag）

**已知坑**：

- 用 PowerShell 改 `package.json` 可能写入 **UTF-8 BOM**，npm/DSH 读取会报错 → 写完检查前 3 字节不是 `EF BB BF`
- `npm publish` 的输出不要用 `| Select-Object -First N` 接，会掐断进程（表现为 exit=-1）
- 本机 `git` 访问 GitHub **HTTPS 被重置**，走 SSH（`~/.ssh/config` 已把 github.com 指到 443）；AtomGit 也必须用 SSH
- npm 上的包**没有真正发布过正式版**（2026-11-18 查 `npm view dsh-baifan-balance versions` 只有 `0.0.0-stage` 与 `1.12.1`，后者是手动发的占位），所以 1.20.0 是第一个要正式走 `npm publish --otp` 的版本——发之前先让站长确认账号与 2FA
- `dist/发布说明.md` 已同步到 1.20.0 话术（zip 文件名、`/balance today|week`、今日/昨日摘要）；**下一次发版要按实际版本号再核对一遍**，且 zip 本身仍需手工白名单打包

---

## 九、当前状态与待办

**已实现**：两处余额显示（账户/key 分离）、自动跟随提供商取 key、一键开启账户额度查询、设置页自动保存、用量看板（自然日、7/14/30 天、折叠、折叠时今日/昨日摘要）、三入口（界面×2 / `/balance` 命令，含 today/week）、安全校验。

**待办 / 可以考虑**：

1. **前端零自动化测试**：手写 harness 已恢复可用，但仍没有真的 React 渲染环境；若长期维护，建议引入 vitest + RTL
2. **npm 正式发布**：需要站长出 OTP
3. 看板可加**按模型的 tokens**（接口已有字段；注意「不要显示 token 总量」是站长明确要求，只加在模型维度要先问过）
4. 用户提过「按头像弹出面板」（类似 Codex）——2026-11-18 已确认本机 DSH（`D:\deepseek-harness\resources\app.asar`）**确实有** `shell.overlay`：内置团队开关、配额提示都用它注册（`ctx.slots.inject('shell.overlay', …)` + `children: {'…': {kind:'chain', scope:'root'}}`）。可行，但要先摸清锚定（anchor）与挂载点的约定，且**必须让用户截图确认**——agent 看不到渲染结果

---

## 十、维护须知

- **不要再引入「包内凭据文件」这类兜底**：1.20.0 已移除 `secret.json`，代码里也没有读取本地密钥文件的路径；确实需要临时凭据时用环境变量或设置页
- 站点的 `system_name` 是「白饭API」，但用户要求界面叫「大白饭余额」，两者不要强行统一
- 任何「静默兜底」的设计都要三思：这个项目已经被静默回退坑过一次（key 查不到却显示账户余额）
- `.dsh-probe/` 里的 `check-edge.js`、`check-authorize.js` 硬编码了真站点凭据（本地脚本，不在包里也没进仓库）：使用前确认凭据是否还有效，且它们会连真站点（授权探针还会建/删临时令牌）；**不要把这两个脚本拷进插件目录或发布包**，也别把里面的凭据贴出来
- 用户很在意视觉细节，改 UI 后请他截图确认；**agent 没有浏览器控制，看不到渲染结果**
