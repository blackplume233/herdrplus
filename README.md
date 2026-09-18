# HerdrPlus（VSCode 扩展形态）

把 herdr 塞进 VSCode：**左侧/右侧侧栏看 workspace 与 agent，中间编辑器区跑 herdr 终端，终端 tab 右键直接起 Agent。**
herdr 的 TUI 仍是真的（ConPTY 里跑 `herdr.exe`），扩展只做外骨骼 —— 全部数据来自 herdr 的 socket API。

## 能力

### 交互规则（右侧栏）

侧栏是**两个原生 view**（上 Workspaces / 下 Agents，VSCode 自己画标题栏、分隔条、折叠与独立滚动）：

| 元素 | 行为 | 反馈 |
| --- | --- | --- |
| **`Workspaces` 标题按钮** `↕` | 切换排序：序号 / 待处理优先 | 标题旁的灰字显示当前模式（`7 · 序号`）；关注度：等待输入 → 工作中 → 完成 → 空闲 |
| **`Workspaces` 标题按钮** `＋` | 新建 workspace | InputBox |
| **`Workspaces` 标题按钮** `▣` | 打开 / 聚焦 herdr 终端（全局动作放全局位置） | — |
| **`Workspaces` 标题按钮** `▤` | **归档关闭**：一次关掉所有「空闲/完成且非当前」的 workspace | 内联确认条列出清单（含「其中 M 个还有没结束的 agent」）；只关容器不删目录 |
| **`Workspaces` 标题按钮** `⟳` | 重新读 herdr 状态（事件驱动，正常不用点） | — |
| **`Agents` 标题** | — | 灰字显示 agent 数与待处理数（`4 · 1 待处理`） |
| **点 workspace 行主体** | 切到该 workspace | **乐观**：当前标识立刻移动；同时**精确亮出该 workspace 的那个终端**（`show(preserveFocus)`，不抢侧栏焦点） |
| **点 tab 行主体** | 切到该 tab（服务端 `tab.focus`） | 同上：亮出**钉在这个 (workspace, tab) 的终端** —— 一个 tab 一个页签，点哪个亮哪个 |
| **点 pane 行主体** | 跳到那个 pane | 同上：亮出它所属 tab 的终端 |
| **点 pane 行主体**（Agents view 任意行、workspace 展开后的子行） | 跳到那个 pane | 同上；`focusPane` → 服务端 `focused_pane_id` |
| **行首 `▸/▾`**（workspace 行） | 展开/折叠：**workspace → tab → pane** 三层（tab = herdr 的「终端」，一行一个；每个 tab 下挂它的 pane） | 展开集合按 webview 记忆；默认全折叠。点 tab 行 = 切服务端当前 tab。**缩进是算出来的**：`padding-left = --hp-row-pad + 层级 × --hp-indent`（层级由渲染层写在行上的 `--depth`），每层等距、叶子行也占 caret 槽 —— 加一层不用改 CSS，也不会出现「子项跑到父项左边」 |
| tab 行 hover：`▣` / `▣⁺` | 在 herdr 终端里切到这个 tab / **为这个 tab 新开一个终端页签**（激活即切过去） | 一个 herdr tab ↔ 一个 VSCode 终端页签 |
| workspace 行右键：`▣⁺ 为每个 tab 各开一个终端页签` | 一次把这个 workspace 的每个 herdr tab 各开成一个终端页签 | 页签栏就是她的 tab 列表 |
| **当前标识**（侧栏里唯一的强标识） | — | 左侧 2px accent 竖条 + 选中底色 + 标签加粗 —— 只表示「终端正在显示它」 |
| workspace 行 hover：`▷` | 新建 herdr workspace + 新终端并启动 Agent（**指向该行**） | QuickPick 选 kind；agent 名在 session 内唯一，重名自动 `pi-2`/`pi-3` |
| workspace 行 hover：`▣⁺` | 新开一个终端并**钉在这个 workspace**（激活该标签就切过去） | 终端的工作目录 = 该 workspace 的**锚定目录**（没锚定才用当前 pane 的目录，见下） |
| workspace 行 hover：`✕` | 关闭这个 workspace（**只关容器，不删目录**） | 里面有没结束的 agent 时**先出内联确认条** |
| pane 行 hover：`▣` | 在 herdr 终端里**跳到这个 pane** | 只留终端动作；预览功能已移除 |
| 行右键（workspace） | `▣ 打开 / 聚焦 herdr 终端`（全局）、`▣⁺ 新开终端并钉在这个 workspace`、`▣⁺ 为每个 tab 各开一个终端页签`、`▣ 设置 / 更改工作目录…`、`✕ 清除工作目录`（仅已锚定）、`重命名…`、`关闭 workspace`（红色） | Esc / 点别处关闭；越界自动夹回视口 |
| 行右键（pane） | `在 herdr 终端里跳到这个 pane`、`重命名 pane…`、`关闭 pane`（红色，会结束进程） | 关 pane **先出确认条** |
| 确认条 | 破坏性操作的二次确认（关 workspace / 关 pane / 归档关闭） | 按钮文案 `仍然关闭` / `关闭 pane` / `关闭这些` + `取消`；Esc = 取消，Enter = 确认 |

