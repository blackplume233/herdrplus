import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import {
  ClientState,
  PongResult,
  SessionSnapshot,
  SUBSCRIPTIONS,
  Subscription,
  SubscriptionEvent,
} from './types.js';

const run = promisify(execFile);

const REQUEST_TIMEOUT_MS = 15_000;
const CLI_POLL_MS = 2_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 15_000;
const EVENT_DEBOUNCE_MS = 120;

/** 连接级失败（区别于 herdr 返回的业务错误）——决定是否降级。 */
const SOCKET_FAILURE_CODES: Record<string, true> = {
  ENOENT: true,
  ECONNREFUSED: true,
  ECONNRESET: true,
  EPIPE: true,
  EACCES: true,
  ETIMEDOUT: true,
  ENOTSOCK: true,
};

export interface HerdrClientOptions {
  binaryPath?: string;
  socketPath?: string;
  cliFallback?: boolean;
  log?: (message: string) => void;
}

/**
 * herdr 客户端。
 *
 * 传输语义（实测）：herdr 的 socket API **一次连接只服务一个请求**，响应后服务端立刻关闭连接
 * （同一连接上的第二个请求必然 EPIPE）；`events.subscribe` 是唯一的例外——它需要一条常驻连接持续推事件。
 * 因此这里每个请求开一条短连接，事件流单独一条长连接；socket 不可用时整体降级为 CLI 轮询。
 */
export class HerdrClient {
  private eventStream?: net.Socket;
  private eventBuffer = '';
  private seq = 0;
  private state: ClientState = { kind: 'idle' };
  private disposed = false;
  private active = false;
  private retryTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private retryDelay = RETRY_MIN_MS;
  private latest?: SessionSnapshot;
  private paneIds: string[] = [];
  private lastError?: string;

  private readonly binaryPath?: string;
  /** 扩展生成的 herdr 配置（bare 内嵌终端用）——也带给 CLI：CLI 可能是**拉起 server 的那一次**调用。 */
  configPath?: string;
  private readonly socketPath: string;
  private readonly cliFallback: boolean;
  private readonly log: (message: string) => void;
  private readonly logRing: string[] = [];

  onState: (state: ClientState) => void = () => {};
  onSnapshot: (snapshot: SessionSnapshot) => void = () => {};
  onEvent: (event: SubscriptionEvent) => void = () => {};

  constructor(options: HerdrClientOptions = {}) {
    this.binaryPath = options.binaryPath;
    this.socketPath = options.socketPath?.trim() || process.env.HERDR_SOCKET_PATH || defaultSocketPath();
    this.cliFallback = options.cliFallback ?? true;
    const sink = options.log;
    this.log = (message) => {
      this.logRing.push(`${new Date().toISOString()} ${message}`);
      if (this.logRing.length > 60) {
        this.logRing.shift();
      }
      sink?.(message);
    };
  }

  /** 最近日志（诊断报告用）。 */
  get recentLog(): string[] {
    return [...this.logRing];
  }

  get currentState(): ClientState {
    return this.state;
  }

  get currentSnapshot(): SessionSnapshot | undefined {
    return this.latest;
  }

  get transport(): 'socket' | 'cli' | 'none' {
    return this.state.kind === 'ready' ? this.state.transport : 'none';
  }

  get binary(): string | undefined {
    return this.binaryPath;
  }

  /** socket 文件路径（herdr 端点，未加管道前缀）。 */
  get socketFile(): string {
    return this.socketPath;
  }

  /** 实际连接的 Windows 管道路径（非 Windows 为 socket 文件本身）。 */
  get socketTarget(): string {
    return pipePath(this.socketPath);
  }

