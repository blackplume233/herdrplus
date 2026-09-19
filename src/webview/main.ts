import { STATUS_TEXT } from '../herdr/types.js';
import type {AgentInfo, ClientState, PaneInfo, SessionSnapshot, WorkspaceInfo} from '../herdr/types.js';

interface HostApi {
  postMessage(message: unknown): void;
  getState(): { sort?: SortMode; collapsed?: Record<string, boolean>; expanded?: string[] } | undefined;
  setState(state: { sort?: SortMode; collapsed?: Record<string, boolean>; expanded?: string[] }): void;
}

declare function acquireVsCodeApi(): HostApi;

type SortMode = 'number' | 'attention';
type TargetKind = 'workspace' | 'tab' | 'pane';

/** 排序模式之外，视图还从宿主收到「workspace → 锚定工作目录」（未锚定的不在表里）。 */
type Anchors = Record<string, string>;

const host = acquireVsCodeApi();

/** 锚定工作目录：本扩展（或用户手动）给 workspace 定的目录，行的第二行要显示它。 */
let anchors: Anchors = {};

/** 「待处理」排序：等待输入 → 工作中 → 完成 → 空闲 → 未知（对齐 herdr 的 agent_panel_sort=priority）。 */
const ATTENTION_RANK: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

/** 内联 SVG 图标：跨字体渲染一致，且不需要宿主字体资源。 */
const ICON: Record<string, string> = {
  newWorkspace: '<svg viewBox="0 0 16 16"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
  terminal: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v9h-11z" stroke="currentColor" stroke-width="1.2" fill="none" rx="1"/><path d="M4.6 6.4 6.4 8l-1.8 1.6M7.6 9.8h3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  terminalNew: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v9h-11z" stroke="currentColor" stroke-width="1.2" fill="none" rx="1"/><path d="M4.5 6.3 6.2 7.9l-1.7 1.6M7.2 9.5h2.2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.3 5.1v2.5M10.05 6.35h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  refresh: '<svg viewBox="0 0 16 16"><path d="M12.8 8a4.8 4.8 0 1 1-1.5-3.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/><path d="M12.9 2.6v2.6h-2.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sort: '<svg viewBox="0 0 16 16"><path d="M4.4 3.4v9.2M2.2 10.4l2.2 2.2 2.2-2.2M11.6 12.6V3.4M9.4 5.6l2.2-2.2 2.2 2.2" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  agent: '<svg viewBox="0 0 16 16"><path d="M5.2 3.6 8 8.4l2.8-4.8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="11.4" r="1.3" fill="currentColor"/></svg>',
  rename: '<svg viewBox="0 0 16 16"><path d="M3 13h2.4l6.7-6.7-2.4-2.4L3 10.6z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/><path d="M10.4 2.7 12.8 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2.4 4.2h3.8l1.2 1.5h6.2v7.1H2.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  chevronRight: '<svg viewBox="0 0 16 16"><path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevronDown: '<svg viewBox="0 0 16 16"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path d="M8 2.4l5.6 10.2H2.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6.2v3.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11.1" r="0.7" fill="currentColor"/></svg>',
  archive: '<svg viewBox="0 0 16 16"><path d="M2.5 4h11v2.2h-11z" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M3.6 6.2v6.3h8.8V6.2" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M6.4 8.6h3.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
};

interface ActionModel {
  act: string;
  id?: string;
  title: string;
  icon: string;
}

interface RowModel {
  key: string;
  className: string;
  /** 树层级：workspace = 0，tab = 1，tab 下的 pane = 2；缩进由它算，不写死像素。 */
  depth: number;
  status: string;
  statusTitle: string;
  label: string;
  detail: string;
  context: string;
  caret?: { act: string; id: string; glyph: string };
  actions: ActionModel[];
}

interface MenuItemModel {
  act: string;
  label: string;
  icon: string;
  danger?: boolean;
}

interface MenuState {
  kind: TargetKind;
  id: string;
  label: string;
  x: number;
  y: number;
}

