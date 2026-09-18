// 诊断：挂到活着的 VS Code 上，看侧栏 webview 里的行结构 / 可点性
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`);
const ctx = browser.contexts()[0];
const pages = ctx.pages();
console.log('pages:', pages.map((p) => p.url().slice(0, 60)));

const webviews = [];
for (const page of pages) {
  for (const frame of page.frames()) {
    if (frame.url().includes('vscode-webview')) {
      webviews.push(frame);
    }
  }
}
console.log('webview frames:', webviews.length);

for (const frame of webviews) {
  const info = await frame.evaluate(() => {
    const doc = document.querySelector('iframe')?.contentDocument ?? document;
    const rows = [...doc.querySelectorAll('[data-key]')];
    const keys = rows.map((row) => row.getAttribute('data-key'));
    const tabRows = rows.filter((row) => (row.getAttribute('data-key') ?? '').startsWith('tab:'));
    return {
      url: location.href.slice(-24),
      rowCount: rows.length,
      wsKeys: keys.filter((k) => k.startsWith('ws:')),
      tabKeys: keys.slice(0, 60),
      expandedFlag: rows.filter((r) => r.querySelector('.caret')).map((r) => r.getAttribute('data-key')),
      tabRows: tabRows.map((row) => {
        const rect = row.getBoundingClientRect();
        const caret = row.querySelector('.caret');
        const label = row.querySelector('.label');
        const caretRect = caret?.getBoundingClientRect();
        const labelRect = label?.getBoundingClientRect();
        const style = getComputedStyle(row);
        return {
          key: row.getAttribute('data-key'),
          rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
          display: style.display,
          visibility: style.visibility,
          caret: caretRect ? [Math.round(caretRect.x), Math.round(caretRect.y), Math.round(caretRect.width)] : null,
          label: labelRect ? [Math.round(labelRect.x), Math.round(labelRect.y), Math.round(labelRect.width)] : null,
          text: (row.textContent ?? '').slice(0, 40),
        };
      }),
      wsRows: rows
        .filter((r) => (r.getAttribute('data-key') ?? '').startsWith('ws:'))
        .map((r) => {
          const rect = r.getBoundingClientRect();
          const caret = r.querySelector('.caret');
          const cr = caret?.getBoundingClientRect();
          return {
            key: r.getAttribute('data-key'),
            rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
            caret: cr ? [Math.round(cr.x), Math.round(cr.y), Math.round(cr.width)] : null,
          };
        }),
    };
  });
  console.log(JSON.stringify(info, null, 1));
}
await browser.close();