**设计原则**：行内只留「指向该行」的高频动作 —— **一切以终端为中心**（切过去、跳过去、起 Agent、为它开终端、关掉）；全局动作在 view 标题上（VSCode 原生的 title action，列表折叠时也够得着），低频动作（重命名）在右键菜单。只读预览功能已移除（文本重放渲染不准，不如直接开终端）。**图标语言**：`▣` = 打开 / 聚焦**已有**终端；`▣⁺` = **新开**一个终端 —— 凡是「开终端」的动作一律用终端字形，不用分屏 / 图钉之类的字形。

**为什么确认条不是系统弹窗**：`showWarningMessage(..., {modal: true})` 在 VSCode 1.13x 是**原生 OS 对话框** —— 不在 workbench DOM 里、CDP 抓不到、自动化也点不动（QA 实测：键盘事件打不进去，只会把焦点还给 webview 再触发一次原按钮）。内联确认条既能列出「到底要关哪些」，又能被 QA 端到端验证（确认前不动 / 确认后真关 / 取消则不动）。

| 区域 | 行为 |
| --- | --- |
| 侧栏（活动栏或第二侧栏，1.106+ 走后者） | **两个原生 view 上下分栏**：`Workspaces`（容器：状态点 + 标签 + 第二行 = **锚定目录**（有锚定时最前）+ `N pane · N tab · N agent`；两样都没有才退回显示当前 pane 的目录，行首 `▸` 可展开出它的 pane）+ `Agents`（干活的：pane 终端标题 + 状态词 + `workspace · tab N`）；两块各自滚动、可拖动分隔、各自折叠，尺寸由 VSCode 记忆 |
| 中间区 | `herdr` 终端（编辑器区或面板，可配）；**侧栏点击 → 内嵌终端跟着切到那个 workspace**；要并存多个就 `Herdr: 在当前 workspace 新开一个终端` / `新开 herdr 终端视图`（选 workspace / tab / 另一个 session） |
| 终端 tab 右键 | 启动 Agent（新终端）/ 在当前 workspace 新开一个终端 |
| 状态栏 | `herdr: socket · Nws/Mpane`，点击打开终端 |
| 内嵌终端的 herdr chrome | **全部关掉**（侧栏 / 单 tab 的 tab 行 / pane 外框），终端区就是纯终端 |

### 工作目录（workspace 锚定）

herdr 的 workspace **本身没有目录字段** —— 目录挂在 pane 上（`pane.cwd` / `pane.foreground_cwd`）。所以「workspace 的目录」是扩展侧的一层锚定：