/** 这个 webview 负责哪一段（上下两个原生 view 各一份）。 */
const section: 'spaces' | 'agents' = document.body.dataset.section === 'agents' ? 'agents' : 'spaces';
let snapshot: SessionSnapshot | undefined;
let state: ClientState = { kind: 'idle' };
/** 待确认的破坏性操作（侧栏内联确认条）。 */
let pending: { title: string; confirmLabel: string } | undefined;
/** 乐观的「终端正在显示哪个 workspace / pane」：点击立刻生效，快照回来后以服务端为准。 */
let optimisticCurrent: string | undefined;
let sort: SortMode = 'number';
/** 展开子 panel（workspace 下的 pane）的 workspace id 集合。 */
const expanded = new Set<string>(host.getState()?.expanded ?? []);
let menu: MenuState | undefined;
let renderQueued = false;

const root = document.getElementById('root')!;
buildSkeleton();
root.addEventListener('click', onClick);
root.addEventListener('contextmenu', onContextMenu);
window.addEventListener('message', onMessage);
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' && event.key !== 'Enter') {
    return;
  }
  if (menu) {
    closeMenu();
    return;
  }
  if (!pending) {
    return;
  }
  event.preventDefault();
  host.postMessage({ type: 'action', action: event.key === 'Enter' ? 'confirmPending' : 'cancelPending' });
});
window.addEventListener('click', (event) => {
  if (menu && !(event.target as HTMLElement).closest('.menu')) {
    closeMenu();
  }
});
// 菜单只靠「侧栏里的点击」收是不够的：点到编辑器/终端/标题栏（都在 webview 之外）时侧栏收不到点击，
// 菜单会一直挂在那儿。失焦、滚动、窗口尺寸变化都收掉。
window.addEventListener('blur', () => closeMenu());
window.addEventListener('wheel', () => closeMenu(), { passive: true });
window.addEventListener('resize', () => closeMenu());
/** webview 里的异常回传给 host（进 doctor trace）—— 侧栏白屏这类问题才不会只剩「点了没反应」。 */
function reportError(message: string): void {
  host.postMessage({ type: 'webview-error', message });
}

window.addEventListener('error', (event) => reportError(`${event.message} @${event.filename}:${event.lineno}`));
window.addEventListener('unhandledrejection', (event) => reportError(`unhandled rejection: ${String(event.reason)}`));

host.postMessage({ type: 'ready' });
scheduleRender();

function persist(): void {
  host.setState({ expanded: [...expanded] });
}

function onMessage(event: MessageEvent): void {
  const message = event.data as {
    type: string;
    state?: ClientState;
    sort?: SortMode;
    snapshot?: SessionSnapshot;
    anchors?: Anchors;
    pending?: { title: string; confirmLabel: string } | null;
  };
  if (message.type === 'state' && message.state) {
    state = message.state;
    sort = message.sort === 'attention' ? 'attention' : 'number';
  } else if (message.type === 'snapshot' && message.snapshot) {
    snapshot = message.snapshot;
    anchors = message.anchors ?? {};
    const current = currentKeys();
    if (current.includes(optimisticCurrent ?? '')) {
      optimisticCurrent = undefined; // 服务端已确认，交还给快照
    }
  } else if (message.type === 'pending') {
    pending = message.pending ?? undefined;
  } else {
    return;
  }
  scheduleRender();
}

function onClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!target) {
    return;
  }
  const action = target.dataset.act!;
  const id = target.dataset.id;

  // 菜单项**一旦选中就收起**：留着会盖住下面的行（第二次右键/点击直接点不中）。
  if ((event.target as HTMLElement).closest('.menu')) {
    closeMenu();
  }

  if (action === 'toggleWorkspace' && id) {
    if (expanded.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
    }
    persist();
    scheduleRender();
    return;
  }
  if (action === 'focus' && id) {
    // 乐观：先把「当前」标识挪过去，终端随后跟随（失败会被下一次快照纠正）
    const kind = target.dataset.kind === 'pane' ? 'pane' : target.dataset.kind === 'tab' ? 'tab' : 'workspace';
    optimisticCurrent = id;
    host.postMessage({ type: 'focus', kind, id });
    closeMenu();
    scheduleRender();
    return;
  }
  if (action === 'focusTab' && id) {
    optimisticCurrent = id;
    host.postMessage({ type: 'focus', kind: 'tab', id });
    scheduleRender();
    return;
  }
  if (action === 'openTerminalForTab' && id) {
    host.postMessage({ type: 'action', action, id });
    return;
  }
  closeMenu();
  host.postMessage({ type: 'action', action, id });
}

