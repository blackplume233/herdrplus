/**
 * 离线渲染侧栏 webview（不启动 VS Code）：把 media/style.css + media/sidebar.js 装进一个空白页，
 * 灌一份 fixture 快照，截图到 reports/。用于快速看观感、验证展开/折叠等纯前端行为。
 *
 *   bun run render            # 默认 380x520 @3x
 *   bun run render --expand   # 额外展开所有 workspace，看 tab / pane 子行
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const media = join(root, 'media');
const reports = join(root, 'reports');
mkdirSync(reports, { recursive: true });

/**
 * 找一个能用的 Chromium：HERDRPLUS_CHROME > ms-playwright 里已下载的 > playwright 默认。
 * （不写死个人路径，别人 clone 下来也能跑。）
 */
function findChrome() {
  if (process.env.HERDRPLUS_CHROME) {
    return process.env.HERDRPLUS_CHROME;
  }
  const roots = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    const candidates = readdirSync(root)
      .filter((name) => name.startsWith('chromium-'))
      .sort()
      .reverse()
      .map((name) => join(root, name, 'chrome-win', 'chrome.exe'))
      .filter((file) => existsSync(file));
    if (candidates.length > 0) {
      return candidates[0];
    }
  }
  return undefined; // 交给 playwright 的默认解析（未下载时会给出明确的安装提示）
}

const CHROME = findChrome();

const pageFile = join(reports, 'preview.html');
const snapshot = JSON.parse(readFileSync(join(root, 'src/test/fixtures/sidebar-snapshot.json'), 'utf8'));
const expandAll = process.argv.includes('--expand');
const size = process.argv.includes('--tall') ? { width: 380, height: 720 } : { width: 380, height: 520 };

/**
 * 上下两块是 VSCode 的两个 view（各一个 webview），预览就用两个并排的「view」还原：
 * 左 = Workspaces（可 --expand 展开子 pane），右 = Agents。
 */

/** 离线预览没有 VSCode 注入主题变量，这里补一套「dark+ 近似值」，否则状态点/按钮全透明。 */
const THEME = `:root {
  --vscode-font-family: "Segoe UI", system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-sideBar-background: #1f1f1f;
  --vscode-icon-foreground: #c5c5c5;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-inactiveSelectionBackground: #37373d;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-charts-blue: #3794ff;
  --vscode-charts-green: #89d185;
  --vscode-charts-orange: #d18616;
  --vscode-charts-red: #f14c4c;
  --vscode-charts-purple: #b180d7;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-toolbar-hoverBackground: #5a5d5e;
  --vscode-inputValidation-warningBackground: #352a05;
  --vscode-inputValidation-warningBorder: #b89500;
}
`;
const css = THEME + readFileSync(join(media, 'style.css'), 'utf8');
const ICON_PROBE = '.row-actions { display: flex !important; }';
const js = readFileSync(join(media, 'sidebar.js'), 'utf8');
const frameFile = (section) => {
  const file = join(reports, `preview-${section}.html`);
  writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}${ICON_PROBE}</style></head>
<body data-section="${section}"><div id="root"></div>
<script>window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} });</script>
<script>${js}</script></body></html>`,
  );
  return file;
};

// 上下两块在 VSCode 里是两个原生 view（各自 webview）；预览用两个并排的 iframe 还原它们，
// 标题行的样式照着 VSCode 的 view header 写，方便看「分栏后」的整体观感。
writeFileSync(
  pageFile,
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}
  body { background: var(--vscode-sideBar-background); display: flex; gap: 0; align-items: flex-start; }
  .hp-view { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
  .hp-view-head { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 4px; font-size: 11px; }
  .hp-title { font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.9; }
  .hp-desc { margin-left: auto; color: var(--vscode-descriptionForeground); }
  .hp-chevron { opacity: 0.8; font-size: 10px; }
  iframe { width: 100%; border: 0; display: block; height: 430px; }
  </style></head>
<body>
  <section class="hp-view">
    <div class="hp-view-head"><span class="hp-chevron">⌄</span><span class="hp-title">Workspaces</span><span class="hp-desc">3 · 待处理</span></div>
    <iframe src="${basename(frameFile('spaces'))}"></iframe>
  </section>
  <section class="hp-view">
    <div class="hp-view-head"><span class="hp-chevron">⌄</span><span class="hp-title">Agents</span><span class="hp-desc">4 · 1 待处理</span></div>
    <iframe src="${basename(frameFile('agents'))}"></iframe>
  </section>
</body></html>`,
);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: size.width * 2 + 8, height: size.height }, deviceScaleFactor: 3 });
await page.goto(`file://${pageFile}`);
const spacesFrame = page.frames().find((f) => f.url().includes('preview-spaces'));
await spacesFrame.waitForSelector('[data-key]').catch(() => {});
for (const handle of page.frames().filter((f) => f !== page.mainFrame())) {
  await handle.evaluate((data) => {
    window.postMessage({ type: 'state', state: { kind: 'ready', transport: 'socket', version: '0.9.1', protocol: 22 }, sort: 'attention' }, '*');
    window.postMessage({ type: 'snapshot', snapshot: data }, '*');
  }, snapshot);
}
if (expandAll) {
  const spaces = page.frames().find((f) => f.url().includes('preview-spaces'));
  const rows = spaces.locator('[data-key^="ws:"]');
  for (let index = 0; index < (await rows.count()); index++) {
    await rows.nth(index).locator('.caret').click();
  }
}
await page.waitForTimeout(400);
await page.mouse.move(0, 0);
const file = join(reports, expandAll ? 'sidebar-expanded-3x.png' : 'sidebar-3x.png');
await page.screenshot({ path: file });
console.log(
  JSON.stringify(
    await page.evaluate(() => ({
      frames: document.querySelectorAll('iframe').length,
    })),
  ),
);
console.log(`→ ${file}`);
await browser.close();
