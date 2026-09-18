/**
 * herdr 数据结构（socket API / CLI 共用）。
 *
 * 字段名与 herdr 原样一致（snake_case），不做重命名 —— webview、Tauri 形态共用同一份契约。
 * 真源：vendor/herdr-schema.json（`herdr api schema --json`，protocol 22）。
 */

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface PaneScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  worktree?: unknown;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: AgentStatus;
  revision: number;
  cwd?: string | null;
  foreground_cwd?: string | null;
  label?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  display_agent?: string | null;
  agent?: string | null;
  state_labels?: Record<string, string>;
  scroll?: PaneScrollInfo;
}

export interface AgentInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: AgentStatus;
  revision: number;
  name?: string | null;
  display_agent?: string | null;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: unknown[];
  agents: AgentInfo[];
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
}

export interface PaneReadResult {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: string;
  format: string;
  text: string;
  revision: number;
  truncated: boolean;
}

export interface ServerCapabilities {
  live_handoff?: boolean;
  detached_server_daemon?: boolean;
  endpoint_protocol_generation?: number;
  surface_interest?: boolean;
  health_check?: boolean;
}

export interface PongResult {
  type: 'pong';
  version: string;
  protocol: number;
  capabilities: ServerCapabilities;
}

/** 订阅事件 envelope：`{ event, data }`；data 里再带 `type` 与实体字段。 */
export interface SubscriptionEvent {
  event: string;
  data: { type?: string } & Record<string, unknown>;
}

export interface Subscription {
  type: string;
  pane_id?: string;
  source?: string;
  match?: string;
  [key: string]: unknown;
}

/** 侧栏/状态栏共享的连接状态。 */
export type ClientState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'ready'; transport: 'socket' | 'cli'; version: string; protocol: number }
  | { kind: 'error'; message: string; hint?: string };

/** 侧栏列表排序：序号（herdr 的 workspace number）/ 待处理优先（等待输入 → 工作中 → 完成 → 空闲）。 */
export type SortMode = 'number' | 'attention';

/** agent/pane 状态的统一中文措辞（侧栏渲染与确认条文案共用，避免两处漂移）。 */
export const STATUS_TEXT: Record<string, string> = {
  blocked: '等待输入',
  working: '工作中',
  idle: '空闲',
  done: '完成',
  unknown: '',
};

/** 侧栏订阅的事件（生命周期 + agent 状态）。 */
export const SUBSCRIPTIONS: Subscription[] = [
  { type: 'workspace.created' },
  { type: 'workspace.updated' },
  { type: 'workspace.closed' },
  { type: 'workspace.focused' },
  { type: 'workspace.renamed' },
  { type: 'tab.created' },
  { type: 'tab.closed' },
  { type: 'tab.focused' },
  { type: 'tab.renamed' },
  { type: 'pane.created' },
  { type: 'pane.closed' },
  { type: 'pane.focused' },
  { type: 'pane.exited' },
  { type: 'pane.updated' },
  { type: 'layout.updated' },
];

/** `pane.read` 的 socket 响应：文本快照挂在 `read` 下（CLI 版本直接输出纯文本，不带 envelope）。 */
export interface PaneReadResponse {
  type: string;
  read: PaneReadResult;
}