- **谁会被锚定**：本扩展创建的 workspace（`新建 Workspace` 用当前 VSCode 工作区目录；`启动 Agent（新终端）` 用同一个目录）在创建成功那一刻记下目录；CLI / herdr TUI 建的 workspace 默认不锚定。
- **手动改**：workspace 右键 `设置 / 更改工作目录…`（InputBox，默认值 = 当前锚定或 VSCode 工作区目录）、`清除工作目录`（回到跟随 pane）。
- **存哪**：`globalState`（`herdrplus.workspaceCwd`），重载窗口 / 换 VSCode 工作区都还在；快照里消失的 workspace 会立刻丢掉（herdr 会复用 `workspace_id`，留着会串目录）。
- **怎么用**：开终端时 `terminalCwdFor()` 依次取 ① 指定了 tab → 那个 tab 当前 pane 的目录；② 否则**锚定目录**；③ 都没锚定 → 当前 pane 的目录。目录不存在（被删 / UNC 掉线）一律当没给，退回 VSCode 默认，不弹报错。

没有锚定会怎样：pane 里 `cd` 一下，之后从这台 workspace 开的**每个**终端就都跑到那个目录去了 —— 锚定把「容器的位置」和「pane 的当前位置」分开；这也是 VSCode 自己「新终端用工作区目录」的直觉。

### 交互模型（一句话）

**侧栏是切换器，内嵌终端是「当前 workspace 的实时视图」。** 点侧栏任意一行 → 调 `workspace.focus` → 服务端焦点变化 → 终端立刻显示该 workspace 的 pane（QA 断言：切换前后终端内容里的标记随之变化）。所以 `▣` 是**打开/聚焦**同一个终端，不会点一次开一个。

**为什么两块**：两个问题不一样。`Workspaces` 回答「容器在哪」（位置 / 目录 / 容量），`Agents` 回答「谁在干活、谁在等我」（状态，可按关注度排序）。混在一层时，一台 workspace 里跑两个 agent 就只能显示成 `2 agent` —— 具体是谁在等你就看不见了。侧栏的 QA 夹具专门放了一台跑两个 agent 的 workspace 来守这条。

**为什么是原生 view 而不是自己画分栏**：用 `contributes.views` 声明两块，VSCode 就替你画标题栏、分隔条、滚动条和折叠动画 —— 观感和 VSCode 自己的侧栏完全一致，尺寸/折叠状态由 VSCode 记忆，我们也不用手写拖拽逻辑。代价只有：两个 webview 各渲染一段（同一个 provider 按 `view.viewType` 分派），全局动作要挂到 `view/title` 上。

**为什么 workspace 上的 tab/pane 折叠着**：默认折叠保持列表密度（一眼看完所有容器）；需要看容器内部结构时（哪个 tab 里是什么）再 `▸` 展开成 pane 行。展开的 pane 行同时是「精确跳转」的入口 —— Agents 段回答状态，展开行回答结构，两者共用同一份渲染。

## 在 herdr 里开 VS Code（嵌套）

herdr 默认禁止嵌套（`[experimental] allow_nested = false`），而"在 herdr pane 里启动 VS Code，再用本扩展拉起 herdr 客户端"正好命中这条限制：扩展宿主会继承 `HERDR_ENV` / `HERDR_PANE_ID` / … → herdr 直接以
`error: nested herdr is disabled by default` 退出 → 终端开完即消失。

扩展的处理（两层）：

1. 拉终端时把"我在某个 pane 里"的标记清掉（`HERDR_ENV` / `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` / `HERDR_CLIENT_SOCKET_PATH` 置 `null`），
   只保留会话选择与 socket 端点（`HERDR_SESSION` / `HERDR_SOCKET_PATH`）—— 我们本来就要连同一个 server；
2. 生成的配置里加 `[experimental] allow_nested = true`（只对扩展拉起的终端生效）。

终端若仍在 8 秒内退出，会弹提示并引导 `Herdr: 诊断`，不再静默消失。

