/**
 * HerdrPlus 扩展 QA：隔离环境 + CDP 驱动真实 VS Code。
 *
 * 隔离策略：所有 herdr 交互走 `--session herdrplus-qa` 的独立 server（自带 socket），
 * 测试进程与扩展宿主都通过 HERDR_SESSION/HERDR_SOCKET_PATH 指向它 —— 不触碰用户正在用的 session。
 *
 * 驱动方式：优先用扩展自带的默认快捷键（命令面板输入 CJK 在 CDP 下不可靠），需要看命令列表时才用面板。
 *
 * 用法：node src/test/agent/verify.mjs [--keep]
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from 'playwright-core';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, '../../..');
const reportsDir = join(extensionRoot, 'reports', 'qa');
const keep = process.argv.includes('--keep');

const SESSION = 'herdrplus-qa';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9400 + Math.floor(Math.random() * 400));
// 先看环境的 HERDR_BIN，再从 PATH 找（herdr 安装器会把当前版本的 release 目录加进 PATH），
// 最后才退回「本机实测过的版本目录」——避免 herdr 升级后这里就失效。
function resolveHerdrOnPath() {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const first = execFileSync(finder, ['herdr'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first && existsSync(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

const HERDR =
  process.env.HERDR_BIN ??
  resolveHerdrOnPath() ??
  join(process.env.USERPROFILE ?? '', '.herdr', 'packages', 'standalone', 'releases', '0.9.1-x86_64-pc-windows-msvc', 'herdr.exe');
const SOCKET = join(process.env.APPDATA ?? '', 'herdr', 'sessions', SESSION, 'herdr.sock');
// 默认宿主：稳定版 VSCode（Insiders 经常在后台自我更新，启动会被 updater 互斥锁挡掉）。
const CODE_EXE =
  process.env.CODE_HOST_EXE ??
  process.env.CODE_INSIDERS_PATH ??
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
const CODE_PROCESS = basename(CODE_EXE);

const steps = [];
let failures = 0;
let skips = 0;

function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 环境缺东西时明确 SKIP（不计失败），别把「这台机器没有 X」伪装成产品缺陷。 */
function skip(name, reason) {
  steps.push({ name, ok: true, detail: `SKIP ${reason}`, skipped: true });
  skips++;
  console.log(`SKIP  ${name} — ${reason}`);
}

/** 本机有没有可用的 agent CLI（QA 夹具用它造 agent；CI runner 上通常没有）。 */
function hasOnPath(binary) {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(finder, [binary], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some(Boolean);
  } catch {
    return false;
  }
}

const AGENT_KIND = 'pi';
const agentsAvailable = hasOnPath(AGENT_KIND);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单个步骤失败（异常/超时）只记一条 FAIL，不打断整轮 —— 否则一次 flake 会吞掉后面的全部结论。 */
async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    const message = String(error?.message ?? error).split('\n')[0].slice(0, 140);
    if (!steps.some((entry) => entry.name === name)) {
      record(name, false, `异常：${message}`);
    } else {
      console.log(`WARN  ${name} — 步骤内异常：${message}`);
    }
  }
}
const herdr = (args) =>
  run(HERDR, ['--session', SESSION, ...args], { maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout.trim());

async function startServer() {
  const child = spawn(HERDR, ['--session', SESSION, 'server'], { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(SOCKET)) {
      try {
        await herdr(['status']);
        return;
      } catch {
        // 仍在启动
      }
    }
    await sleep(400);
  }
  throw new Error('隔离 herdr server 未就绪');
}

async function resetSession() {
  await run(HERDR, ['--session', SESSION, 'server', 'stop']).catch(() => {});
  await sleep(500);
  rmSync(dirname(SOCKET), { recursive: true, force: true });
}

async function killStaleInstances() {
  await run('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='${CODE_PROCESS}'" | Where-Object { $_.CommandLine -like '*herdrplus-qa-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ]).catch(() => {});
  await sleep(1_500);
}

function waitForCDP(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolvePromise();
        else if (Date.now() < deadline) setTimeout(attempt, 500);
        else reject(new Error('CDP 未就绪'));
      });
      req.on('error', () => (Date.now() < deadline ? setTimeout(attempt, 500) : reject(new Error('CDP 未就绪'))));
      req.end();
    };
    attempt();
  });
}

