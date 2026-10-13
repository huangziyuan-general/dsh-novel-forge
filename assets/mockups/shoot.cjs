const { chromium } = require('playwright-core');
const path = require('path');

const ROOT = '/Users/huangshengju/Documents/other/dsh-novel-forge/assets/mockups';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const screens = [
  ['screen-1', '1-项目列表'],
  ['screen-2', '2-详情-基本信息'],
  ['screen-3', '3-门禁拒绝'],
  ['screen-4', '4-全书体检'],
  ['screen-5', '5-提案审批'],
  ['screen-6', '6-章节听书'],
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 900 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(ROOT, 'forge-ui-mock.html'));
  for (const [id, name] of screens) {
    const el = await page.$('#' + id);
    const out = path.join(ROOT, 'png', name + '.png');
    await el.screenshot({ path: out });
    console.log('saved', out);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
