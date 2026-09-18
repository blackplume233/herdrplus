import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`);
for (const [ci, ctx] of browser.contexts().entries()) {
  for (const page of ctx.pages()) {
    console.log(`ctx${ci} PAGE`, page.url().slice(0, 60));
    for (const f of page.frames()) {
      const sec = await f.evaluate(() => document.body?.dataset?.section ?? '-').catch(() => 'x');
      console.log('   frame:', f.url().slice(0, 70), '| section =', sec);
    }
  }
}
await browser.close();