### 默认快捷键

| 快捷键 | 命令 |
| --- | --- |
| `Ctrl+Alt+H` | 打开/聚焦 herdr 终端 |
| `Ctrl+Alt+Shift+H` | 聚焦 Herdr 侧栏 |
| `Ctrl+Alt+A` | 启动 Agent（新终端） |
| `Ctrl+Alt+N` | 新建 Workspace |

（macOS 用 `Cmd+Alt+…`；都是默认值，可在快捷键设置里改。`Herdr: 新开 herdr 终端视图` 在命令面板里。）

## 同时看多个 workspace / agent

先讲清 herdr 这边的硬约束（实测 + API schema 证据）：**`focused_workspace_id` 是服务端单值**，pane 呈现是**单一 surface**——
`herdr api schema` 里相关方法只有 `client_shell.surface.set {active}`（"whether the requesting client shell receives and controls pane presentation"），
端点能力是 `surface_interest: true` 但 `live_handoff: false`。所以**同一个 session 上的多个 TUI 客户端必然显示同一个 workspace**，这不是扩展的锅。

于是有三条可用路子，覆盖不同需求：

| 想要的效果 | 用哪个 | 同时性 | 可交互 |
| --- | --- | --- | --- |
| 标签页各自记住一个位置（workspace / tab / session），切标签即切过去 | `Herdr: 新开 herdr 终端视图` → 选 workspace / session；或 `在当前 workspace 新开一个终端`；或行右键 `为每个 tab 各开一个终端页签` | 否（服务端焦点切过去） | ✅ 真 TUI |
| 两个终端**同时**显示不同且都可交互 | `Herdr: 新开 herdr 终端视图` → 选 `session: <另一个 session>` | ✅ | ✅ 真 TUI |
| 一个终端里上下看多个 pane | 在 herdr TUI 里自己 split pane（那是 herdr 的 layout，扩展原样显示） | ✅ | ✅ 真 TUI |

**为什么第三种成立**：session 在 herdr 里是「一个 server 实例」，各自有自己的 workspaces 与焦点（`herdr session list` 能看到多台）。
把一个终端绑到另一个 session，就等于开了第二个 herdr 实例 —— 这正是「多个 herdr 实例各显示各的」。

## 发布

```bash
bun install
bun run typecheck          # tsc --noEmit
bun run build              # esbuild：dist/extension.js + media/sidebar.js + media/style.css
bun run qa                 # 真实 VSCode + 隔离 herdr session 的端到端断言，截图落 reports/qa
npx @vscode/vsce package --no-dependencies --allow-missing-repository
```

- 产物：`herdrplus-<version>.vsix`（约 50 KB；只含 `dist/` + `media/` + 元数据，`src/ scripts/ reports/ node_modules/` 都被 `.vscodeignore` 排除）。
- 本地装：`code --install-extension herdrplus-0.1.0.vsix`。
- 发 Marketplace：
  - **CI（推荐）**：仓库 secret 里配 `VSCE_PAT`（Azure DevOps PAT，scope = Marketplace → Manage），然后打 tag 推送 —— `git tag v0.2.0 && git push origin v0.2.0`。
    `.github/workflows/release.yml` 会 typecheck → build → package → 发 Marketplace（配了 `OVSX_PAT` 就顺便发 Open VSX）→ 把 vsix 附到 GitHub Release。
  - **本地**：`vsce login <publisher>` 或 `$env:VSCE_PAT=<token>`，再 `npx @vscode/vsce publish --packagePath herdrplus-<version>.vsix`。
  - **零凭据**：<https://marketplace.visualstudio.com/manage> → publisher → New extension → 直接传 vsix。
- CI：`.github/workflows/ci.yml`（每次 push/PR：typecheck + build + 打包产物）；`.github/workflows/qa.yml`（手动/每晚，Windows runner 上装 herdr + 便携 VS Code 跑完整 QA，截图存 artifact）。
- 发版前改 `package.json.version` 并在 `CHANGELOG.md` 加一节；`icon` 用 `media/icon.png`（256×256 PNG，由 `media/herdr.svg` 渲染而来）。