function onContextMenu(event: MouseEvent): void {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-key]');
  const key = row?.dataset.key;
  if (!key) {
    return;
  }
  event.preventDefault();
  const kind: TargetKind = key.startsWith('pane:') ? 'pane' : key.startsWith('tab:') ? 'tab' : 'workspace';
  const id = key.slice(key.indexOf(':') + 1);
  menu = { kind, id, label: row.querySelector('.label')?.textContent ?? id, x: event.clientX, y: event.clientY };
  scheduleRender();
}

function closeMenu(): void {
  if (menu) {
    menu = undefined;
    scheduleRender();
  }
}

// ── 渲染：骨架建一次，之后只做字段级 patch（节点身份稳定 ⇒ 不闪） ────────────────

function buildSkeleton(): void {
  const confirmBar = `
<div class="confirm" data-f="confirm" hidden>
  <span class="confirm-icon" data-f="confirm-icon"></span>
  <span class="confirm-text" data-f="confirm-text"></span>
  <span class="confirm-actions">
    <button class="primary" data-act="confirmPending" data-f="confirm-ok"></button>
    <button data-act="cancelPending">取消</button>
  </span>
</div>`;
  const banner = `
<div class="banner" data-f="banner" hidden>
  <div data-f="banner-message"></div>
  <div class="muted" data-f="banner-hint"></div>
  <div class="banner-actions">
    <button data-act="refresh">重试连接</button>
    <button data-act="locate">定位 herdr</button>
  </div>
</div>`;
  const list = section === 'spaces'
    ? `<div class="list" data-f="list-spaces"></div>`
    : `<div class="list" data-f="list-agents"></div>
       <div class="section-hint" data-f="hint-agents" hidden>没有检测到 agent（herdr 会从进程/屏幕识别）</div>
       <footer data-f="footer" hidden></footer>`;

  root.innerHTML = `${confirmBar}${section === 'spaces' ? banner : ''}
<div class="empty" data-f="empty" hidden></div>
<section class="section" data-f="section-${section}" hidden>${list}</section>
<div class="menu" data-f="menu" hidden></div>`;
  applyIcon(find('confirm-icon'), 'warn');
  const refresh = find('refresh');
  if (refresh) {
    applyIcon(refresh, 'refresh');
    refresh.title = '重新读取 herdr 状态（断线时用）';
  }
}