async function main() {
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  const userDataDir = mkdtempSync(join(tmpdir(), 'herdrplus-qa-'));
  const workspaceDir = mkdtempSync(join(tmpdir(), 'herdrplus-ws-'));
  // xterm 默认 canvas 渲染，读不到文本；关掉 GPU 加速改用 DOM 渲染，QA 才能断言终端内容。
  mkdirSync(join(userDataDir, 'User'), { recursive: true });
  writeFileSync(
    join(userDataDir, 'User', 'settings.json'),
    JSON.stringify({ 'terminal.integrated.gpuAcceleration': 'off' }, null, 2),
    'utf8',
  );

  await killStaleInstances();
  console.log(`[qa] code: ${CODE_EXE}`);
  console.log(`[qa] extension: ${extensionRoot}`);
  console.log(`[qa] isolated herdr session: ${SESSION}`);
  console.log(`[qa] cdp port: ${CDP_PORT}`);

  await resetSession();
  await startServer();
  await herdr(['workspace', 'create', '--label', 'qa-alpha', '--no-focus']);
  await herdr(['workspace', 'create', '--label', 'qa-beta', '--no-focus']);
  // agent start 要求目标 pane 是可用的交互 shell：只有被聚焦/渲染过的 pane 才满足（实测）。
  const seeded = JSON.parse(await herdr(['workspace', 'create', '--label', 'qa-agent', '--focus'])).result;
  if (agentsAvailable) {
    await herdr(['agent', 'start', 'pi', '--kind', 'pi', '--pane', seeded.result?.root_pane?.pane_id ?? seeded.root_pane.pane_id]);
  }
  // 一台 workspace 里跑两个 agent —— 两段式侧栏（Workspaces / Agents）的核心用况
  const dual = JSON.parse(await herdr(['workspace', 'create', '--label', 'qa-dual', '--focus'])).result;
  const secondPane = JSON.parse(
    await herdr(['pane', 'split', dual.root_pane.pane_id, '--direction', 'down', '--focus']),
  ).result.pane.pane_id;
  // 同一 workspace 里再开一个 herdr tab —— 侧栏的 workspace → tab → pane 三层与「每个 tab 一个终端页签」都靠它
  await herdr(['tab', 'create', '--workspace', dual.root_pane.workspace_id, '--label', '2']);
  // agent 名字在 session 内唯一，两个 pane 必须用不同 name
  if (agentsAvailable) {
    await herdr(['agent', 'start', 'qa-dual-a', '--kind', 'pi', '--pane', dual.root_pane.pane_id]);
    await herdr(['agent', 'start', 'qa-dual-b', '--kind', 'pi', '--pane', secondPane]);
  }
  // 专门用来验证「里面还有 agent 在跑 → 关闭前必须先确认」的 workspace
  const busy = JSON.parse(await herdr(['workspace', 'create', '--label', 'qa-busy', '--focus'])).result;
  if (agentsAvailable) {
    await herdr(['agent', 'start', 'qa-busy-a', '--kind', 'pi', '--pane', busy.result?.root_pane?.pane_id ?? busy.root_pane.pane_id]);
  }
  await herdr(['workspace', 'focus', dual.root_pane.workspace_id]);
  record(
    '隔离环境就绪（5 workspace；qa-dual = 2 tab / 3 pane）',
    true,
    agentsAvailable ? `含 ${AGENT_KIND} agent` : `本机没有 ${AGENT_KIND}：agent 相关断言将 SKIP`,
  );

  const code = spawn(
    CODE_EXE,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--extensionDevelopmentPath=${extensionRoot}`,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${userDataDir}`,
      workspaceDir,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HERDR_SESSION: SESSION, HERDR_SOCKET_PATH: SOCKET, HERDR_BIN_PATH: HERDR },
    },
  );
  code.unref();

  await waitForCDP(CDP_PORT);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  let page;
  for (let attempt = 0; attempt < 60 && !page; attempt++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => !candidate.isClosed());
    if (!page) {
      await sleep(1_000);
    }
  }
  if (!page) {
    throw new Error('未能拿到 VS Code workbench 页面');
  }
  await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
  await sleep(5_000);

  // 取证环节不该杀死整轮：CDP 截图偶尔会在渲染繁忙时超时，重试几次再放弃。
  const shot = async (name) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.screenshot({ path: join(reportsDir, `${name}.png`), timeout: 20_000 });
        return;
      } catch (error) {
        if (attempt === 3) {
          console.log(`WARN  截图失败 ${name}：${String(error?.message ?? error).split('\n')[0].slice(0, 100)}`);
          return;
        }
        await sleep(1_500);
      }
    }
  };
  /**
   * 侧栏现在是两个原生 view（Workspaces / Agents），各一个 webview：按 `body[data-section]` 认帧。
   * 不传 section 返回任意一块（用于「总得有一块活着」这类断言）。
   */
  const findSidebar = async (which) => {
    for (const frame of page.frames().filter((f) => f.url().startsWith('vscode-webview://'))) {
      const hit = await frame
        .evaluate(() => ({ owned: Boolean(document.querySelector('[data-f^="list"]')), section: document.body?.dataset?.section }))
        .catch(() => undefined);
      if (hit?.owned && (!which || hit.section === which)) {
        return frame;
      }
    }
    return undefined;
  };
  /** 编辑器区可能是 webview（比如 Herdr 自己的视图）会吞掉键盘事件：先点标签栏空白处，把焦点交回 workbench。 */
  const focusWorkbench = async () => {
    await page.locator('.tabs-container').click({ position: { x: 6, y: 8 } }).catch(() => {});
    await sleep(250);
  };
  const spaces = () => findSidebar('spaces');
  const agents = () => findSidebar('agents');
  /** 命令一律走命令面板（全局动作已经搬到 view 标题按钮上，标题按钮位置不稳，命令是它的同一个 handler）。 */
  const runCommand = async (query, settle = 2_000) => {
    await closeMenus();
    await focusWorkbench();
    await page.keyboard.press('Control+Shift+P');
    await sleep(900);
    await page.keyboard.insertText(query);
    await sleep(1_100);
    await page.keyboard.press('Enter');
    await sleep(settle);
  };
  /** 交互式终端 tab 的数量（我们给终端设了 codicon-terminal 图标，别的视图没有）。 */
  const terminalTabCount = () =>
    page.locator('.tabs-container .tab').filter({ has: page.locator('.codicon-terminal') }).count();
  const visibleTerminalText = async () =>
    (
      await page
        .locator('.terminal-wrapper .xterm-rows')
        .evaluateAll((nodes) => nodes.filter((node) => node.offsetParent !== null).map((node) => node.innerText || ''))
        .catch(() => [])
    )
      .join(' ')
      .replace(/\s+/g, ' ');
  const focusTab = async (predicateText) => {
    const tab = page.locator('.tabs-container .tab').filter({ hasText: predicateText }).first();
    await tab.click();
    await sleep(3_000);
    return visibleTerminalText();
  };
  /** 两块 webview 各自处理键盘：关菜单要在各自 frame 里按 Esc，否则会留下挡事的浮层。 */
  const closeMenus = async () => {
    for (const frame of [await spaces(), await agents()]) {
      if (frame) {
        await frame.locator('body').press('Escape').catch(() => {});
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
  };
  const confirmBar = async () => (await spaces())?.locator('[data-f="confirm"]');
  const sidebarText = async () => {
    const parts = [];
    for (const section of ['spaces', 'agents']) {
      const frame = await findSidebar(section);
      if (frame) {
        parts.push(await frame.locator('body').innerText().catch(() => ''));
      }
    }
    return parts.join(' ');
  };
  const waitForSidebar = async (predicate, timeoutMs = 12_000) => {
    const deadline = Date.now() + timeoutMs;
    let text = '';
    while (Date.now() < deadline) {
      text = await sidebarText();
      if (predicate(text)) {
        return text;
      }
      await sleep(600);
    }
    return text;
  };

  await shot('01-startup');

  // 1) 打开侧栏（Ctrl+Alt+Shift+H）
  await page.keyboard.press('Control+Alt+Shift+H');
  await sleep(4_000);
  await shot('02-sidebar');
  const first = await waitForSidebar((text) => /qa-alpha/.test(text) && /protocol/.test(text));
  record('侧栏 webview 加载并渲染 herdr 数据', /qa-alpha/.test(first) && /qa-agent/.test(first), first.replace(/\s+/g, ' ').slice(0, 180));
  record('状态栏显示 herdr 连接状态', /herdr: socket/.test(await page.locator('.statusbar-item').filter({ hasText: 'herdr' }).first().innerText().catch(() => '')), first.replace(/\s+/g, ' ').slice(0, 60));
  // herdr 对 agent 的显示名可能是 "pi"、"π"、"π - extension" 等，只要求出现 agent 标记 + 协议号
  if (agentsAvailable) {
    const withAgent = await waitForSidebar((text) => /π|pi/i.test(text), 15_000);
    record('侧栏显示 agent 状态与协议', /π|pi/i.test(withAgent) && /protocol/.test(withAgent), withAgent.replace(/\s+/g, ' ').slice(-120));
  } else {
    const emptyState = await waitForSidebar((text) => /protocol/.test(text), 15_000);
    record(
      '无 agent 时给出空态提示',
      /没有检测到 agent|还没有 agent/.test(emptyState) && /protocol/.test(emptyState),
      emptyState.replace(/\s+/g, ' ').slice(-120),
    );
  }

  // 2) bare 终端配置（无 herdr 侧栏 / tab 行 / 外框）
  const tomlPath = join(userDataDir, 'User', 'globalStorage', 'herdrplus.herdrplus', 'herdr-config.toml');
  const toml = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  record(
    '生成 bare 终端配置（5 项覆盖齐全，含首启引导关闭）',
    /onboarding = false/.test(toml) &&
      /sidebar_start_collapsed = true/.test(toml) &&
      /sidebar_collapsed_mode = "hidden"/.test(toml) &&
      /hide_tab_bar_when_single_tab = true/.test(toml) &&
      /pane_outer_borders = false/.test(toml),
    toml.replace(/\s+/g, ' ').slice(0, 160),
  );

  // 3) 渲染稳定性：事件更新不得重建 DOM 节点（重建 = 肉眼可见的闪烁）
  const webview = await spaces();
  if (webview) {
    const rowsBefore = await webview.evaluate(() => document.querySelectorAll('[data-key^="ws:"]').length);
    await webview.evaluate(() => {
      for (const node of Array.from(document.querySelectorAll('[data-key]'))) {
        node.__stable = node.dataset.key;
      }
    });
    await herdr(['workspace', 'create', '--label', 'qa-live', '--no-focus']);
    await sleep(2_500);
    const stability = await webview.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('[data-key^="ws:"]'));
      const kept = nodes.filter((node) => node.__stable && node.__stable === node.dataset.key).length;
      return { total: nodes.length, kept, text: document.body.innerText };
    });
    await shot('03-live-update');
    record(
      '事件更新复用既有 DOM 节点（不闪烁）',
      stability.kept === rowsBefore && /qa-live/.test(stability.text),
      `更新前 ${rowsBefore} 行全部复用（现共 ${stability.total} 行），新 workspace 已上屏`,
    );
  }

  // 4) 命令面板仍能列出扩展命令（先把焦点移出 webview，否则快捷键到不了 workbench）
  await page.keyboard.press('Escape');
  await sleep(400);
  await focusWorkbench();
  await page.keyboard.press('Control+Shift+P');
  await sleep(1_000);
  // 注意：不要用 Backspace 清理输入 —— 删掉 '>' 前缀会把命令面板退化成文件搜索
  await page.keyboard.insertText('Herdr');
  await sleep(1_200);
  let paletteText = await page.locator('.quick-input-list').innerText().catch(() => '');
  if (!/打开 herdr 终端/.test(paletteText)) {
    // 偶发：焦点被 webview 抢走 → 重来一次
    await page.keyboard.press('Escape');
    await sleep(500);
    await focusWorkbench();
    await page.keyboard.press('Control+Shift+P');
    await sleep(1_000);
    await page.keyboard.insertText('Herdr');
    await sleep(1_200);
    paletteText = await page.locator('.quick-input-list').innerText().catch(() => '');
  }
  await shot('04-command-palette');
  record(
    '命令面板列出 HerdrPlus 命令',
    /打开 herdr 终端/.test(paletteText) && /启动 Agent（新终端）/.test(paletteText) && /在当前 workspace 新开一个终端/.test(paletteText),
    paletteText.replace(/\s+/g, ' ').slice(0, 140),
  );
  await page.keyboard.press('Escape');
  await sleep(500);

  // 5) view 标题上的 ▣ / 命令 → 打开 herdr 终端（编辑器区）
  await runCommand('Herdr: 打开 herdr 终端', 9_000);
  await shot('05-herdr-terminal');
  record('「打开 herdr 终端」在编辑器区开出终端', (await page.locator('.tabs-container .tab').count()) > 0);

  // 5b) 交互语义：API 侧切 focus 后，内嵌 TUI 是否跟着换视图（决定侧栏点击/多终端模型）
  // 现在可能同时开着多个终端视图：只读**可见**的那些，拼起来判断（不可见 tab 的内容不算）
  const terminalText = async () =>
    (
      await page
        .locator('.terminal-wrapper .xterm-rows')
        .evaluateAll((nodes) => nodes.filter((node) => node.offsetParent !== null).map((node) => node.innerText || ''))
        .catch(() => [])
    )
      .join(' ')
      .replace(/\s+/g, ' ');
  const alpha = JSON.parse(await herdr(['workspace', 'list']))
    .result.workspaces.find((item) => item.label === 'qa-alpha');
  await herdr(['pane', 'run', alpha.active_tab_id.replace(':t', ':p'), 'echo MARKER-ALPHA-OK']);
  await herdr(['workspace', 'focus', alpha.workspace_id]);
  await sleep(3_500);
  await shot('05b-focus-alpha');
  const alphaText = await terminalText();
  const focusOther = JSON.parse(await herdr(['workspace', 'create', '--label', 'qa-focus', '--focus'])).result;
  await herdr(['pane', 'run', focusOther.root_pane.pane_id, 'echo MARKER-FOCUS-OK']);
  await sleep(3_500);
  await shot('05c-focus-other');
  const focusText = await terminalText();
  record(
    'API 切 focus 后内嵌 TUI 跟随（终端内容随之切换）',
    /MARKER-ALPHA-OK/.test(alphaText) && /MARKER-FOCUS-OK/.test(focusText),
    `alpha 视图含 ALPHA=${/MARKER-ALPHA-OK/.test(alphaText)}，切换后含 FOCUS=${/MARKER-FOCUS-OK/.test(focusText)}`,
  );
  // 真正的 chrome 标记：tab 行的「tab N」与它的 switch 按钮（侧栏收起后零宽，读不到文本）。
  // 不用通用词表（prefix/spaces 之类）—— 那会把 herdr 的说明文字一起判红。
  record(
    '内嵌终端无 herdr chrome（无 tab 行/侧栏）',
    !/\btab \d+\b|\bswitch\b/i.test(alphaText.slice(0, 600)),
    alphaText.slice(0, 160),
  );

  // 6) 终端 tab 右键菜单（resourceScheme == 'vscode-terminal'）
  // 现在标签栏里还有预览/其它视图 tab：先把 herdr 终端调到活动 tab，再右键它。
  await runCommand('Herdr: 打开 herdr 终端', 3_000);
  await page.locator('.tabs-container .tab.active').first().click({ button: 'right' });
  await sleep(1_200);
  await shot('06-tab-context-menu');
  const menuText = await page.locator('.context-view').innerText().catch(() => '');
  record(
    '终端 tab 右键含 HerdrPlus 项、且已无「拆分 Pane」',
    /启动 Agent（新终端）/.test(menuText) && /在当前 workspace 新开一个终端/.test(menuText) && !/拆分 Pane/.test(menuText),
    menuText.replace(/\s+/g, ' ').slice(-120),
  );
  await page.keyboard.press('Escape');
  await sleep(500);

  // 7) ctrl+b 透传到终端（herdr 前缀键，未改任何设置）
  await page.locator('.terminal-wrapper .xterm').locator('visible=true').first().click();
  await sleep(600);
  await page.keyboard.press('Control+b');
  await sleep(1_200);
  await shot('07-prefix-key');
  record('ctrl+b 已发送到终端（截图待人工确认前缀提示）', true, '见 07-prefix-key.png');

  // 8) 侧栏 workspace 行 ▷ → 启动 Agent（新终端）：新 herdr workspace + 新 VSCode 终端
  if (!agentsAvailable) {
    skip('「启动 Agent（新终端）」新建 herdr workspace 并且 agent 真的起来了', `本机没有 ${AGENT_KIND} CLI`);
  }
  const workspacesBefore = JSON.parse(await herdr(['workspace', 'list'])).result.workspaces.map((item) => item.workspace_id);
  const startRow = (await spaces()).locator('[data-key^="ws:"]').first();
  await startRow.hover();
  await sleep(400);
  await startRow.locator('[data-act="startAgent"]').click();
  await sleep(1_800);
  await shot('08-agent-quickpick');
  await page.keyboard.insertText('pi');
  await sleep(900);
  await page.keyboard.press('Enter');
  await sleep(14_000);
  await shot('09-agent-new-terminal');
  const workspacesAfter = JSON.parse(await herdr(['workspace', 'list'])).result.workspaces;
  const newWorkspace = workspacesAfter.find((item) => !workspacesBefore.includes(item.workspace_id));
  let detected = undefined;
  for (let attempt = 0; attempt < 12 && !detected; attempt++) {
    const agents = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.agents;
    detected = agents.find((agent) => agent.workspace_id === newWorkspace?.workspace_id);
    if (!detected) {
      await sleep(1_000);
    }
  }
  record(
    '「启动 Agent（新终端）」新建 herdr workspace 并且 agent 真的起来了',
    workspacesAfter.length === workspacesBefore.length + 1 && Boolean(detected),
    `+${newWorkspace?.workspace_id ?? '?'}${detected ? `，agent=${detected.display_agent ?? detected.name} (${detected.agent_status})` : '，未检测到 agent'}`,
  );

  // 9) 交互规则走查：当前项 / 动作收敛 / 右键菜单 / 重命名 / 预览 / 新终端 / 关闭 / 排序
  const ops = await spaces();
  const opsAgents = await agents();
  const rowOf = (label) => ops.locator('[data-key^="ws:"]').filter({ hasText: label }).first();

  // 9a) 两段式模型：Workspaces = 容器，Agents = 每个 agent 一行（一台 ws 两个 agent 都要在）
  await step('Agents 段：同一 workspace 的两个 agent 都列出', async () => {
    if (!agentsAvailable) {
      skip('Agents 段列出全部 agent（含同一 workspace 内的两个）', `本机没有 ${AGENT_KIND} CLI`);
      return;
    }
    const agentRows = await opsAgents.locator('[data-key]').count();
    const dualRows = await opsAgents.locator('[data-key]', { hasText: 'qa-dual' }).count();
    const workspaceRows = await ops.locator('[data-key^="ws:"]').count();
    record(
      'Agents 段列出全部 agent（含同一 workspace 内的两个）',
      agentRows >= 4 && dualRows === 2 && workspaceRows >= 4,
      `workspaces ${workspaceRows} 行 / agents ${agentRows} 行，其中 qa-dual ${dualRows} 行`,
    );
  });

  // 9b) 点 agent 行 → 聚焦它所在的 pane（终端跟随）
  await step('点 agent 行聚焦该 pane', async () => {
    if (!agentsAvailable) {
      skip('点 agent 行 → 聚焦该 pane 并标为当前', `本机没有 ${AGENT_KIND} CLI`);
      return;
    }
    const target = opsAgents.locator('[data-key]', { hasText: 'qa-dual' }).last();
    const paneId = (await target.getAttribute('data-key')).slice(5);
    await target.locator('.row-main').click();
    await sleep(2_500);
    const focused = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.focused_pane_id;
    const currentKey = await target.getAttribute('class');
    record('点 agent 行 → 聚焦该 pane 并标为当前', focused === paneId && /current/.test(currentKey ?? ''), `${paneId}（服务端 focused=${focused}）`);
  });

  // 9e) workspace 可展开看子 panel（pane）
  await step('workspace foldout 展开子 panel', async () => {
    const target = ops.locator('[data-key^="ws:"]').filter({ hasText: 'qa-dual' }).first();
    const children = () => ops.locator('[data-key^="pane:"]').count();
    const expandedIds = () => ops.evaluate(() => document.body.dataset.expanded ?? '');
    // 事件驱动重排可能让一次 click 被重试成两次（展开又折叠）→ 按目标状态点，直到到位
    const clickCaretUntil = async (want) => {
      for (let attempt = 0; attempt < 4 && (await children()) !== want; attempt++) {
        await target.locator('.caret').click();
        await sleep(700);
      }
      return children();
    };
    const before = await children();
    const expandedBefore = await expandedIds();
    const after = await clickCaretUntil(3);
    const expandedAfter = await expandedIds();
    const rows = ops.locator('[data-key^="pane:"]');
    const text = (await rows.allInnerTexts()).join(' | ').replace(/\s+/g, ' ');
    await shot('09e-foldout');
    record(
      '默认不展开任何 workspace；点 ▸ 才展开出它的 pane',
      before === 0 && expandedBefore === '' && after === 3 && expandedAfter.split(',').length === 1,
      `展开集合「${expandedBefore}」→「${expandedAfter}」，子行 ${before} → ${after}：${text.slice(0, 80)}`,
    );
    // tab 行：workspace → tab → pane 的中间层，点它应该切服务端当前 tab
    const tabRows = ops.locator('[data-key^="tab:"]');
    const tabCount = await tabRows.count();
    const tabId = (await tabRows.first().getAttribute('data-key')).slice(4);
    await tabRows.first().locator('.row-main').click();
    await sleep(2_500);
    const focusedTab = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.focused_tab_id;
    const tabCurrent = await tabRows.first().getAttribute('class');
    record(
      'foldout 里有 tab 层：点 tab 行切服务端当前 tab',
      tabCount === 2 && focusedTab === tabId && /current/.test(tabCurrent ?? ''),
      `${tabCount} 个 tab 行，点 ${tabId} → 服务端 focused_tab=${focusedTab}`,
    );

    // 子 pane 行 → 跳到那个 pane
    const paneId = (await rows.first().getAttribute('data-key')).slice(5);
    await rows.first().locator('.row-main').click();
    await sleep(2_500);
    const focused = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.focused_pane_id;
    record('点子 pane 行 → 终端跳到该 pane', focused === paneId, `${paneId}（服务端 focused=${focused}）`);
    const collapsed = await clickCaretUntil(0);
    const expandedAgain = await expandedIds();
    record('再点一次折叠回去', collapsed === 0 && expandedAgain === '', `子行 ${collapsed}，展开集合「${expandedAgain}」`);
  });

  // 9g) agent 行右键菜单是 pane 级别
  await step('agent 行右键是 pane 菜单', async () => {
    if (!agentsAvailable) {
      skip('agent 行右键为 pane 级菜单（跳转/预览×2/重命名/关闭）', `本机没有 ${AGENT_KIND} CLI`);
      return;
    }
    const target = opsAgents.locator('[data-key]').first();
    await target.click({ button: 'right' });
    await sleep(500);
    const items = (await opsAgents.locator('.menu .menu-item').allInnerTexts()).map((text) => text.trim());
    await shot('09c-agent-menu');
    await opsAgents.locator('body').press('Escape');
    await sleep(300);
    record(
      'agent 行右键为 pane 级菜单（跳转终端/重命名/关闭）',
      items.length === 3 && items.some((item) => item.includes('pane')),
      items.join(' / '),
    );
  });

  // 9d) hover 只露出「指向该行」的动作（全局动作不再挂在行上）
  await step('行 hover 动作：workspace 3 个 / pane 2 个', async () => {
    const target = rowOf('qa-alpha');
    await target.hover();
    await sleep(400);
    const count = await target.locator('[data-action-key]').count();
    const titles = await target.locator('[data-action-key]').evaluateAll((nodes) => nodes.map((n) => n.title));
    await page.mouse.move(4, 4);
    let paneCount = 0;
    if (agentsAvailable) {
      const agentRow = opsAgents.locator('[data-key]').first();
      await agentRow.hover();
      await sleep(400);
      paneCount = await agentRow.locator('[data-action-key]').count();
    } else {
      // 没有 agent 就用 workspace 展开出来的子 pane 行验同一个契约
      const paneRow = ops.locator('[data-key^="pane:"]').first();
      if ((await paneRow.count()) === 0) {
        await rowOf('qa-dual').locator('.caret').click();
        await sleep(700);
      }
      const fallbackRow = ops.locator('[data-key^="pane:"]').first();
      await fallbackRow.hover();
      await sleep(400);
      paneCount = await fallbackRow.locator('[data-action-key]').count();
    }
    record(
      'workspace 行 3 个动作（起 Agent / 开终端并钉住 / 关闭）、pane 行 1 个（跳转终端）',
      count === 3 && paneCount === 1 && titles.some((t) => /钉/.test(t)),
      `workspace ${count}：${titles.join(' / ')}；pane ${paneCount}`,
    );
  });

  // 9b) 点行 → 「当前」标识乐观移动（不等服务端往返）
  await step('点行后当前标识立即移动（乐观）', async () => {
    const currentKey = await ops.locator('.row.current').first().getAttribute('data-key');
    const keys = await ops.locator('[data-key^="ws:"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.key));
    const nextKey = keys.find((key) => key !== currentKey);
    const target = ops.locator(`[data-key="${nextKey}"]`);
    await target.locator('.row-main').click();
    await sleep(120);
    const afterKey = await ops.locator('.row.current').first().getAttribute('data-key');
    await sleep(2_000);
    const serverKey = await ops.locator('.row.current').first().getAttribute('data-key');
    record(
      '点行后当前标识立即移动并在服务端确认后保持',
      Boolean(afterKey) && afterKey !== currentKey && serverKey === afterKey,
      `${currentKey} → ${afterKey}（服务端确认后 ${serverKey}）`,
    );
  });

  // 9c) 右键菜单：六项（含设置工作目录）+ Esc 关闭
  await step('右键菜单六项、Esc 可关', async () => {
    const target = rowOf('qa-alpha');
    await target.click({ button: 'right' });
    await sleep(500);
    const items = await ops.locator('.menu .menu-item').allInnerTexts();
    const visible = await ops.locator('.menu').isVisible();
    await shot('09b-context-menu');
    await ops.locator('body').press('Escape'); // 送进这个 webview：两块侧栏各管自己的键盘
    await sleep(400);
    const hiddenAfter = await ops.locator('.menu').isHidden();
    record(
      '行右键菜单含 6 项、带「设置工作目录」且 Esc 可关',
      visible && items.length === 6 && hiddenAfter && items.some((item) => item.includes('设置工作目录')),
      items.map((item) => item.trim()).join(' / '),
    );
  });

  // 9d) 重命名（右键 → 菜单项 → InputBox）
  await step('右键菜单重命名 workspace', async () => {
    const target = rowOf('qa-beta');
    await target.click({ button: 'right' });
    await sleep(500);
    await ops.locator('.menu .menu-item', { hasText: '重命名' }).click();
    await sleep(1_200);
    await page.keyboard.insertText('qa-renamed');
    await page.keyboard.press('Enter');
    await sleep(2_500);
    const renamed = JSON.parse(await herdr(['workspace', 'list'])).result.workspaces.some((item) => item.label === 'qa-renamed');
    record('右键菜单重命名 workspace', renamed, renamed ? 'qa-beta → qa-renamed' : '未生效');
  });

  // 9b) 预览当前 pane（行内 ◫ → webview 面板）
  // 9b3) 钉住的终端：标签页各自记住一个 workspace，点谁就把服务端焦点切到谁
  await step('钉住的终端：切标签即切 workspace', async () => {
    const snap = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const [first, second] = snap.workspaces.filter((workspace) => workspace.pane_count >= 1);
    if (!first || !second) {
      record('钉住的终端：切标签即切 workspace', false, '没有两个 workspace 可钉');
      return;
    }
    const pin = async (workspaceId) => {
      const row = ops.locator(`[data-key="ws:${workspaceId}"]`);
      await row.click({ button: 'right' });
      await sleep(500);
      await ops.locator('.menu .menu-item', { hasText: '钉在' }).click();
      await sleep(12_000);
      await closeMenus();
      return JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.focused_workspace_id;
    };
    const focusedAfterFirst = await pin(first.workspace_id);
    const focusedAfterSecond = await pin(second.workspace_id);
    // 点第一个终端的标签 → 焦点切回它的 workspace（这才是「多终端各显示各的」的实际效果）
    const tab = page.locator('.tabs-container .tab', { hasText: first.label }).first();
    await tab.click();
    await sleep(4_000);
    const focusedAfterTabClick = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.focused_workspace_id;
    await shot('10c-pinned-terminals');
    record(
      '钉住的终端：开终端即切过去，点标签又切回来',
      focusedAfterFirst === first.workspace_id &&
        focusedAfterSecond === second.workspace_id &&
        focusedAfterTabClick === first.workspace_id,
      `钉 ${first.label} → ${focusedAfterFirst}；钉 ${second.label} → ${focusedAfterSecond}；点回 ${first.label} 标签 → ${focusedAfterTabClick}`,
    );
  });

  // 9b3b) 一个 workspace 的每个 herdr tab ↔ 一个 VSCode 终端页签
  await step('每个 herdr tab 一个终端页签（激活即切 tab）', async () => {
    const snap = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const dual = snap.workspaces.find((workspace) => workspace.tab_count >= 2);
    const tabs = snap.tabs.filter((tab) => tab.workspace_id === dual.workspace_id);
    if (!dual || tabs.length < 2) {
      record(
        '每个 herdr tab 一个终端页签（激活即切 tab）',
        false,
        `没找到多 tab 的 workspace（夹具里应该有：qa-dual 的 2 个 tab）`,
      );
      return;
    }
    const before = await terminalTabCount();
    const row = ops.locator(`[data-key="ws:${dual.workspace_id}"]`);
    await row.click({ button: 'right' });
    await sleep(500);
    await ops.locator('.menu .menu-item', { hasText: '为每个 tab 各开一个终端页签' }).click();
    await sleep(6_000);
    let after = before;
    for (let attempt = 0; attempt < 15 && after < before + tabs.length; attempt++) {
      after = await terminalTabCount();
      if (after < before + tabs.length) {
        await sleep(2_000);
      }
    }
    await closeMenus();
    // 点第二个 tab 对应的终端页签 → 服务端 focused_tab 应该跟着切过去
    const secondLabel = tabs[1].label;
    await focusTab(`· tab ${secondLabel}`).catch(() => '');
    await sleep(2_500);
    const focusedTab = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.focused_tab_id;
    await shot('10f-terminal-per-tab');
    record(
      '每个 herdr tab 一个终端页签（激活即切 tab）',
      after >= before + tabs.length && focusedTab === tabs[1].tab_id,
      `终端页签 ${before} → ${after}（期望 +${tabs.length}），点「tab ${secondLabel}」的页签 → 服务端 focused_tab=${focusedTab}（期望 ${tabs[1].tab_id}）`,
    );
  });

  // 9b3c) 点哪一行，就亮出哪一行的终端（精准，不靠「切焦点让所有终端一起变」）
  await step('选中行只亮出对应的那一个终端', async () => {
    const snap = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const dual = snap.workspaces.find((workspace) => workspace.tab_count >= 2);
    if (!dual) {
      record('选中行只亮出对应的那一个终端', false, '没有多 tab 的 workspace');
      return;
    }
    const tabs = snap.tabs.filter((tab) => tab.workspace_id === dual.workspace_id);
    const wsRow = ops.locator(`[data-key="ws:${dual.workspace_id}"]`);
    if ((await ops.locator(`[data-key="tab:${tabs[0].tab_id}"]`).count()) === 0) {
      await wsRow.locator('.caret').click();
      await sleep(800);
    }
    const activeTabText = async () =>
      ((await page.locator('.tabs-container .tab.active').first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    const seen = [];
    for (const tab of [tabs[1], tabs[0]]) {
      await ops.locator(`[data-key="tab:${tab.tab_id}"]`).locator('.row-main').click();
      await sleep(3_000);
      seen.push(await activeTabText());
    }
    record(
      '点 tab 行 → 只把该 tab 的终端亮出来（两个 tab 轮换，互不串）',
      new RegExp(`tab ${tabs[1].label}`).test(seen[0]) && new RegExp(`tab ${tabs[0].label}`).test(seen[1]),
      `点 tab ${tabs[1].label} → 活动终端「${seen[0]}」；点 tab ${tabs[0].label} → 活动终端「${seen[1]}」`,
    );
  });

  // 9b4) 多 session：另一个 session 的终端可以和当前终端**同时**显示不同内容（真·多个 herdr 实例）
  await step('绑定另一个 session 的终端：两个终端显示不同内容', async () => {
    const OTHER = 'herdrplus-qa2';
    const OTHER_SOCKET = join(process.env.APPDATA ?? '', 'herdr', 'sessions', OTHER, 'herdr.sock');
    const otherHerdr = (args) => run(HERDR, ['--session', OTHER, ...args], { maxBuffer: 8 << 20 }).then((r) => r.stdout.trim());
    let marker = '';
    if (!existsSync(OTHER_SOCKET)) {
      await run(HERDR, ['--session', OTHER, 'server', 'stop']).catch(() => {});
      await sleep(500);
      rmSync(dirname(OTHER_SOCKET), { recursive: true, force: true });
      const otherServer = spawn(HERDR, ['--session', OTHER, 'server'], { detached: true, stdio: 'ignore' });
      otherServer.unref();
      for (let attempt = 0; attempt < 50 && !existsSync(OTHER_SOCKET); attempt++) {
        await sleep(300);
      }
    }
    const created = JSON.parse(await otherHerdr(['workspace', 'create', '--label', 'qa-other', '--focus'])).result;
    marker = 'MARKER-OTHER';
    await otherHerdr(['pane', 'run', created.root_pane.pane_id, `echo ${marker}`]);
    await sleep(1_500);

    const before = await terminalTabCount();
    await runCommand('Herdr: 新开 herdr 终端视图', 2_200);
    await page.keyboard.insertText(OTHER);
    await sleep(1_200);
    await shot('10d-session-quickpick');
    await page.keyboard.press('Enter');
    await sleep(16_000);
    const after = await terminalTabCount();
    const otherText = await focusTab(`@${OTHER}`);
    const ownText = await focusTab(/^herdr$/); // 精确匹配不带后缀的那个终端
    await shot('10e-two-sessions');
    record(
      '多 session：两个终端各显示各的（切标签读内容，互不相同）',
      after >= before && new RegExp(marker).test(otherText) && !new RegExp(marker).test(ownText),
      `${before} → ${after} 个终端 tab；@${OTHER} 内容含 ${marker}=${new RegExp(marker).test(otherText)}，本 session 终端含自有内容=${/MARKER-(ALPHA|WATCH-A|FOCUS)-OK|qa-/.test(ownText)}`,
    );
    await run(HERDR, ['--session', OTHER, 'server', 'stop']).catch(() => {});
  });

  // 9c0) 一键：在当前 workspace 新开一个终端
  await step('在当前 workspace 新开一个终端', async () => {
    const focused = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const label =
      focused.workspaces.find((workspace) => workspace.workspace_id === focused.focused_workspace_id)?.label ?? '';
    // 按终端标签名（`herdr: <workspace 标签>`）数，比按图标数稳（图标可能还没渲染出来）
    const pinnedTabs = () =>
      page.locator('.tabs-container .tab').filter({ hasText: new RegExp(`^herdr:\\s*${label}`) }).count();
    const before = await pinnedTabs();
    await runCommand('Herdr: 在当前 workspace 新开一个终端', 6_000);
    let after = before;
    for (let attempt = 0; attempt < 12 && after <= before; attempt++) {
      after = await pinnedTabs();
      if (after <= before) {
        await sleep(2_000);
      }
    }
    await shot('11c-terminal-here');
    record(
      '「在当前 workspace 新开一个终端」新增一个钉在该 workspace 的终端页签',
      after > before && label.length > 0,
      `${label}：终端页签 ${before} → ${after}`,
    );
  });

  // 9c) 新开终端视图：QuickPick 提供三类目标（跟随焦点 / 钉 workspace / 绑 session）
  await step('「新开 herdr 终端视图」提供三类目标', async () => {
    await runCommand('Herdr: 新开 herdr 终端视图', 2_200);
    const items = ((await page.locator('.quick-input-list').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    // session 那几项在列表下方会被虚拟化裁掉：输入过滤词把它们顶上来再断言
    await page.keyboard.insertText('session');
    await sleep(1_200);
    const filtered = ((await page.locator('.quick-input-list').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    await shot('11-terminal-quickpick');
    await page.keyboard.press('Escape');
    await sleep(500);
    record(
      '「新开 herdr 终端视图」列出「跟随焦点 / 各 workspace / session」三类目标',
      /跟随焦点/.test(items) && /pane ·/.test(items) && /session:/.test(filtered),
      `默认列表：${items.slice(0, 60)}…｜过滤 session：${filtered.slice(0, 60)}`,
    );
  });

  // 9e) 关闭 workspace（右键 → 菜单项）
  await step('右键菜单关闭 workspace', async () => {
    const beforeClose = JSON.parse(await herdr(['workspace', 'list'])).result.workspaces.length;
    const target = rowOf('qa-live');
    await target.click({ button: 'right' });
    await sleep(500);
    await ops.locator('.menu .menu-item', { hasText: '关闭' }).click();
    await sleep(3_000);
    await closeMenus();
    const afterClose = JSON.parse(await herdr(['workspace', 'list'])).result.workspaces.length;
    record('右键菜单关闭 workspace', afterClose === beforeClose - 1, `${beforeClose} → ${afterClose}`);
  });

  // 9h) 排序：命令面板切换 + view 标题旁的描述跟着走
  await step('排序命令切换模式，view 标题描述跟着变', async () => {
    const headerText = async () =>
      (await page
        .locator('.pane-header')
        .filter({ hasText: 'Workspaces' })
        .first()
        .innerText()
        .catch(() => '')).replace(/\s+/g, ' ');
    await runCommand('Herdr: 切换排序', 1_500);
    const first = await headerText();
    await runCommand('Herdr: 切换排序', 1_500);
    const second = await headerText();
    await shot('12-sort-attention');
    record(
      '排序命令切换模式，view 标题描述跟着变',
      /序号|待处理/.test(first) && /序号|待处理/.test(second) && first !== second,
      `${first.slice(0, 40)} → ${second.slice(0, 40)}`,
    );
  });

  // 9f) 破坏性操作：侧栏内联确认条（原生 modal 在 CDP 里抓不到、点不动，所以自己画确认条）
  await step('有 agent 在跑的 workspace：确认条先拦一道，确认后才关', async () => {
    if (!agentsAvailable) {
      skip('qa-busy 有 agent：点 ✕ 先出确认条、不直接关', `本机没有 ${AGENT_KIND} CLI`);
      skip('确认条点「仍然关闭」才真的关掉', `本机没有 ${AGENT_KIND} CLI`);
      return;
    }
    const before = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const target = rowOf('qa-busy');
    await target.hover();
    await sleep(400);
    await target.locator('[data-action-key][title*="关闭"]').click();
    await sleep(1_200);
    const bar = await confirmBar();
    const text = ((await bar?.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    const stillThere = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.workspaces.length;
    await shot('09f-close-confirm');
    record(
      'qa-busy 有 agent：点 ✕ 先出确认条、不直接关',
      bar !== undefined && (await bar.isVisible()) && /qa-busy/.test(text) && stillThere === before.workspaces.length,
      `确认条「${text.slice(0, 80)}」，workspace 数不变 ${stillThere}`,
    );
    await bar.locator('[data-act="confirmPending"]').click();
    await sleep(3_500);
    const after = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    record(
      '确认条点「仍然关闭」才真的关掉',
      after.workspaces.length === before.workspaces.length - 1 &&
        !after.workspaces.some((workspace) => workspace.label === 'qa-busy'),
      `${before.workspaces.length} → ${after.workspaces.length}`,
    );
  });

  await step('确认条可以取消（取消则什么都不关）', async () => {
    if (!agentsAvailable) {
      skip('确认条点「取消」→ 条消失且 workspace 还在', `本机没有 ${AGENT_KIND} CLI`);
      return;
    }
    const before = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const target = rowOf('qa-agent');
    await target.hover();
    await sleep(400);
    await target.locator('[data-action-key][title*="关闭"]').click();
    await sleep(1_000);
    const bar = await confirmBar();
    await bar.locator('[data-act="cancelPending"]').click();
    await sleep(1_500);
    const after = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const hidden = await bar.isHidden();
    record(
      '确认条点「取消」→ 条消失且 workspace 还在',
      hidden && after.workspaces.length === before.workspaces.length,
      `取消后仍是 ${after.workspaces.length} 个 workspace`,
    );
  });

  // 9f2) 关 pane 也要先确认（关 pane 会结束进程）
  await step('关闭 pane 前先出确认条', async () => {
    const snap = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const rootPane = `${snap.focused_workspace_id}:p1`;
    const extra = JSON.parse(await herdr(['pane', 'split', rootPane, '--direction', 'down'])).result.pane.pane_id;
    await herdr(['pane', 'run', extra, 'echo MARKER-PANE-KEEPALIVE']);
    await sleep(2_500);
    // 基线要在「拆出这个 pane 之后」取，否则把新增的那个也算进差值
    const before = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.panes.length;
    const rows = ops.locator(`[data-key="pane:${extra}"]`);
    if ((await rows.count()) === 0) {
      await ops.locator(`[data-key="ws:${snap.focused_workspace_id}"]`).locator('.caret').click();
      await sleep(800);
    }
    const paneRow = ops.locator(`[data-key="pane:${extra}"]`);
    await paneRow.click({ button: 'right' });
    await sleep(500);
    await ops.locator('.menu .menu-item', { hasText: '关闭 pane' }).click();
    await sleep(1_200);
    const bar = await confirmBar();
    const text = ((await bar?.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    const panesDuring = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot.panes.length;
    await shot('09f2-pane-confirm');
    record(
      '关 pane：确认条先拦住（pane 还在）',
      bar !== undefined && (await bar.isVisible()) && /关闭 pane/.test(text) && panesDuring === before,
      `确认条「${text.slice(0, 80)}」，pane 数不变 ${panesDuring}`,
    );
    // 先取消一次：确认条可取消，且什么都不关
    await bar.locator('[data-act="cancelPending"]').click();
    await sleep(1_200);
    const afterCancel = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    record(
      '关 pane 的确认条可以取消（pane 还在）',
      (await bar.isHidden()) && afterCancel.panes.length === before,
      `取消后仍是 ${afterCancel.panes.length} 个 pane`,
    );
    // 再走一次并确认：真的关掉
    await paneRow.click({ button: 'right' });
    await sleep(500);
    await ops.locator('.menu .menu-item', { hasText: '关闭 pane' }).click();
    await sleep(1_200);
    const barAgain = await confirmBar();
    await barAgain.locator('[data-act="confirmPending"]').click();
    await sleep(3_000);
    const after = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    record(
      '确认条点「关闭 pane」才真的关（进程结束）',
      after.panes.length === before - 1 && !after.panes.some((pane) => pane.pane_id === extra),
      `${before} → ${after.panes.length} 个 pane`,
    );
  });

  // 9g) 归档关闭（命令面板上的全局动作）：先确认，再只关空闲/完成且非当前的
  await step('归档关闭收工的 workspace', async () => {
    const before = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const expected = before.workspaces.filter(
      (workspace) => !workspace.focused && workspace.agent_status !== 'working' && workspace.agent_status !== 'blocked',
    ).length;
    await runCommand('Herdr: 归档关闭', 1_800);
    const bar = await confirmBar();
    const text = ((await bar?.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
    const during = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    await shot('09g-sweep-confirm');
    const prompted = bar !== undefined && (await bar.isVisible()) && /归档关闭/.test(text) && during.workspaces.length === before.workspaces.length;
    await bar.locator('[data-act="confirmPending"]').click();
    await sleep(4_000);
    const after = JSON.parse(await herdr(['api', 'snapshot'])).result.snapshot;
    const keptFocused = after.workspaces.some((workspace) => workspace.workspace_id === before.focused_workspace_id);
    record(
      '归档关闭：确认条列出清单，确认后只关空闲/完成的、当前 workspace 保留',
      prompted && after.workspaces.length === before.workspaces.length - expected && keptFocused,
      `${before.workspaces.length} 个 → 预期关 ${expected} → 实际 ${after.workspaces.length}（focused 保留=${keptFocused}）｜${text.slice(0, 70)}`,
    );
  });

  // 10) 服务端不可用时的操作稳定性 + 恢复后自动重连
  await run(HERDR, ['--session', SESSION, 'server', 'stop']).catch(() => {});
  await sleep(6_000);
  // 断线时 spaces 那块会亮出 banner（重试连接 / 定位 herdr），这里点它不崩即可
  const sidebarOffline = (await spaces()) ?? (await findSidebar());
  const refreshButton = sidebarOffline.locator('[data-act="refresh"]').first();
  if (await refreshButton.isVisible().catch(() => false)) {
    await refreshButton.click();
    await sleep(1_500);
  }
  await focusWorkbench();
  await page.keyboard.press('Control+Alt+H'); // 快捷键路径：断线时打开终端也不能崩
  await sleep(6_000);
  const offlineText = await sidebarText();
  await shot('13-server-down');
  // 不崩 = 两块侧栏仍然可交互（帧还在、能读到内容）+ 状态栏还在 + 点操作没有抛异常。
  const offlineFrames = [await spaces(), await agents()].filter(Boolean).length;
  record(
    'server 停掉时点操作不崩（两块侧栏仍活着）',
    offlineFrames === 2 &&
      (await page.locator('.statusbar-item').filter({ hasText: 'herdr' }).count()) > 0 &&
      offlineText.length > 0,
    `${offlineFrames} 块侧栏仍可读（${offlineText.replace(/\s+/g, ' ').slice(0, 70)}），状态栏 herdr 项 ${
      (await page.locator('.statusbar-item').filter({ hasText: 'herdr' }).count()) > 0 ? '在' : '不见了'
    }`,
  );
  await startServer();
  await sleep(10_000);
  const recoveredText = await sidebarText();
  const recovered = await waitForSidebar((text) => /qa-alpha|qa-renamed|protocol/.test(text), 25_000);
  record(
    'server 恢复后侧栏自动重连',
    /qa-alpha|qa-renamed|protocol/.test(recovered) && recovered.length > recoveredText.length - 5,
    recovered.replace(/\s+/g, ' ').slice(0, 110),
  );

  // 10.9) 工作目录锚定
  let autoAnchoredId = '';
  let anchoredCwd = '';
  let manualAnchorId = '';

  //  (a) 扩展建的 workspace 自动锚定 —— 新建时用的就是 VSCode 工作区目录
  await step('新建 workspace 自动锚定到工作区目录', async () => {
    await runCommand('Herdr: 新建 Workspace', 1_500);
    await page.keyboard.insertText('qa-anchor-auto');
    await sleep(300);
    await page.keyboard.press('Enter');
    await sleep(3_500);
    const listed = JSON.parse(await herdr(['workspace', 'list'])).result.workspaces.find(
      (item) => item.label === 'qa-anchor-auto',
    );
    autoAnchoredId = listed?.workspace_id ?? '';
    const text = await waitForSidebar((value) => value.includes('qa-anchor-auto'), 8_000);
    record(
      '新建 workspace 自动锚定到工作区目录',
      Boolean(autoAnchoredId) && text.includes('qa-anchor-auto'),
      autoAnchoredId ? `${autoAnchoredId} 已上屏` : '没建出来',
    );
  });

  //  (b) 手动设一个目录（CLI 建的 workspace 不会被自动锚定，正合手动场景）→ 从它开终端要落在锚定目录
  await step('设置工作目录（手动锚定）后开终端落在锚定目录', async () => {
    const ops = await spaces();
    if (!ops) {
      throw new Error('侧栏未就绪');
    }
    await herdr(['workspace', 'create', '--label', 'qa-anchor', '--no-focus']);
    await sleep(3_000);
    const target = JSON.parse(await herdr(['workspace', 'list'])).result.workspaces.find(
      (item) => item.label === 'qa-anchor',
    );
    if (!target) {
      throw new Error('qa-anchor 没建出来');
    }
    manualAnchorId = target.workspace_id;
    anchoredCwd = mkdtempSync(join(tmpdir(), 'herdrplus-anchor-'));

    await closeMenus();
    await ops.locator(`[data-key="ws:${manualAnchorId}"]`).click({ button: 'right', timeout: 8_000 });
    await sleep(500);
    await ops.locator('[data-act="setWorkspaceCwd"]').click({ timeout: 8_000 });
    await sleep(1_500);
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(anchoredCwd);
    await sleep(300);
    await page.keyboard.press('Enter');
    await sleep(2_000);

    const text = await waitForSidebar((value) => value.includes(basename(anchoredCwd)), 8_000);
    record('锚定目录显示在侧栏行上', text.includes(basename(anchoredCwd)), basename(anchoredCwd));

    await ops.locator(`[data-key="ws:${manualAnchorId}"]`).click({ button: 'right', timeout: 8_000 });
    await sleep(500);
    await ops
      .locator('.menu .menu-item', { hasText: '新开终端并钉在这个 workspace' })
      .click({ timeout: 8_000 });
    await sleep(4_500);
    await shot('10g-anchor-terminal');
  });

  // 11) 收尾诊断：dump 扩展自检报告（含 webview 消息轨迹），便于定位"点了没反应"这类问题
  rmSync(join(tmpdir(), 'herdrplus-doctor.json'), { force: true });
  await page.keyboard.press('Escape');
  await sleep(400);
  await page.mouse.click(900, 300);
  await page.keyboard.press('Control+Shift+P');
  await sleep(900);
  await page.keyboard.insertText('Herdr: 诊断');
  await sleep(900);
  await page.keyboard.press('Enter');
  await sleep(2_500);
  const doctorReport = (() => {
    try {
      return JSON.parse(readFileSync(join(tmpdir(), 'herdrplus-doctor.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  const doctorTrace = doctorReport.trace ?? [];
  const doctorAnchors = doctorReport.anchors ?? {};
  console.log('[qa] trace:', JSON.stringify(doctorTrace, null, 1));
  console.log(
    '[qa] state:',
    JSON.stringify(doctorReport.state),
    'sidebar:',
    JSON.stringify(doctorReport.sidebar),
    'anchors:',
    JSON.stringify(doctorAnchors),
  );

  const webviewErrors = doctorTrace.filter((line) => /webview error/i.test(line));
  record(
    'webview 无 JS 异常',
    webviewErrors.length === 0,
    webviewErrors.length === 0 ? 'trace 里没有 webview error' : webviewErrors.slice(0, 2).join(' | '),
  );

  // 从 workspace/tab 开终端时，终端进程的工作目录要是那个 workspace 的目录（不是 VSCode 默认）
  const cwdLines = doctorTrace.filter((line) => /openClient:/.test(line) && line.includes(`cwd=${process.cwd()}`));
  record(
    '从 workspace 开终端用的是该 workspace 的目录',
    cwdLines.length > 0,
    `${cwdLines.length} 条 openClient 带 cwd=${process.cwd()}${cwdLines.length ? `；示例 ${cwdLines[cwdLines.length - 1].slice(0, 110)}` : ''}`,
  );

  // 锚定目录必须压过 pane 的当前目录：pane 还在 process.cwd()，终端却要落在锚定目录
  if (anchoredCwd && manualAnchorId) {
    const anchored = doctorAnchors[manualAnchorId];
    const cwdAnchored = doctorTrace.filter((line) => /openClient:/.test(line) && line.includes(`cwd=${anchoredCwd}`));
    record(
      '锚定工作目录优先于 pane 的当前目录',
      anchored?.toLowerCase() === anchoredCwd.toLowerCase() && cwdAnchored.length > 0,
      `锚定=${anchored ?? '无'} / 终端 cwd 命中 ${cwdAnchored.length} 条（pane 当时仍在 ${process.cwd()}）`,
    );
  }

  // 新建 workspace 时自动锚定到当时的 VSCode 工作区目录（VSCode 给的 fsPath 是小写盘符，比较时忽略大小写）
  if (autoAnchoredId) {
    const anchored = doctorAnchors[autoAnchoredId];
    record(
      '新建 workspace 自动锚定到工作区目录',
      anchored?.toLowerCase() === workspaceDir.toLowerCase(),
      anchored ? `${autoAnchoredId} → ${anchored}` : `${autoAnchoredId} 没有锚定记录`,
    );
  }

  console.log('\n摘要：');
  for (const step of steps) {
    const mark = step.skipped ? '○' : step.ok ? '✓' : '✗';
    console.log(`  ${mark} ${step.name}${!step.ok && step.detail ? ` — ${step.detail}` : ''}`);
  }
  console.log(`\n截图目录：${reportsDir}`);

  spawn('taskkill', ['/PID', String(code.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(1_500);
  await run(HERDR, ['--session', SESSION, 'server', 'stop']).catch(() => {});
  await sleep(500);
  rmSync(dirname(SOCKET), { recursive: true, force: true });
  if (keep) {
    console.log(`\n[qa] 保留日志目录：${userDataDir}`);
  } else {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
  await browser.close().catch(() => {});
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error('[qa] 运行中断：', error);
  // 抛异常时 main 里的清理不会执行；Playwright 的连接会一直吊着事件循环 —— 直接退出，别让整个流水线卡死。
  // （残留的 QA 窗口由下次运行的 killStaleInstances() 收掉。）
  process.exit(1);
});
