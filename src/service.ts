import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { writeEffectiveConfig } from './herdr/config.js';
import { HerdrClient, locateHerdr, locateHerdrOnPath, probeSocket } from './herdr/client.js';
import { AgentInfo, ClientState, SessionSnapshot, SortMode, STATUS_TEXT, SubscriptionEvent } from './herdr/types.js';

export type SidebarSection = 'spaces' | 'agents';

/** 待确认的破坏性操作：侧栏顶部内联确认条渲染它，`confirmPending` 才真正执行。 */
interface PendingConfirm {
  kind: 'closeWorkspace' | 'sweep' | 'closePane';
  title: string;
  confirmLabel: string;
  targets: Array<{ kind: 'workspace' | 'pane'; id: string }>;
}

const execFileAsync = promisify(execFile);

/** `herdr agent start --kind` 支持的 kind 全集（实测 `herdr agent start --help`）。 */
const KNOWN_AGENT_KINDS = [
  'pi', 'omp', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'mastracode',
  'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli',
  'qwen', 'letta', 'maki', 'muse',
];

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'focus'; kind: 'workspace' | 'tab' | 'pane'; id: string }
  | { type: 'action'; action: string; id?: string };

export interface AgentStartOptions {
  /** newTerminal：新建 herdr workspace + 新 VSCode 终端；here：在选中的既有 pane 里启动。 */
  mode: 'newTerminal' | 'here';
  paneId?: string;
}

/** 扩展侧的全部状态与命令实现；webview 只通过 postMessage 与它通信。 */
export class HerdrService implements vscode.Disposable {
  private client: HerdrClient;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly posts = new Set<(message: unknown) => void>();
  private readonly herdrTerminals: vscode.Terminal[] = [];
  private readonly closedTerminals = new Set<vscode.Terminal>();
  /** 内嵌终端 → 钉住的 workspace（没有则跟随服务端焦点）。 */
  private readonly pinnedTerminals = new Map<vscode.Terminal, string>();
  /** 每个 pane 一个只读看板面板（可以并排开多个，同时盯多个 agent）。 */
  private readonly previews = new Map<string, { panel: vscode.WebviewPanel; timer: NodeJS.Timeout }>();

  selectedWorkspaceId?: string;

  /** 排序模式（全局一个，view 标题上的按钮切它）。 */
  sort: SortMode = 'number';

  /** 待确认的破坏性操作（在侧栏里以内联确认条呈现，不用原生 modal：原生框 CDP 抓不到、也没法自动点）。 */
  private pending: PendingConfirm | undefined;

  /** 侧栏（两个 view）的可见性/解析次数等诊断信息。 */
  sidebarResolved = 0;
  sidebarVisible = false;

  /** 已解析的侧栏 view（用于更新标题旁的计数/排序描述）。 */
  private readonly views = new Map<vscode.WebviewView, SidebarSection>();

  /** 最近收到的 webview 消息与命令执行轨迹（诊断报告用）。 */
  private readonly trace: string[] = [];

  private traceAdd(entry: string): void {
    this.trace.push(`${new Date().toISOString().slice(11, 23)} ${entry}`);
    if (this.trace.length > 40) {
      this.trace.shift();
    }
  }

  /** 内嵌终端使用的 herdr 配置路径（含「隐藏 herdr 侧栏」覆盖）。 */
  effectiveConfigPath?: string;

  onSnapshotCallback: (snapshot: SessionSnapshot) => void = () => {};
  onStateCallback: (state: ClientState) => void = () => {};
  onEventCallback: (event: SubscriptionEvent) => void = () => {};