function scheduleRender(): void {
  if (renderQueued) {
    return;
  }
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render(): void {
  // 诊断钩子：QA 用它断言「展开集合」的精确变化（webview 的 setState 只在 webview 内可见）
  document.body.dataset.expanded = [...expanded].join(',');
  const banner = find('banner');
  if (banner) {
    if (state.kind === 'error') {
      applyText(find('banner-message'), state.message);
      applyText(find('banner-hint'), state.hint ?? '');
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  renderConfirm();

  const hasSnapshot = Boolean(snapshot);
  const workspaceModels = snapshot ? workspaceRows(snapshot) : [];
  const agentModels = snapshot ? agentRows(snapshot) : [];
  const models = section === 'spaces' ? workspaceModels : agentModels;
  const hint = find('hint-agents');
  if (hint) {
    hint.hidden = !hasSnapshot || agentModels.length > 0;
  }

  applyText(
    find('empty'),
    hasSnapshot
      ? section === 'spaces'
        ? '还没有 workspace。点标题栏的 ＋ 新建一个。'
        : '还没有 agent。'
      : state.kind === 'error'
        ? '未连接 herdr。先运行 `herdr` 或 `herdr server`。'
        : '正在读取 herdr 状态…',
  );
  find('empty').hidden = !hasSnapshot || models.length > 0;

  renderSection(section, models, hasSnapshot && models.length > 0);

  const footer = find('footer');
  if (footer) {
    if (snapshot) {
      const blocked = agentModels.filter((row) => row.status.endsWith('blocked')).length;
      applyText(
        footer,
        `${snapshot.workspaces.length} ws · ${snapshot.panes.length} pane · ${agentModels.length} agent${blocked > 0 ? ` · ${blocked} 待处理` : ''} · protocol ${snapshot.protocol}`,
      );
      footer.hidden = false;
    } else {
      footer.hidden = true;
    }
  }

  renderMenu();
}

/** 内联确认条：破坏性操作的二次确认（原生 modal 在 CDP 里既看不到也点不动，而且慢）。 */
function renderConfirm(): void {
  const bar = find('confirm');
  bar.hidden = !pending;
  if (!pending) {
    return;
  }
  applyText(find('confirm-text'), pending.title);
  applyText(find('confirm-ok'), pending.confirmLabel);
}

function renderSection(which: 'spaces' | 'agents', models: RowModel[], visible: boolean): void {
  find(`section-${which}`).hidden = !visible;
  if (!visible) {
    return;
  }
  patchRows(find(`list-${which}`), models);
}

function find(name: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-f="${name}"]`)!;
}

/** 当前终端正在显示的 workspace / pane（乐观值优先）。 */
function currentKeys(): string[] {
  if (!snapshot) {
    return [];
  }
  if (optimisticCurrent) {
    return [optimisticCurrent];
  }
  const focusedWorkspace = snapshot.workspaces.find((workspace) => workspace.focused);
  const focusedTab = snapshot.tabs.find((tab) => tab.focused);
  const focusedPane = snapshot.panes.find((pane) => pane.focused);
  return [focusedWorkspace?.workspace_id, focusedTab?.tab_id, focusedPane?.pane_id].filter((value): value is string =>
    Boolean(value),
  );
}

/** 上段：workspace = 容器（位置），可展开看它的子 panel（pane）。 */
function workspaceRows(current: SessionSnapshot): RowModel[] {
  const currentIds = currentKeys();
  const sorted = [...current.workspaces].sort((left, right) => {
    if (sort === 'attention') {
      const rank = (ATTENTION_RANK[left.agent_status] ?? 9) - (ATTENTION_RANK[right.agent_status] ?? 9);
      if (rank !== 0) {
        return rank;
      }
    }
    return left.number - right.number;
  });

  const models: RowModel[] = [];
  for (const workspace of sorted) {
    const panes = current.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
    const bits: string[] = [];
    const anchor = anchors[workspace.workspace_id];
    if (anchor) {
      bits.push(shortPath(anchor));
    }
    if (workspace.pane_count > 1) {
      bits.push(`${workspace.pane_count} pane`);
    }
    if (workspace.tab_count > 1) {
      bits.push(`${workspace.tab_count} tab`);
    }
    const agentsHere = agentsOf(current, workspace.workspace_id);
    if (agentsHere.length > 1) {
      bits.push(`${agentsHere.length} agent`);
    }
    if (bits.length === 0) {
      const pane = activePaneOf(current, workspace);
      const cwd = pane?.foreground_cwd ?? pane?.cwd ?? '';
      if (cwd) {
        bits.push(shortPath(cwd));
      }
    }
    const isOpen = expanded.has(workspace.workspace_id);
    models.push({
      key: `ws:${workspace.workspace_id}`,
      depth: 0,
      className: `row ws-row${currentIds.includes(workspace.workspace_id) ? ' current' : ''}${workspace.agent_status === 'blocked' ? ' blocked' : ''}`,
      status: `dot status-${workspace.agent_status}`,
      statusTitle: STATUS_TEXT[workspace.agent_status] || '未知',
      label: workspace.label,
      detail: bits.join(' · '),
      context: '',
      caret: { act: 'toggleWorkspace', id: workspace.workspace_id, glyph: isOpen ? 'chevronDown' : 'chevronRight' },
      actions: [
        { act: 'startAgent', id: workspace.workspace_id, title: '新起一个 Agent（新终端）', icon: 'agent' },
        {
          act: 'openTerminalPinned',
          id: workspace.workspace_id,
          title: '新开一个终端并钉在这个 workspace（激活该标签就切过去）',
          icon: 'terminal',
        },
        { act: 'closeWorkspace', id: workspace.workspace_id, title: '关闭这个 workspace（只关容器，不删目录）', icon: 'close' },
      ],
    });
    if (!isOpen) {
      continue;
    }
    // 一个 herdr tab = 一行「终端」；**只到这一层**（侧栏最多两层，三级折叠太深）。
    // 多 pane 的 tab 用 detail 标出 `N pane`，要精确跳到某个 pane 就去下面的 Agents 块。
    for (const tab of current.tabs.filter((item) => item.workspace_id === workspace.workspace_id)) {
      const tabPanes = panes.filter((pane) => pane.tab_id === tab.tab_id);
      const active = tabPanes.find((pane) => pane.focused) ?? tabPanes[0];
      models.push({
        key: `tab:${tab.tab_id}`,
        depth: 1,
        className: `row tab-row child${currentIds.includes(tab.tab_id) ? ' current' : ''}${
          tabPanes.some((pane) => pane.agent_status === 'blocked') ? ' blocked' : ''
        }`,
        status: `dot status-${active?.agent_status ?? 'unknown'}`,
        statusTitle: STATUS_TEXT[active?.agent_status ?? 'unknown'] || '未知',
        label: active?.terminal_title_stripped ?? active?.title ?? `tab ${tab.label}`,
        detail: tabPanes.length > 1 ? `${tabPanes.length} pane` : shortPath(active?.foreground_cwd ?? active?.cwd ?? ''),
        context: `tab ${tab.label}`,
        actions: [
          {
            act: 'focusTab',
            id: tab.tab_id,
            title: '在当前页签打开：切 herdr 到这个 tab（不新开页签）',
            icon: 'terminal',
          },
        ],
      });
    }
  }
  return models;
}

/** pane 行：Agents 块的实体（侧栏第二层以上的精确目标都在这里）。 */
function paneRow(current: SessionSnapshot, pane: PaneInfo): RowModel {
  const currentIds = currentKeys();
  const agent = current.agents.find((item) => item.pane_id === pane.pane_id);
  const name = agentName(pane, agent);
  const title = pane.terminal_title_stripped ?? pane.title ?? '';
  const workspace = current.workspaces.find((item) => item.workspace_id === pane.workspace_id);
  const tab = current.tabs.find((item) => item.tab_id === pane.tab_id);
  const statusText = STATUS_TEXT[pane.agent_status];
  const contextParts = [workspace?.label ?? pane.workspace_id];
  if ((workspace?.tab_count ?? 1) > 1) {
    contextParts.push(`tab ${tab?.label ?? '?'}`);
  }
  // 子行：label 已经是 agent 的终端标题，detail 就别再重复一遍 agent 名
  return {
    key: `pane:${pane.pane_id}`,
    depth: 0,
    className: `row pane-row agent-row${currentIds.includes(pane.pane_id) ? ' current' : ''}${pane.agent_status === 'blocked' ? ' blocked' : ''}`,
    status: `dot status-${pane.agent_status}`,
    statusTitle: statusText || '未知',
    label: title || name || pane.pane_id,
    detail: statusText,
    context: contextParts.filter(Boolean).join(' · '),
    actions: [
      { act: 'focusPane', id: pane.pane_id, title: '在 herdr 终端里跳到这个 pane（终端视图会跟着切过去）', icon: 'terminal' },
    ],
  };
}

/** 下段：agent = 干活的东西（一个 pane 一个），带它所在 workspace/tab 作为上下文。 */
function agentRows(current: SessionSnapshot): RowModel[] {
  const agentPanes: PaneInfo[] = [];
  for (const agent of current.agents) {
    const pane = current.panes.find((item) => item.pane_id === agent.pane_id);
    if (pane) {
      agentPanes.push(pane);
    }
  }
  // agents[] 缺失时退化成「pane 有 agent 标记」
  for (const pane of current.panes) {
    if (pane.agent_status !== 'unknown' && !agentPanes.some((item) => item.pane_id === pane.pane_id)) {
      agentPanes.push(pane);
    }
  }
  const workspaceNumber = (workspaceId: string) =>
    current.workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.number ?? 99;
  const sorted = [...agentPanes].sort((left, right) => {
    if (sort === 'attention') {
      const rank = (ATTENTION_RANK[left.agent_status] ?? 9) - (ATTENTION_RANK[right.agent_status] ?? 9);
      if (rank !== 0) {
        return rank;
      }
    }
    return workspaceNumber(left.workspace_id) - workspaceNumber(right.workspace_id) || left.pane_id.localeCompare(right.pane_id);
  });
  return sorted.map((pane) => paneRow(current, pane));
}

function agentName(pane: PaneInfo, agent: AgentInfo | undefined): string {
  return agent?.display_agent ?? agent?.name ?? pane.display_agent ?? pane.agent ?? '';
}

function agentsOf(current: SessionSnapshot, workspaceId: string): AgentInfo[] {
  return current.agents.filter((agent) => agent.workspace_id === workspaceId);
}

function activePaneOf(current: SessionSnapshot, workspace: WorkspaceInfo): PaneInfo | undefined {
  const workspacePanes = current.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
  return (
    workspacePanes.find((pane) => pane.tab_id === workspace.active_tab_id && pane.focused) ??
    workspacePanes.find((pane) => pane.tab_id === workspace.active_tab_id) ??
    workspacePanes.find((pane) => pane.focused) ??
    workspacePanes[0]
  );
}

function patchRows(container: HTMLElement, models: RowModel[]): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children) as HTMLElement[]) {
    const key = child.dataset.key;
    if (key) {
      existing.set(key, child);
    }
  }

  let previous: HTMLElement | null = null;
  for (const model of models) {
    let node = existing.get(model.key);
    if (!node) {
      node = createRow(model);
    } else {
      existing.delete(model.key);
    }
    updateRow(node, model);
    const expected: Node | null = previous ? previous.nextSibling : container.firstChild;
    if (node !== expected) {
      container.insertBefore(node, expected);
    }
    previous = node;
  }
  for (const stale of existing.values()) {
    stale.remove();
  }
}

function createRow(model: RowModel): HTMLElement {
  const node = document.createElement('div');
  node.dataset.key = model.key;
  const kind = model.key.slice(0, model.key.indexOf(':'));
  const id = model.key.slice(model.key.indexOf(':') + 1);
  // 两行：第一行是「谁」（caret + 状态点 + 标题 + 行内动作），第二行是它的参数
  // （容量/目录/状态/所属 workspace）。参数多的时候横着挤会把标题压没，所以拆行。
  node.innerHTML = `<div class="row-top">
      <button class="caret" data-act="toggleWorkspace" data-id="${id}"></button>
      <span class="dot"></span>
      <span class="row-main" data-act="focus" data-kind="${kind}" data-id="${id}">
        <span class="label"></span>
      </span>
      <span class="row-actions"></span>
    </div>
    <div class="row-sub" data-act="focus" data-kind="${kind}" data-id="${id}" hidden>
      <span class="detail"></span>
    </div>`;
  return node;
}

function updateRow(node: HTMLElement, model: RowModel): void {
  applyClass(node, model.className);
  // 缩进是算出来的（padding-left: base + depth × step），不是每层一个写死的 padding。
  if (node.dataset.depth !== String(model.depth)) {
    node.dataset.depth = String(model.depth);
    node.style.setProperty('--depth', String(model.depth));
  }
  const dot = node.querySelector<HTMLElement>('.dot');
  if (dot) {
    applyClass(dot, model.status);
    dot.title = model.statusTitle;
  }
  const caret = node.querySelector<HTMLElement>('.caret');
  if (caret) {
    const glyph = model.caret?.glyph;
    // 不用 `hidden` 属性：按钮上的 `[hidden]` 会被 UA 的 `display: none` 吃掉槽位，
    // 而槽位必须保留 —— 每个层级都占同一个 caret 槽，dot 才会层层向右（见 style.css）。
    caret.classList.toggle('is-leaf', !glyph);
    caret.setAttribute('aria-hidden', glyph ? 'false' : 'true');
    caret.tabIndex = glyph ? 0 : -1;
    if (glyph) {
      applyIcon(caret, glyph);
    }
  }
  applyText(node.querySelector<HTMLElement>('.label'), model.label);
  // 参数走第二行：detail（容量/目录/状态）+ context（它在哪个 workspace/tab）合成一行。
  const sub = node.querySelector<HTMLElement>('.row-sub');
  if (sub) {
    const params = [model.detail, model.context].filter((part) => part.length > 0).join(' · ');
    applyText(sub.querySelector<HTMLElement>('.detail'), params);
    sub.hidden = params.length === 0;
  }
  patchActions(node.querySelector<HTMLElement>('.row-actions'), model);
}

function patchActions(container: HTMLElement | null, model: RowModel): void {
  if (!container) {
    return;
  }
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children) as HTMLElement[]) {
    const key = child.dataset.actionKey;
    if (key) {
      existing.set(key, child);
    }
  }
  for (const action of model.actions) {
    const key = `${action.act}:${action.id ?? ''}`;
    let node = existing.get(key);
    if (!node) {
      node = document.createElement('button');
      node.dataset.actionKey = key;
      node.dataset.act = action.act;
      node.className = 'icon-btn';
      if (action.id) {
        node.dataset.id = action.id;
      }
      container.appendChild(node);
    }
    existing.delete(key);
    node.title = action.title;
    applyIcon(node, action.icon);
  }
  for (const stale of existing.values()) {
    stale.remove();
  }
}

function renderMenu(): void {
  const menuNode = find('menu');
  if (!menu) {
    menuNode.hidden = true;
    menuNode.innerHTML = '';
    return;
  }
  const items: MenuItemModel[] =
    menu.kind === 'tab'
      ? [
          { act: 'focusTab', label: '在当前页签打开（切 herdr 到这个 tab）', icon: 'terminal' },
          { act: 'openTerminalForTab', label: '为新页签开一个终端（钉在这个 tab）', icon: 'terminalNew' },
        ]
      : menu.kind === 'pane'
      ? [
          { act: 'focusPane', label: '在 herdr 终端里跳到这个 pane', icon: 'terminal' },
          { act: 'renamePane', label: '重命名 pane…', icon: 'rename' },
          { act: 'closePane', label: '关闭 pane', icon: 'close', danger: true },
        ]
      : [
          { act: 'openClient', label: '打开 / 聚焦 herdr 终端（编辑器区）', icon: 'terminal' },
          { act: 'openTerminalPinned', label: '新开终端并钉在这个 workspace', icon: 'terminalNew' },
          { act: 'openTabTerminals', label: '为每个 tab 各开一个终端页签', icon: 'terminalNew' },
          {
            act: 'setWorkspaceCwd',
            label: anchors[menu.id] ? '更改工作目录…' : '设置工作目录…',
            icon: 'folder',
          },
          ...(anchors[menu.id]
            ? [{ act: 'clearWorkspaceCwd', label: '清除工作目录（回到跟随 pane）', icon: 'close' }]
            : []),
          { act: 'renameWorkspace', label: '重命名 workspace…', icon: 'rename' },
          { act: 'closeWorkspace', label: '关闭 workspace', icon: 'close', danger: true },
        ];
  menuNode.hidden = false;
  menuNode.innerHTML =
    `<div class="menu-title">${escapeHtml(menu.label)}</div>` +
    items
      .map(
        (item) =>
          `<button class="menu-item${item.danger ? ' danger' : ''}" data-act="${item.act}" data-id="${menu!.id}"><span class="icon">${ICON[item.icon]}</span><span>${escapeHtml(item.label)}</span></button>`,
      )
      .join('');
  // 夹在视口内：侧栏很窄时菜单不能跑到可视区外（宽度按实测，兜底用 176）
  const rect = menuNode.getBoundingClientRect();
  const width = Math.max(rect.width, 176);
  const height = Math.max(rect.height, 120);
  menuNode.style.left = `${Math.max(2, Math.min(menu.x, window.innerWidth - width - 2))}px`;
  menuNode.style.top = `${Math.max(2, Math.min(menu.y, window.innerHeight - height - 2))}px`;
}

function applyIcon(node: Element | null, name: string): void {
  if (!node) {
    return;
  }
  const holder = node as HTMLElement;
  if (holder.dataset.icon !== name) {
    holder.dataset.icon = name;
    holder.innerHTML = ICON[name] ?? '';
  }
}

function applyText(node: Element | null, text: string): void {
  if (node && node.textContent !== text) {
    node.textContent = text;
  }
}

function applyClass(node: HTMLElement, className: string): void {
  if (node.className !== className) {
    node.className = className;
  }
}

/** 路径缩略：把 `…\Users\<name>\` 折成 `~`，只保留最后两段；分隔符跟原路径一致。 */
function shortPath(value: string): string {
  if (!value) {
    return '';
  }
  const separator = value.includes('\\') ? '\\' : '/';
  const parts = value.split(/[\\/]/).filter(Boolean);
  const homeIndex = parts.findIndex((part, index) => /^Users$/i.test(part) && index === parts.length - 3);
  const tail = homeIndex >= 0 ? parts.slice(homeIndex + 2) : parts.slice(-2);
  const prefix = homeIndex >= 0 ? `~${separator}` : parts.length > 2 ? `…${separator}` : '';
  return parts.length <= 2 ? value : `${prefix}${tail.join(separator)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}