  start(): void {
    if (this.disposed) {
      return;
    }
    void this.bootstrap();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (this.transport === 'cli') {
      if (active) {
        this.startPolling();
      } else {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
    }
    if (active && this.state.kind !== 'ready') {
      this.retryDelay = RETRY_MIN_MS;
      clearTimeout(this.retryTimer);
      void this.bootstrap();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.debounceTimer);
    clearInterval(this.pollTimer);
    this.eventStream?.destroy();
    this.eventStream = undefined;
    this.state = { kind: 'idle' };
  }

  /** 发一个请求（socket 优先；socket 不可用时按配置降级到 CLI）。 */
  async request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.state.kind === 'ready' && this.state.transport === 'cli') {
      return this.cliRequest<T>(method, params);
    }
    try {
      return await this.socketRequest<T>(method, params);
    } catch (error) {
      if (!isSocketFailure(error)) {
        throw error;
      }
      this.downgrade(reasonOf(error));
      if (this.cliFallback && this.binaryPath) {
        return this.cliRequest<T>(method, params);
      }
      throw error;
    }
  }

  async snapshot(): Promise<SessionSnapshot> {
    const result = await this.request<{ snapshot: SessionSnapshot }>('session.snapshot', {});
    return result.snapshot;
  }

  /** 读 pane 文本快照。socket 返回 `{type, read:{…}}`；CLI 的 `pane read` 直接打纯文本 —— 两条路都归一成字符串。 */


  /** 重取快照；pane 集合变化时重建事件订阅（作用域事件的 pane_id 是订阅参数）。 */
  async refresh(): Promise<void> {
    try {
      const snapshot = await this.snapshot();
      this.latest = snapshot;
      const paneIds = snapshot.panes.map((pane) => pane.pane_id).sort();
      const changed = paneIds.length !== this.paneIds.length || paneIds.some((id, index) => id !== this.paneIds[index]);
      this.paneIds = paneIds;
      this.onSnapshot(snapshot);
      if (this.transport === 'socket' && (changed || !this.eventStream)) {
        await this.openEventStream();
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  // ── bootstrap / 降级 ───────────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.setState({ kind: 'connecting' });
    try {
      const pong = await this.socketRequest<PongResult>('ping', {});
      this.lastError = undefined;
      this.retryDelay = RETRY_MIN_MS;
      this.setState({ kind: 'ready', transport: 'socket', version: pong.version, protocol: pong.protocol });
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      await this.refresh();
      await this.openEventStream();
    } catch (error) {
      this.downgrade(reasonOf(error));
    }
  }

  /** socket 不可用：有 CLI 则降级轮询，否则报错；两种情况都安排重试。 */
  private downgrade(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.eventStream?.destroy();
    this.eventStream = undefined;
    this.log(`降级：${reason}`);
    if (this.cliFallback && this.binaryPath) {
      this.setState({
        kind: 'ready',
        transport: 'cli',
        version: this.latest?.version ?? '?',
        protocol: this.latest?.protocol ?? 0,
      });
      if (this.active) {
        this.startPolling();
      }
    } else {
      this.setState({ kind: 'error', message: reason, hint: '运行 `herdr status` 检查 server 是否在运行' });
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.bootstrap(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => void this.refresh(), CLI_POLL_MS);
    void this.refresh();
  }

  // ── socket 传输：一次连接一个请求 ───────────────────────────────────────

  private socketRequest<T>(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = net.connect({ path: this.socketTarget });
      let buffer = '';
      let settled = false;

      const finish = (error?: Error, value?: T) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(value as T);
        }
      };

      const timer = setTimeout(() => finish(new Error(`herdr ${method} 超时`)), timeoutMs);

      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id: `req${++this.seq}`, method, params })}\n`);
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const index = buffer.indexOf('\n');
        if (index < 0) {
          return;
        }
        const line = buffer.slice(0, index).trim();
        let message: { result?: unknown; error?: { code?: string; message?: string } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          finish(new Error(`herdr ${method} 返回了无法解析的响应：${line.slice(0, 120)}`));
          return;
        }
        if (message.error) {
          finish(new Error(`herdr ${message.error.code ?? 'error'}: ${message.error.message ?? 'unknown'}`));
          return;
        }
        finish(undefined, message.result as T);
      });
      socket.on('error', (error: NodeJS.ErrnoException) => finish(socketFailure(error)));
      socket.on('close', () => finish(new Error('herdr 在响应前关闭了连接')));
    });
  }

  // ── 事件长连接 ─────────────────────────────────────────────────────────

  private async openEventStream(): Promise<void> {
    this.eventStream?.destroy();
    const socket = net.connect({ path: this.socketTarget });
    this.eventStream = socket;
    this.eventBuffer = '';

    const subscriptions: Subscription[] = [
      ...SUBSCRIPTIONS,
      ...this.paneIds.map((paneId) => ({ type: 'pane.agent_status_changed', pane_id: paneId })),
    ];

    let acknowledge: (() => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const ack = new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      fail = reject;
    });
    const ackTimer = setTimeout(() => fail?.(new Error('events.subscribe 超时')), REQUEST_TIMEOUT_MS);

    socket.on('data', (chunk) => {
      this.eventBuffer += chunk.toString('utf8');
      let index: number;
      while ((index = this.eventBuffer.indexOf('\n')) >= 0) {
        const line = this.eventBuffer.slice(0, index).trim();
        this.eventBuffer = this.eventBuffer.slice(index + 1);
        if (!line) {
          continue;
        }
        let message: (SubscriptionEvent & { id?: string; result?: { type?: string } }) | undefined;
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          this.log(`无法解析 herdr 事件：${line.slice(0, 160)}`);
          continue;
        }
        if (!message) {
          continue;
        }
        if (message.id === 'sub') {
          clearTimeout(ackTimer);
          acknowledge?.();
        } else if (message.event) {
          this.onEvent({ event: message.event, data: message.data });
          this.scheduleRefresh();
        }
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(ackTimer);
      fail?.(socketFailure(error));
    });
    socket.on('close', () => {
      clearTimeout(ackTimer);
      fail?.(new Error('事件流连接已关闭'));
      if (this.eventStream === socket) {
        this.eventStream = undefined;
        this.downgrade('事件流连接已关闭');
      }
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions } })}\n`);
    });

    try {
      await ack;
    } catch (error) {
      this.log(`事件订阅失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private scheduleRefresh(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(), EVENT_DEBOUNCE_MS);
  }

  // ── CLI 降级传输 ────────────────────────────────────────────────────────

  private async cliRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const args = cliArgs(method, params);
    if (!args) {
      throw new Error(`herdr CLI 无对应子命令：${method}（该操作需要 socket 连接）`);
    }
    const { stdout } = await run(this.binaryPath!, args, {
      maxBuffer: 8 * 1024 * 1024,
      ...(this.configPath ? { env: { ...process.env, HERDR_CONFIG_PATH: this.configPath } } : {}),
    });
    const last = stdout.trim().split('\n').pop() ?? '{}';
    const envelope = JSON.parse(last) as { result?: unknown; error?: { code?: string; message?: string } };
    if (envelope.error) {
      throw new Error(`herdr ${envelope.error.code ?? 'error'}: ${envelope.error.message ?? ''}`);
    }
    return envelope.result as T;
  }

  // ── 状态 ───────────────────────────────────────────────────────────────

  private setState(state: ClientState): void {
    this.state = state;
    this.lastError = state.kind === 'error' ? state.message : this.lastError;
    this.onState(state);
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log(message);
    if (this.state.kind !== 'ready' || this.state.transport !== 'cli') {
      this.setState({ kind: 'error', message });
    }
  }
}

/** 带连接错误码的失败：用于区分「连接问题」与「herdr 业务错误」。 */
function socketFailure(error: NodeJS.ErrnoException): Error & { socketCode?: string } {
  const wrapped = new Error(`socket ${error.code ?? ''} ${error.message}`.trim()) as Error & { socketCode?: string };
  wrapped.socketCode = error.code;
  return wrapped;
}

function isSocketFailure(error: unknown): boolean {
  const code = (error as { socketCode?: string } | undefined)?.socketCode;
  return code !== undefined && SOCKET_FAILURE_CODES[code] === true;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSocketPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'herdr', 'herdr.sock');
}

function pipePath(socketPath: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/** method → CLI argv（与 CLI 旗标一一对应；无 CLI 等价的 method 返回 undefined）。 */
function cliArgs(method: string, params: Record<string, unknown>): string[] | undefined {
  switch (method) {
    case 'ping':
      return ['status'];
    case 'session.snapshot':
      return ['api', 'snapshot'];
    case 'workspace.create': {
      const args = ['workspace', 'create'];
      if (typeof params.label === 'string' && params.label) {
        args.push('--label', params.label);
      }
      if (typeof params.cwd === 'string' && params.cwd) {
        args.push('--cwd', params.cwd);
      }
      args.push(params.focus === true ? '--focus' : '--no-focus');
      return args;
    }
    case 'workspace.focus':
      return typeof params.workspace_id === 'string' ? ['workspace', 'focus', params.workspace_id] : undefined;
    case 'workspace.rename':
      return typeof params.workspace_id === 'string' && typeof params.label === 'string'
        ? ['workspace', 'rename', params.workspace_id, params.label]
        : undefined;
    case 'workspace.close':
      return typeof params.workspace_id === 'string' ? ['workspace', 'close', params.workspace_id] : undefined;
    case 'tab.focus':
      return typeof params.tab_id === 'string' ? ['tab', 'focus', params.tab_id] : undefined;
    case 'pane.read': {
      const args = ['pane', 'read', typeof params.pane_id === 'string' ? params.pane_id : ''];
      if (typeof params.source === 'string') {
        args.push('--source', params.source);
      }
      if (typeof params.lines === 'number') {
        args.push('--lines', String(params.lines));
      }
      return args;
    }
    case 'pane.close':
      return typeof params.pane_id === 'string' ? ['pane', 'close', params.pane_id] : undefined;
    case 'pane.rename':
      return typeof params.pane_id === 'string' && typeof params.label === 'string'
        ? ['pane', 'rename', params.pane_id, params.label]
        : undefined;
    case 'agent.start': {
      const args = [
        'agent',
        'start',
        typeof params.name === 'string' ? params.name : '',
        '--kind',
        typeof params.kind === 'string' ? params.kind : '',
      ];
      if (typeof params.pane_id === 'string') {
        args.push('--pane', params.pane_id);
      }
      if (typeof params.timeout_ms === 'number') {
        args.push('--timeout', String(params.timeout_ms));
      }
      return args;
    }
    default:
      return undefined;
  }
}

/** 诊断用：对 socket 做一次原始 ping 往返，返回每一步的结果（不改动任何状态）。 */
// 用 executor 形式而非 Promise.withResolvers：它属于 ES2024，老版 VS Code 自带的 Node 20 没有。
export async function probeSocket(
  socketPath: string,
  timeoutMs = 4_000,
): Promise<{ target: string; connected: boolean; response?: string; error?: string }> {
  const target = pipePath(socketPath);
  return await new Promise((resolve) => {
    const socket = net.connect({ path: target });
    let response = '';
    let connected = false;
    let settled = false;
    const done = (extra: { response?: string; error?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ target, connected, ...extra });
    };
    const timer = setTimeout(() => done({ error: 'timeout' }), timeoutMs);

    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ id: 'doctor', method: 'ping', params: {} })}\n`);
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\n')) {
        done({ response: response.trim().slice(0, 300) });
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      done({ error: `${error.code ?? ''} ${error.message}`.trim() });
    });
    socket.on('close', () => done({ error: response ? undefined : 'closed before response', response }));
  });
}

/** 探测 herdr 可执行文件：显式设置 > 默认安装目录；PATH 解析见 locateHerdrOnPath。 */
export function locateHerdr(explicitPath?: string): string | undefined {
  const home = os.homedir();
  const releases = path.join(home, '.herdr', 'packages', 'standalone', 'releases');
  const candidates: string[] = [];
  if (explicitPath?.trim()) {
    candidates.push(explicitPath.trim());
  }
  try {
    for (const version of fs.readdirSync(releases).filter((name) => name.includes('windows')).sort().reverse()) {
      candidates.push(path.join(releases, version, 'herdr.exe'));
    }
  } catch {
    // 未安装到默认目录
  }
  candidates.push(path.join(home, '.local', 'bin', 'herdr'), '/usr/local/bin/herdr', '/opt/homebrew/bin/herdr');
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/** 通过 PATH 解析 herdr（失败返回 undefined）。 */
export async function locateHerdrOnPath(): Promise<string | undefined> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await run(finder, ['herdr']);
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first && fs.existsSync(first) ? first : undefined;
  } catch {
    return undefined;
  }
}