## herdr 从哪来（扩展不会替你安装）

**不会**。扩展里没有任何下载/安装/更新 herdr 的代码，只负责**找到并驱动**它：

1. `herdrplus.binaryPath` 设置（非空则直接用）；
2. `~/.herdr/packages/standalone/releases/*windows*/herdr.exe`（多个版本时取最新）；
3. `~/.local/bin/herdr`、`/usr/local/bin/herdr`、`/opt/homebrew/bin/herdr`；
4. PATH（Windows `where herdr` / 其它 `which herdr`）。

都没有时：侧栏顶部给 `定位 herdr` 与 `安装说明（herdr.dev）` 两个入口；`Herdr: 定位/检查 herdr` 会先问要不要打开官方安装说明，再允许手填可执行文件路径（写进设置并重连）。herdr 自己的版本管理与 `herdr update` 归它自己管。

## 内嵌终端为什么是 bare 的

导航已经在 VSCode 侧栏里、分栏已经是 VSCode 的 tab/split，终端里再画 herdr 自己的侧栏 / tab 行 / 外框就是重复。herdr 没有启动期开关，只能靠配置项：

```toml
onboarding = false                   # 关掉首启引导（全新机器上它会盖在终端里，还自带说明文字）
[ui]
sidebar_start_collapsed = true       # 启动即收起侧栏
sidebar_collapsed_mode = "hidden"    # 收起即零宽（compact 会留一条窄状态轨）
hide_tab_bar_when_single_tab = true  # 单 tab 不画 tab 行
pane_outer_borders = false           # 不画 pane 外框
[experimental]
allow_nested = true                  # 允许「在 herdr pane 里开 VS Code」这种嵌套（否则终端开完即消失）
```

（这五条 + `allow_nested` 都用 `herdr config check` 校验过：`config: ok`。）

扩展在激活时把你的 `config.toml` 内容 + 上面这些覆盖，写到扩展的 globalStorage（`herdr-config.toml`），
再用 `HERDR_CONFIG_PATH` 只对**扩展拉起的终端**生效 —— 不改你的全局配置。
（`HERDR_CONFIG_PATH` 是覆盖而非叠加，所以必须先把你原配置一起带过去。）

* 想要回退：设置 `herdrplus.bareTerminal = false`。
* 想临时展开侧栏：herdr 默认 `ctrl+b` 是 `toggle_sidebar`（终端里仍然可用）。
* 想指定别的配置文件：`herdrplus.herdrConfigPath`。

## 设置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `herdrplus.binaryPath` | `""` | herdr 可执行文件；留空自动探测（`where herdr` / `~/.herdr/packages/standalone/releases/*/herdr.exe`） |
| `herdrplus.socketPath` | `""` | socket 端点；留空 = `%APPDATA%\herdr\herdr.sock`（或 `HERDR_SOCKET_PATH`） |
| `herdrplus.agents` | `["pi","omp"]` | 右键菜单里可启动的 kind（`herdr agent start --kind` 的取值，共 24 种） |
| `herdrplus.openIn` | `"editor"` | 终端落在编辑器区（对齐 VSCode 观感）还是底部面板 |
| `herdrplus.useCliFallback` | `true` | socket 不可用时回退 `herdr` CLI 轮询 |
| `herdrplus.bareTerminal` | `true` | 内嵌终端只显示终端内容（上面那四条 `[ui]` 覆盖） |

## 数据通道（实测结论，勿想当然）

* herdr socket API 是换行分隔 JSON，请求 `{id, method, params}`（`params` 必填）。
* **一次连接只服务一个请求**：响应后服务端立刻关闭，同一连接上的第二个请求必然 `EPIPE`。
  因此每个请求开一条短连接（和 herdr CLI 的做法一致）。
