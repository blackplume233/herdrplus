import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`);
const ctx = browser.contexts()[0];
for (const page of ctx.pages()) {
  console.log('PAGE', page.url().slice(0, 70));
  for (const f of page.frames()) console.log('   frame:', f.url().slice(0, 80));
}
await browser.close();