  constructor(private readonly context: vscode.ExtensionContext) {
    this.sort = context.globalState.get<SortMode>('herdrplus.sort') === 'attention' ? 'attention' : 'number';
    this.disposables.push(vscode.window.onDidChangeActiveTerminal((terminal) => this.onActiveTerminalChanged(terminal)));
    const configured = vscode.workspace.getConfiguration('herdrplus').get<string>('binaryPath') ?? '';
    this.client = this.buildClient(locateHerdr(configured));
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('herdrplus')) {
          void vscode.window
            .showInformationMessage('HerdrPlus：配置已变更，需重载窗口后生效。', '重载窗口')
            .then((choice) => {
              if (choice === '重载窗口') {
                void vscode.commands.executeCommand('workbench.action.reloadWindow');
              }
            });
        }
      }),
    );
  }

  private buildClient(binaryPath: string | undefined): HerdrClient {
    const config = vscode.workspace.getConfiguration('herdrplus');
    const client = new HerdrClient({
      binaryPath,
      socketPath: config.get<string>('socketPath') ?? '',
      cliFallback: config.get<boolean>('useCliFallback') ?? true,
      log: (message) => console.log(`[herdrplus] ${message}`),
    });
    client.onState = (state) => {
      console.log(`[herdrplus] state: ${JSON.stringify(state)}`);
      this.onStateCallback(state);
      this.postState();
    };
    client.onSnapshot = (snapshot) => {
      this.onSnapshotCallback(snapshot);
      this.post({ type: 'snapshot', snapshot });
      this.updateViewDescriptions();
      this.refreshPreviewTitles();
    };
    client.onEvent = (event) => {
      this.onEventCallback(event);
      this.post({ type: 'event', event });
    };
    return client;
  }

  get herdrPath(): string | undefined {
    return this.client.binary;
  }

  get state(): ClientState {
    return this.client.currentState;
  }

  get snapshot(): SessionSnapshot | undefined {
    return this.client.currentSnapshot;
  }

  get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  async init(): Promise<void> {
    await this.prepareEffectiveConfig();
    if (!this.client.binary) {
      const found = await locateHerdrOnPath();
      if (found) {
        this.replaceClient(found);
        return;
      }
    }
    this.client.start();
  }

  /** 生成对内嵌终端生效的 herdr 配置（默认隐藏 herdr 自带侧栏）。 */
  private async prepareEffectiveConfig(): Promise<void> {
    const config = vscode.workspace.getConfiguration('herdrplus');
    const hide = config.get<boolean>('hideHerdrSidebar') ?? true;
    const override = (config.get<string>('herdrConfigPath') ?? '').trim();
    if (override) {
      this.effectiveConfigPath = override;
      return;
    }
    this.effectiveConfigPath = writeEffectiveConfig(this.context.globalStorageUri.fsPath, hide);
  }

  setActive(active: boolean): void {
    this.client.setActive(active);
    if (active) {
      void this.client.refresh();
    }
  }

  registerView(view: vscode.WebviewView, section: SidebarSection): void {
    this.views.set(view, section);
    this.sidebarResolved += 1;
    this.notifyViewVisibility();
    this.updateViewDescriptions();
    this.postState();
    this.postPending();
    if (this.snapshot) {
      this.post({ type: 'snapshot', snapshot: this.snapshot });
    }
  }

  unregisterView(view: vscode.WebviewView): void {
    this.views.delete(view);
    this.notifyViewVisibility();
  }

  /**
   * 两块 view 任意一块可见就算「侧栏活着」：可见时客户端全速（订阅事件、刷新预览），
   * 都收起来时降频，别在用户看不见的地方空转。
   */
  notifyViewVisibility(): void {
    const visible = [...this.views.keys()].some((view) => view.visible);
    this.sidebarVisible = visible;
    this.setActive(visible);
  }

  /** view 标题旁的灰字：workspace 那块显示数量 + 当前排序，agent 那块显示 agent 数与待处理数。 */
  private updateViewDescriptions(): void {
    const snapshot = this.snapshot;
    for (const [view, section] of this.views) {
      if (!('description' in view)) {
        continue;
      }
      if (!snapshot) {
        view.description = this.state.kind === 'error' ? '未连接' : undefined;
      } else if (section === 'spaces') {
        view.description = `${snapshot.workspaces.length} · ${this.sort === 'number' ? '序号' : '待处理'}`;
      } else {
        const blocked = snapshot.agents.filter((agent) => agent.agent_status === 'blocked').length;
        view.description = `${snapshot.agents.length}${blocked > 0 ? ` · ${blocked} 待处理` : ''}`;
      }
    }
  }

  /** 切排序：全局一个模式，写完持久化并广播。 */
  async toggleSort(): Promise<void> {
    this.sort = this.sort === 'number' ? 'attention' : 'number';
    await this.context.globalState.update('herdrplus.sort', this.sort);
    this.postState();
    this.updateViewDescriptions();
  }

  /** 待确认的破坏性操作 → 侧栏内联确认条。 */
  private setPending(pending: PendingConfirm | undefined): void {
    this.pending = pending;
    this.postPending();
  }

  private postPending(): void {
    this.post({ type: 'pending', pending: this.pending });
  }

  /** 确认条上的「执行」：真正关掉 workspace（只关容器，不删目录）。 */
  async confirmPending(): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = undefined;
    this.postPending();
    let closed = 0;
    for (const target of pending.targets) {
      const ok =
        target.kind === 'workspace' ? await this.closeWorkspaceNow(target.id) : await this.closePaneNow(target.id);
      if (ok) {
        closed += 1;
      }
    }
    this.traceAdd(`pending: confirmed ${pending.kind}, closed ${closed}/${pending.targets.length}`);
    await this.refresh();
    void vscode.window.showInformationMessage(
      pending.kind === 'sweep'
        ? `HerdrPlus：已归档关闭 ${closed}/${pending.targets.length} 个 workspace。`
        : pending.kind === 'closePane'
          ? `HerdrPlus：已关闭 ${closed} 个 pane（进程已结束）。`
          : `HerdrPlus：已关闭 ${closed} 个 workspace。`,
    );
  }

  async cancelPending(): Promise<void> {
    if (!this.pending) {
      return;
    }
    this.traceAdd(`pending: cancelled ${this.pending.kind}`);
    this.setPending(undefined);
  }

  private async closePaneNow(paneId: string): Promise<boolean> {
    try {
      await this.client.request('pane.close', { pane_id: paneId });
      return true;
    } catch (error) {
      this.traceAdd(`close pane ${paneId} failed: ${String(error)}`);
      return false;
    }
  }

  /**
   * 关闭 pane —— 会结束里面的进程（agent 也一起没），所以和关 workspace 一样先过确认条。
   */
  private async closePane(paneId: string): Promise<void> {
    const pane = this.snapshot?.panes.find((item) => item.pane_id === paneId);
    const agent = this.snapshot?.agents.find((item) => item.pane_id === paneId);
    const label = this.paneLabel(paneId);
    const detail = agent
      ? `「${label}」里是 ${agent.display_agent ?? agent.name ?? 'agent'}（${
          STATUS_TEXT[agent.agent_status] ?? agent.agent_status
        }），关闭会连它的进程一起结束`
      : `「${label}」里的进程会一起结束`;
    this.traceAdd(`confirm: close pane ${paneId}`);
    this.setPending({
      kind: 'closePane',
      title: `${detail}（pane ${pane?.pane_id ?? paneId}）。`,
      confirmLabel: '关闭 pane',
      targets: [{ kind: 'pane', id: paneId }],
    });
  }

  private async closeWorkspaceNow(workspaceId: string): Promise<boolean> {
    try {
      await this.client.request('workspace.close', { workspace_id: workspaceId });
      return true;
    } catch (error) {
      this.traceAdd(`close ${workspaceId} failed: ${String(error)}`);
      return false;
    }
  }

  attachPost(post: (message: unknown) => void): vscode.Disposable {
    this.posts.add(post);
    return new vscode.Disposable(() => this.posts.delete(post));
  }

  post(message: unknown): void {
    for (const post of this.posts) {
      void post(message);
    }
  }

  async send(message: IncomingMessage): Promise<void> {
    this.traceAdd(`webview: ${JSON.stringify(message)}`);
    switch (message.type) {
      case 'ready':
        this.post({ type: 'state', state: this.state });
        if (this.snapshot) {
          this.post({ type: 'snapshot', snapshot: this.snapshot });
        }
        return;
      case 'focus':
        if (message.kind === 'workspace') {
          this.selectedWorkspaceId = message.id;
        }
        await this.focus(message.kind, message.id);
        return;
      case 'action':
        await this.handleAction(message.action, message.id);
        return;
      default:
        return;
    }
  }

  private async handleAction(action: string, id?: string): Promise<void> {
    switch (action) {
      case 'refresh':
        return this.refresh();
      case 'newWorkspace':
        return this.newWorkspace();
      case 'startAgent':
        return this.startAgent({ mode: 'newTerminal' });
      case 'startAgentHere':
        return this.startAgent({ mode: 'here', paneId: id });
      case 'preview':
      case 'previewPaneAction':
        return this.previewPane(id);
      case 'previewPaneBeside':
        return this.previewPane(id, { beside: true });
      case 'previewWorkspace':
        return this.previewPane(this.activePaneId(id));
      case 'focusPane':
        if (id) {
          await this.focus('pane', id);
        }
        return;
      case 'closePane':
        if (id) {
          await this.closePane(id);
        }
        return;
      case 'renamePane':
        if (id) {
          await this.renamePane(id);
        }
        return;
      case 'openClient':
        return this.openClient();
      case 'openTerminalPinned':
        if (id) {
          this.openClient({ fresh: true, target: id });
          await this.focus('workspace', id);
        }
        return;
      case 'locate':
        return this.locateCommand();
      case 'closeWorkspace':
        if (id) {
          await this.closeWorkspace(id);
        }
        return;
      case 'confirmPending':
        return this.confirmPending();
      case 'cancelPending':
        return this.cancelPending();
      case 'renameWorkspace':
        if (id) {
          await this.renameWorkspace(id);
        }
        return;
      default:
        return;
    }
  }

  /** workspace 当前活跃的 pane（侧栏是单层列表，行内动作需要落到具体 pane）。 */
  private activePaneId(workspaceId?: string): string | undefined {
    if (!workspaceId || !this.snapshot) {
      return undefined;
    }
    const workspace = this.snapshot.workspaces.find((item) => item.workspace_id === workspaceId);
    const panes = this.snapshot.panes.filter((pane) => pane.workspace_id === workspaceId);
    const tabId = workspace?.active_tab_id;
    return (
      panes.find((pane) => pane.tab_id === tabId && pane.focused)?.pane_id ??
      panes.find((pane) => pane.tab_id === tabId)?.pane_id ??
      panes.find((pane) => pane.focused)?.pane_id ??
      panes[0]?.pane_id
    );
  }

  async refresh(): Promise<void> {
    await this.client.refresh();
  }

  /** 点击侧栏行 → 让 herdr 聚焦对应实体（服务端共享焦点，见设计文档 §4.5）。 */
  async focus(kind: 'workspace' | 'tab' | 'pane', id: string): Promise<void> {
    const method = kind === 'workspace' ? 'workspace.focus' : kind === 'tab' ? 'tab.focus' : 'pane.focus';
    const key = kind === 'workspace' ? 'workspace_id' : kind === 'tab' ? 'tab_id' : 'pane_id';
    await this.run(() => this.client.request(method, { [key]: id }));
  }

  async newWorkspace(): Promise<void> {
    const label = await vscode.window.showInputBox({
      title: '新建 herdr workspace',
      prompt: '标签（留空则由 herdr 命名）',
      value: '',
    });
    if (label === undefined) {
      return;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    await this.run(() => this.client.request('workspace.create', { label: label || null, cwd, focus: true }));
  }

  /** 某个 workspace 里还没结束的 agent（done/unknown 不算）。 */
  private agentsIn(workspaceId: string): AgentInfo[] {
    return (this.snapshot?.agents ?? []).filter(
      (agent) => agent.workspace_id === workspaceId && agent.agent_status !== 'done' && agent.agent_status !== 'unknown',
    );
  }

  /**
   * 关闭 workspace（只关容器，不删目录）。里面有活着的 agent 时先在侧栏内联确认 ——
   * API 关闭不会像 TUI 那样自动问，而侧栏的 ✕ 只差一次点击就会连进程一起结束掉。
   */
  private async closeWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.snapshot?.workspaces.find((item) => item.workspace_id === workspaceId);
    const live = this.agentsIn(workspaceId);
    if (live.length > 0) {
      this.traceAdd(`confirm: close ${workspaceId} (${live.length} live agents)`);
      this.setPending({
        kind: 'closeWorkspace',
        title: `「${workspace?.label ?? workspaceId}」里还有 ${live.length} 个没结束的 Agent（${live
          .map((agent) => agent.display_agent ?? agent.name ?? agent.pane_id)
          .join('、')}），关闭会让它们连同进程一起结束。`,
        confirmLabel: '仍然关闭',
        targets: [{ kind: 'workspace', id: workspaceId }],
      });
      return;
    }
    await this.closeWorkspaceNow(workspaceId);
    await this.refresh();
  }

  /**
   * 归档关闭：一次性关掉所有「空闲/完成/未知」且非当前的 workspace（只关容器，不删目录）。
   * 相当于把已经收工的 workspace 从侧栏里清掉。
   */
  async sweepWorkspaces(): Promise<void> {
    const snapshot = this.snapshot ?? (await this.client.snapshot().catch(() => undefined));
    if (!snapshot) {
      void vscode.window.showWarningMessage('HerdrPlus：还没拿到 herdr 状态，稍后再试。');
      return;
    }
    const targets = snapshot.workspaces.filter(
      (workspace) => !workspace.focused && workspace.agent_status !== 'working' && workspace.agent_status !== 'blocked',
    );
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('HerdrPlus：没有可归档的 workspace（空闲/完成的都已清理）。');
      return;
    }
    const names = targets.slice(0, 6).map((workspace) => workspace.label);
    const suffix = targets.length > names.length ? ` 等 ${targets.length} 个` : '';
    const withAgents = targets.filter((workspace) => this.agentsIn(workspace.workspace_id).length > 0).length;
    const ids = targets.map((workspace) => workspace.workspace_id);
    this.traceAdd(`confirm: sweep ${ids.join(',')}`);
    this.setPending({
      kind: 'sweep',
      title: `归档关闭 ${targets.length} 个 workspace：${names.join('、')}${suffix}（只关容器，不删目录${
        withAgents > 0 ? `；其中 ${withAgents} 个还有没结束的 agent` : ''
      }）`,
      confirmLabel: '关闭这些',
      targets: ids.map((id) => ({ kind: 'workspace' as const, id })),
    });
  }

  private async renameWorkspace(workspaceId: string): Promise<void> {
    const current = this.snapshot?.workspaces.find((item) => item.workspace_id === workspaceId);
    const label = await vscode.window.showInputBox({ title: '重命名 workspace', value: current?.label ?? '' });
    if (label === undefined) {
      return;
    }
    await this.run(() => this.client.request('workspace.rename', { workspace_id: workspaceId, label }));
  }

  /**
   * agent 名字在 herdr session 内唯一（重复会返回 `agent_name_taken`）。
   * 依次尝试 `<kind>`、`<kind>-2`… 最多 9 个，全部占用时给时间戳后缀。
   */
  private async uniqueAgentName(kind: string): Promise<string> {
    const snapshot = this.snapshot ?? (await this.client.snapshot().catch(() => undefined));
    const taken = new Set((snapshot?.agents ?? []).map((agent) => agent.name).filter(Boolean));
    if (!taken.has(kind)) {
      return kind;
    }
    for (let index = 2; index <= 9; index++) {
      const candidate = `${kind}-${index}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
    return `${kind}-${Date.now().toString(36).slice(-4)}`;
  }

  private async renamePane(paneId: string): Promise<void> {
    const current = this.snapshot?.panes.find((item) => item.pane_id === paneId);
    const label = await vscode.window.showInputBox({
      title: `重命名 pane ${paneId}`,
      value: current?.label ?? current?.terminal_title_stripped ?? '',
    });
    if (label === undefined) {
      return;
    }
    await this.run(() => this.client.request('pane.rename', { pane_id: paneId, label }));
  }

  async startAgent(options: AgentStartOptions): Promise<void> {
    const configured = vscode.workspace.getConfiguration('herdrplus').get<string[]>('agents') ?? [];
    const kinds = [...new Set([...configured, 'pi', 'omp'])];
    const picked = await vscode.window.showQuickPick(
      [...kinds.map((kind) => ({ label: kind })), { label: '$(edit) 其他 kind…' }],
      { title: options.mode === 'newTerminal' ? '启动 Agent（新终端）' : '启动 Agent（当前 Pane）' },
    );
    if (!picked) {
      return;
    }
    let kind = picked.label;
    if (kind.startsWith('$(edit)')) {
      const typed = await vscode.window.showInputBox({
        title: 'agent kind',
        prompt: `可选：${KNOWN_AGENT_KINDS.join(' / ')}`,
      });
      if (!typed) {
        return;
      }
      kind = typed.trim();
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    await this.run(async () => {
      // 分栏由 VSCode 负责：这里新建一个 herdr workspace + 一个 VSCode 终端，一个终端 = 一个 pane。
      let paneId = options.paneId;
      if (options.mode === 'newTerminal') {
        const created = await this.client.request<{ root_pane: { pane_id: string } }>('workspace.create', {
          label: kind,
          cwd,
          focus: true,
        });
        paneId = created.root_pane.pane_id;
      } else {
        const snapshot = this.snapshot ?? (await this.client.snapshot());
        paneId = paneId ?? snapshot.focused_pane_id ?? undefined;
      }
      if (!paneId) {
        throw new Error('无法确定目标 pane：请先在侧栏选中一个 pane');
      }
      const started = await this.client.request<{ agent: { pane_id: string; agent_status: string } }>('agent.start', {
        name: await this.uniqueAgentName(kind),
        kind,
        pane_id: paneId,
        timeout_ms: 30_000,
      });
      if (options.mode === 'newTerminal') {
        this.openClient();
      }
      void vscode.window.showInformationMessage(
        `herdr：${kind} 已在 ${started.agent.pane_id} 启动（${started.agent.agent_status}）`,
      );
    });
  }

  /**
   * 预览某个 pane 的输出。默认开在**当前编辑器栏**（一个 tab，不打乱布局）；
   * `beside` 才另开新栏 —— 想并排盯多个就对新栏那个用 `previewPaneBeside`。
   */
  async previewPane(paneId?: string, options: { beside?: boolean } = {}): Promise<void> {
    const target = paneId ?? this.snapshot?.focused_pane_id;
    if (!target) {
      void vscode.window.showWarningMessage('HerdrPlus：先在侧栏选中一个 pane（或让 herdr 聚焦一个 pane）。');
      return;
    }
    const existing = this.previews.get(target);
    if (existing) {
      // 已有这个 pane 的看板：就地露出（在当前栏打开的不因再点一次而跳栏）
      existing.panel.reveal(options.beside ? vscode.ViewColumn.Beside : undefined, true);
      await this.renderPreview(target);
      return;
    }
    const column = options.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    const panel = vscode.window.createWebviewPanel('herdrplus.preview', `herdr: ${this.paneLabel(target)}`, column, {});
    const timer = setInterval(() => {
      if (panel.visible) {
        void this.renderPreview(target);
      }
    }, 2_000);
    this.previews.set(target, { panel, timer });
    panel.onDidDispose(() => {
      clearInterval(timer);
      this.previews.delete(target);
    });
    await this.renderPreview(target);
  }

  /** pane 的人类可读名（终端标题优先），用于面板标题。 */
  private paneLabel(paneId: string): string {
    const pane = this.snapshot?.panes.find((item) => item.pane_id === paneId);
    return pane?.terminal_title_stripped ?? pane?.title ?? paneId;
  }

  /** 每次快照后刷新看板标题（pane 标题会随 agent 干活变化）。 */
  private refreshPreviewTitles(): void {
    for (const [paneId, entry] of this.previews) {
      const label = `herdr: ${this.paneLabel(paneId)}`;
      if (entry.panel.title !== label) {
        entry.panel.title = label;
      }
    }
  }

  private async renderPreview(paneId: string): Promise<void> {
    const panel = this.previews.get(paneId)?.panel;
    if (!panel) {
      return;
    }
    try {
      panel.webview.html = previewHtml(paneId, await this.client.readPane(paneId, 120));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      panel.webview.html = previewHtml(paneId, `读取失败：${message}`);
    }
  }

  /**
   * 打开/聚焦 herdr 终端：默认复用已有的那个（避免点一次开一个），`fresh` 显式另开一个视图。
   * `target` 把这个终端**钉**在一个 workspace 上：`herdr` 服务端只有一个「当前 workspace」，
   * 所以钉住 = 它被激活时自动 `workspace.focus`；想**同时**看不同内容就绑定另一个 session
   * （每个 session 有独立 server 与独立焦点）。
   */
  openClient(options: { fresh?: boolean; target?: string; session?: string } = {}): void {
    const herdr = this.herdrPath;
    this.traceAdd(
      `openClient: herdr=${herdr ?? 'none'} cfg=${this.effectiveConfigPath ?? 'none'} fresh=${options.fresh === true} target=${options.target ?? '-'} session=${options.session ?? '-'}`,
    );
    if (!herdr) {
      void this.locateCommand();
      return;
    }
    if (!options.fresh && !options.session) {
      const existing = this.herdrTerminals.find((terminal) => !this.closedTerminals.has(terminal) && !this.pinnedTerminals.has(terminal));
      if (existing) {
        existing.show();
        if (options.target) {
          void this.focus('workspace', options.target);
        }
        return;
      }
    }
    this.spawnTerminal({ herdr, target: options.target, session: options.session });
  }

  /** 真正创建终端（含「启动后立刻退出」的警报）。 */
  private spawnTerminal(options: { herdr: string; target?: string; session?: string }): void {
    const location =
      vscode.workspace.getConfiguration('herdrplus').get<string>('openIn') === 'panel'
        ? vscode.TerminalLocation.Panel
        : vscode.TerminalLocation.Editor;
    const suffix = options.session ? ` @${options.session}` : options.target ? `: ${this.workspaceLabel(options.target)}` : '';
    const terminal = vscode.window.createTerminal({
      name: `herdr${suffix}`,
      shellPath: options.herdr,
      shellArgs: options.session ? ['--session', options.session] : [],
      location,
      iconPath: new vscode.ThemeIcon('terminal'),
      env: this.terminalEnv({ session: options.session }),
    });
    this.herdrTerminals.push(terminal);
    if (options.target) {
      this.pinnedTerminals.set(terminal, options.target);
    }
    const startedAt = Date.now();
    const subscription = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) {
        return;
      }
      subscription.dispose();
      this.closedTerminals.add(terminal);
      this.pinnedTerminals.delete(terminal);
      if (Date.now() - startedAt < 8_000) {
        void vscode.window
          .showWarningMessage(
            'HerdrPlus：herdr 终端启动后立即退出。常见原因：herdr 版本不匹配、配置被拒（`herdr config check`）、或嵌套限制。',
            '运行诊断',
          )
          .then((choice) => {
            if (choice === '运行诊断') {
              void this.doctor();
            }
          });
      }
    });
    this.disposables.push(subscription);
    terminal.show();
  }

  /** 别的 session 的终端：各 session 有各自的 server 与「当前 workspace」，所以能同时显示不同内容。 */
  async newSessionTerminal(): Promise<void> {
    const sessions = await this.listSessions();
    if (sessions.length === 0) {
      void vscode.window.showWarningMessage('HerdrPlus：没读到 herdr session 列表（`herdr session list`）。');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((session) => ({
        label: `${session.name === this.currentSession() ? '$(check) ' : '$(server) '}${session.name}`,
        detail: `${session.status} · ${session.directory}`,
        name: session.name,
      })),
      { title: '新开终端：绑定一个 herdr session', placeHolder: '每个 session 有独立的当前 workspace（这才是「多个 herdr 实例」）' },
    );
    if (!picked) {
      return;
    }
    this.openClient({ fresh: true, session: picked.name });
  }

  /** 扩展自身连的那个 session（这些终端默认在它上面）。 */
  private currentSession(): string {
    return process.env.HERDR_SESSION?.trim() || 'default';
  }

  private async listSessions(): Promise<Array<{ name: string; status: string; directory: string }>> {
    const herdr = this.herdrPath;
    if (!herdr) {
      return [];
    }
    try {
      const { stdout } = await execFileAsync(herdr, ['session', 'list', '--json'], { maxBuffer: 4 << 20 });
      const parsed = JSON.parse(stdout) as { sessions?: Array<Record<string, string>> } | Array<Record<string, string>>;
      const list = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
      return list.map((entry) => ({
        name: String(entry.name ?? ''),
        status: String(entry.status ?? ''),
        directory: String(entry.directory ?? entry.path ?? ''),
      }));
    } catch (error) {
      this.traceAdd(`session list failed: ${String(error)}`);
      return [];
    }
  }

  /** 另开一个 herdr 终端视图（同一个 server 的第二个 client）。 */
  newTerminal(): void {
    this.openClient({ fresh: true });
  }

  /**
   * 另开一个终端视图并选一个目标：跟随焦点 / 钉在某个 workspace。
   * herdr 的「当前 workspace」是服务端单值，所以钉住只能做到「激活该标签时切过去」——
   * 想**同时**看多个 agent 用「预览输出」的看板（每个 pane 可并排开一个）。
   */
  async newTerminalView(): Promise<void> {
    const workspaces = this.snapshot?.workspaces ?? [];
    const sessions = (await this.listSessions()).filter((session) => session.name !== this.currentSession());
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(sync) 跟随焦点', detail: 'herdr 切到哪个 workspace 就显示哪个（默认）', target: undefined, session: undefined },
        ...workspaces.map((workspace) => ({
          label: `$(pin) ${workspace.label}`,
          detail: `${workspace.pane_count} pane · ${workspace.tab_count} tab${workspace.focused ? ' · 当前' : ''} —— 激活该标签时切过去`,
          target: workspace.workspace_id,
          session: undefined,
        })),
        ...sessions.map((session) => ({
          label: `$(server) session: ${session.name}`,
          detail: `${session.status} —— 独立 server，可与别的终端同时显示不同内容`,
          target: undefined,
          session: session.name,
        })),
      ],
      { title: '新 herdr 终端视图', placeHolder: '跟随焦点 / 钉在某个 workspace / 绑定另一个 session' },
    );
    if (!picked) {
      return;
    }
    this.openClient({ fresh: true, target: picked.target, session: picked.session });
    if (picked.target) {
      await this.focus('workspace', picked.target);
    }
  }

  private workspaceLabel(workspaceId: string): string {
    return this.snapshot?.workspaces.find((item) => item.workspace_id === workspaceId)?.label ?? workspaceId;
  }

  /** 钉住的终端被激活 → 把服务端焦点切到它的 workspace（标签页 = 各自的位置）。 */
  private onActiveTerminalChanged(terminal: vscode.Terminal | undefined): void {
    if (!terminal) {
      return;
    }
    const target = this.pinnedTerminals.get(terminal);
    if (target && this.snapshot?.focused_workspace_id !== target) {
      this.traceAdd(`pin: activate ${target}`);
      void this.focus('workspace', target);
    }
  }

  /**
   * 内嵌终端应带的环境。
   *
   * 关键：如果 VS Code 本身是在 herdr pane 里启动的（用户在 herdr 里开编辑器），扩展宿主会继承
   * `HERDR_ENV/HERDR_PANE_ID/HERDR_WORKSPACE_ID/HERDR_TAB_ID` —— herdr 会据此判定"嵌套"并**拒绝启动**
   * （`nested herdr is disabled by default`），表现为终端开完即消失。这里把这些"我在某个 pane 里"的标记清掉，
   * 只保留会话选择与 socket 端点（我们本来就要连同一个 server），并在生成的配置里放开 allow_nested。
   */
  private terminalEnv(options: { session?: string } = {}): Record<string, string | null> {
    const env: Record<string, string | null> = {
      ...(options.session ? { HERDR_SOCKET_PATH: null, HERDR_SESSION: options.session } : {}),
      HERDR_ENV: null,
      HERDR_PANE_ID: null,
      HERDR_WORKSPACE_ID: null,
      HERDR_TAB_ID: null,
      HERDR_CLIENT_SOCKET_PATH: null,
    };
    if (this.effectiveConfigPath) {
      env.HERDR_CONFIG_PATH = this.effectiveConfigPath;
    }
    return env;
  }

  terminalProfile(): vscode.TerminalProfile | undefined {
    const herdr = this.herdrPath;
    if (!herdr) {
      void this.locateCommand();
      return undefined;
    }
    return new vscode.TerminalProfile({
      name: 'herdr',
      shellPath: herdr,
      shellArgs: [],
      iconPath: new vscode.ThemeIcon('terminal'),
      env: this.terminalEnv(),
    });
  }

  /** 第二侧栏（1.106+）存在则聚焦它，否则退化为活动栏容器并提示。 */
  async openFloating(): Promise<void> {
    const secondary = supportsSecondarySidebar();
    await vscode.commands.executeCommand(
      `workbench.view.extension.${secondary ? 'herdrplus-containerSecondary' : 'herdrplus-container'}`,
    );
    // 容器内的视图聚焦命令（`<viewId>.focus` 由 VSCode 自动生成）才会真正把视图显示出来。
    await vscode.commands
      .executeCommand(`${secondary ? 'herdrplus.sidebarSecondary' : 'herdrplus.sidebar'}.focus`)
      .then(undefined, () => undefined);
    if (!secondary) {
      void vscode.window.showInformationMessage(
        '当前 VSCode 版本没有第二侧栏（1.106+ 才有）。可把侧栏视图拖到右侧，或把编辑器拖出为独立浮动窗口。',
      );
    }
  }

  /** 诊断快照（写文件 + 通知）：连接、路径、容器命令是否存在。 */
  async doctor(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    const report = {
      version: vscode.version,
      secondarySidebar: supportsSecondarySidebar(),
      herdrPath: this.herdrPath ?? null,
      socketPath: process.env.HERDR_SOCKET_PATH ?? null,
      session: process.env.HERDR_SESSION ?? null,
      state: this.state,
      containerCommands: {
        activitybar: commands.includes('workbench.view.extension.herdrplus-container'),
        secondary: commands.includes('workbench.view.extension.herdrplus-containerSecondary'),
      },
      snapshotSummary: this.snapshot
        ? {
            workspaces: this.snapshot.workspaces.map((workspace) => workspace.label),
            agents: this.snapshot.agents.map((agentInfo) => `${agentInfo.display_agent ?? agentInfo.name ?? agentInfo.pane_id}:${agentInfo.agent_status}`),
          }
        : null,
      recentLog: this.client.recentLog,
      trace: this.trace,
      effectiveConfigPath: this.effectiveConfigPath ?? null,
      sidebar: {
        resolved: this.sidebarResolved,
        visible: this.sidebarVisible,
        focusCommand: commands.includes('herdrplus.sidebarSecondary.focus'),
        activityFocusCommand: commands.includes('herdrplus.sidebar.focus'),
      },
      socketTarget: this.client.socketTarget,
      socketProbe: await probeSocket(this.client.socketFile),
    };
    const file = path.join(os.tmpdir(), 'herdrplus-doctor.json');
    await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(JSON.stringify(report, null, 2), 'utf8'));
    void vscode.window.showInformationMessage(`HerdrPlus 诊断已写入 ${file}`);
  }

  async locateCommand(): Promise<void> {
    const config = vscode.workspace.getConfiguration('herdrplus');
    const current = config.get<string>('binaryPath') ?? '';
    const detected = locateHerdr(current) ?? (await locateHerdrOnPath());
    if (detected) {
      const choice = await vscode.window.showInformationMessage(`herdr 已就绪：${detected}`, '写入设置并重连', '仅重连');
      if (choice === '写入设置并重连') {
        await config.update('binaryPath', detected, vscode.ConfigurationTarget.Global);
        this.replaceClient(detected);
      } else if (choice === '仅重连') {
        this.replaceClient(detected);
      }
      return;
    }
    const docs = await vscode.window.showWarningMessage(
      '本机没找到 herdr 可执行文件。HerdrPlus 不会自动下载安装 —— 先按官方说明装好，再回来「定位 herdr」。',
      '打开安装说明',
      '手动指定路径',
    );
    if (docs === '打开安装说明') {
      await this.installDocs();
      return;
    }
    if (docs !== '手动指定路径') {
      return;
    }
    const typed = await vscode.window.showInputBox({
      title: '未找到 herdr',
      prompt: '输入 herdr 可执行文件完整路径（例：C:\\Users\\<you>\\.herdr\\packages\\standalone\\releases\\<版本>\\herdr.exe）',
      value: current,
    });
    if (typed) {
      await config.update('binaryPath', typed, vscode.ConfigurationTarget.Global);
      this.replaceClient(typed);
    }
  }

  /** 官方安装说明（扩展只负责找到 herdr，不替用户下载安装）。 */
  async installDocs(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse('https://herdr.dev'));
  }

  private replaceClient(binaryPath: string): void {
    this.client.dispose();
    this.client = this.buildClient(binaryPath);
    this.client.setActive(true);
    this.client.start();
    this.postState();
  }

  /** 连接状态 + 视图偏好（排序）一起下发：webview 只认这一条消息。 */
  private postState(): void {
    this.post({ type: 'state', state: this.state, sort: this.sort });
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('server_not_running')) {
        void vscode.window.showErrorMessage('HerdrPlus：herdr server 未运行。先运行 `herdr` 或 `herdr server` 再重试。');
      } else if (/_not_found/.test(message)) {
        // 目标已被别处关掉/改名：刷新后重新选，不吓用户
        await this.refresh();
        void vscode.window.showWarningMessage(`HerdrPlus：目标已不存在（${message}），侧栏已刷新。`);
      } else {
        void vscode.window.showErrorMessage(`HerdrPlus：${message}`);
      }
    }
  }

  dispose(): void {
    for (const entry of this.previews.values()) {
      clearInterval(entry.timer);
      entry.panel.dispose();
    }
    this.previews.clear();
    this.client.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

/** `viewsContainers.secondarySidebar` 需要 VSCode 1.106+（Codex 扩展用同一闸门）。 */
export function supportsSecondarySidebar(): boolean {
  const [major, minor] = vscode.version.split('.').map((part) => Number.parseInt(part, 10));
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return false;
  }
  return major > 1 || (major === 1 && minor >= 106);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}

function previewHtml(paneId: string, text: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { margin: 0; padding: 10px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
           font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); }
    header { opacity: .7; margin-bottom: 6px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
  </style></head><body><header>pane ${escapeHtml(paneId)} · 最近输出（每 2s 刷新）</header><pre>${escapeHtml(text)}</pre></body></html>`;
}