* `events.subscribe` 是唯一的长连接：订阅后持续推事件；作用域事件必须带字段
  （`pane.agent_status_changed` / `pane.scroll_changed` 要 `pane_id`，`pane.output_matched` 还要 `source` + `match`）。
  扩展在事件到达后**重取快照**（不解析事件负载建模），侧栏因此永远等于服务端状态。
* Windows 端点 = 命名管道，路径 = `\\.\pipe\` + socket 文件路径（drive letter 一起带上）。
* `herdr api schema --json` 是类型真源（`vendor/herdr-schema.json`，protocol 22，106 个方法）。

## 开发

```bash
bun install
bun run build        # esbuild：dist/extension.js（宿主，CJS）+ media/sidebar.js|style.css（webview）
bun run dev          # watch
bun run typecheck
```

按 `F5`（或 `bun run build` 后在扩展开发宿主里加载本目录）即可调试。

## 侧栏渲染（为什么不会闪）

事件（`pane.updated` 等）在 agent 输出时会高频到达，每次都重建 DOM 就是肉眼可见的闪烁。所以：

* 宿主侧：事件到达 → 防抖 120ms → **重取快照**（不解析事件负载），再 postMessage；
* webview 侧：骨架只建一次，之后按 `data-key`（`ws:w1` / `tab:w1:t1` / `pane:w1:p1`）做**字段级 patch**，
  文本/class 相同就不写 DOM，插入用 `insertBefore` 移动既有节点 —— 节点身份稳定，不重建、不闪。
* QA 用「事件前后 DOM 节点复用率」断言这一点（见下）。

## QA（隔离 session + CDP 驱动真机）

```bash
node src/test/agent/verify.mjs           # 全程隔离，跑完自动清理
node src/test/agent/verify.mjs --keep    # 保留截图/日志（%TEMP%\herdrplus-qa-*）
```

* 使用 `herdr --session herdrplus-qa` 的独立 server + 独立 socket，**不碰你正在用的 session**；
* 拉起 VS Code Insiders（`CODE_INSIDERS_PATH` 可覆盖）→ 打开侧栏 → 校验 bare 配置 → 校验 DOM 节点复用（不闪）
  → 命令面板 → 点侧栏 ▣ 起终端 → tab 右键菜单 → `ctrl+b` 透传 → 起 Agent（新终端）后新 workspace 上屏；
* 截图落 `reports/qa/*.png`。

驱动方式踩过的坑（照抄会浪费半天）：

* CDP 下 `keyboard.type` 打不进 CJK，命令面板里只会留下 ASCII 前缀 → 用 `keyboard.insertText` 一次性插入；
* 焦点在 webview iframe 里时，`Ctrl+Shift+P` 之类的 workbench 快捷键收不到 → 先点一下编辑器区再按；
* **不要**用 Backspace 清空命令面板输入：删掉 `>` 前缀会把命令面板退化成文件搜索；
* 更稳的做法是直接点扩展自己的 UI（侧栏按钮），命令面板只用来做"命令已注册"的断言。

## 已知边界

* 无法把某个 VSCode 终端与 herdr pane 关联（公开 API 无映射）⇒ 需要指定 pane 的动作以「侧栏选中的 pane」为显式目标，不猜"你正看着的那个 pane"。
* `agent start` 只接受处于可用交互 shell 的 pane：新建 workspace 时必须 `focus: true` 让 pane 先渲染（扩展已这样做）。
* **不做 herdr 内部分栏**：一个 VSCode 终端 = 一个 herdr workspace（单 pane）；要多个就开多个终端 tab/split，由 VSCode 负责。
* 无公开 API 新建 auxiliary window ⇒ 浮动侧栏只能用第二侧栏容器，或由你手动把编辑器拖出为窗口。
* 依赖 `chatSessionsProvider` 这类提案 API 的原生会话视图：不采用（见设计文档 §4.9）。
