# Changelog

## 0.1.2

- **workspace 有工作目录了（锚定，不随 pane 漂）**：本扩展创建的 workspace 在创建那刻记下目录（`新建 Workspace` = 当前 VSCode 工作区目录，`启动 Agent（新终端）` 同上），之后**从它开的每个终端都从这里起**；pane 里 `cd` 过也不影响。没锚定的 workspace 保持老行为（跟着当前 pane 的目录），所以 CLI / herdr TUI 建的 workspace 行为不变。
  - 手动：workspace 右键 `设置 / 更改工作目录…`、`清除工作目录（回到跟随 pane）`。
  - 持久化在 `globalState`；快照里消失的 workspace 立刻丢锚（herdr 会复用 `workspace_id`，留着会串目录）。
  - 侧栏 workspace 行的第二行最前面显示锚定目录（`…\extension · 2 pane · 2 tab`）。
- **图标语义收紧**：`▣` = 打开 / 聚焦**已有**终端，`▣⁺` = **新开**一个终端 —— 凡「开终端」的动作一律用终端字形；原来「为这个 tab 新开一个终端页签」用的分屏字形、「新开终端并钉在这个 workspace」用的图钉字形都换掉了（`split` / `pin` 两个字形已删）。
- QA：新增「锚定目录优先于 pane 的当前目录」断言（先锚定、再在 pane 里 `cd` 到别处，从侧栏开终端仍落在锚定目录）。

## 0.1.1

- **移除只读预览（pane 看板）**：它是文本重放、渲染不准，不如直接开终端。相关命令、菜单项、快捷键 `Ctrl+Alt+P`、`pane.read` 调用一并删除（`herdrplus.previewPane` / `previewPaneBeside` 不再存在）。
- **侧栏变成 workspace → tab → pane 三层**：一个 herdr tab 一行（可点，点了切服务端当前 tab），它的 pane 挂在下面；子项缩进逐级向右，不再出现「子项比父项更靠左」。
- **一个 herdr tab ↔ 一个 VSCode 终端页签**：新增 `为每个 tab 各开一个终端页签`（workspace 右键），每个页签钉在 (workspace, tab) 上，**激活哪个页签就把 herdr 的当前 tab 切到它**。
- 新增 `Herdr: 在当前 workspace 新开一个终端`（一键，不用选目标），终端 tab 右键也有。
- workspace 行 hover 的第二个动作从「预览」换成「**新开终端并钉在这个 workspace**」——终端优先。
- **选择即精准**：点 workspace / tab / pane 行时，除了切 herdr 焦点，还会**精确亮出该行对应的那一个终端**（`show(preserveFocus)` 不抢侧栏焦点）；不会再出现「点了 A 却亮了别处」。
- **终端工作目录准确**：从某个 workspace（或某个 tab）开终端时，终端进程的 cwd = 该 workspace/tab 当前 pane 的目录（目录不存在时退回 VSCode 默认，不弹警告）。
- 内嵌终端配置补 `onboarding = false`：全新机器上不再弹 herdr 首启引导（它自带说明文字与 tab 行，破坏「终端是 bare」的承诺）。
- QA：39 → 44 条断言；新增「没有 agent CLI 的环境明确 SKIP 而不是假红」、webview JS 异常回传并断言、关 pane 确认条的取消用例。

## 0.1.0


首个可用版本：把 herdr 变成 VSCode 里的工作台（扩展只做外骨骼，herdr 仍是真 TUI）。

- **侧栏 = 两个原生 view 上下分栏**：`Workspaces`（容器）+ `Agents`（干活的），各自滚动、可拖动分隔、各自折叠，VSCode 记忆尺寸。
  - workspace 行首 `▸/▾` 展开出它的 pane 子行；两段式模型保证「一台 workspace 跑两个 agent」也能各显示一行。
  - 全局动作放 view 标题：`↕` 切排序（序号 / 待处理）· `＋` 新建 · `▣` 打开终端 · `▤` 归档关闭 · `⟳` 刷新。
- **安全关闭**：workspace 行 hover `✕` 关闭（只关容器不删目录）；里面有没结束的 agent 时**先在侧栏出确认条**，Esc 取消、Enter 确认。
- **关 pane 也要确认**：pane 行右键 `关闭 pane`（会结束进程）同样走确认条，文案会写明里面是哪个 agent、什么状态。
- **归档关闭**：一次关掉所有「空闲/完成且非当前」的 workspace，确认条列出清单与「其中 M 个还有没结束的 agent」。
- **内嵌终端**：`herdr` 跑在 VSCode 终端里（bare：无侧栏 / 无单 tab 行 / 无 pane 外框 / 关掉首启引导），侧栏点击即切视图；`Ctrl+Alt+H` 聚焦。
- **每个终端不再都一样**：
  - 钉住终端（`新开 herdr 终端视图` → 选 workspace，或行右键「新开终端并钉在这个 workspace」）：切标签即切服务端焦点。
  - 绑定另一个 session（`session: <name>`）：独立 server 与焦点 → **两个终端可同时显示不同内容且都可交互**。
  - pane 看板：`◫` 默认开在当前编辑器栏；pane 行右键「在新栏打开预览」才并排 → 同时盯多个 agent。
- **Agent**：行 hover `▷` 新建 workspace + 终端并起 agent（kind 可选；名字冲突自动 `pi-2`…）；终端 tab 右键也能起。
- **命令**：`Ctrl+Alt+H` 终端 · `Ctrl+Alt+Shift+H` 侧栏 · `Ctrl+Alt+A` 起 Agent · `Ctrl+Alt+N` 新建 workspace · `Ctrl+Alt+P` 预览 pane，另有排序 / 归档关闭 / 定位 herdr / 安装说明 / 诊断（写报告文件）。
- **不替用户安装 herdr**：只探测（设置 → `~/.herdr/packages/standalone/releases/*` → 常见 bin 目录 → PATH），找不到时给「定位 herdr」与「安装说明（herdr.dev）」。
