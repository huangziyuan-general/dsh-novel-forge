const { chromium } = require('playwright-core');
const path = require('path');

const ROOT = '/Users/huangshengju/Documents/other/dsh-novel-forge';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const file = 'file://' + path.join(ROOT, 'preview', 'forge-ui.html');
const OUT = path.join(ROOT, 'assets', 'mockups', 'png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
	const page = await browser.newPage({ viewport: { width: 1120, height: 1000 }, deviceScaleFactor: 2 });
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	await page.goto(file);
	await page.waitForSelector('[data-dsh-novel-forge-panel]', { timeout: 15000 });
	await sleep(2000);

	// 把面板撑到内容全高（内部滚动区 scrollHeight + 头部余量），截图就能看到整页
	const expand = async () => {
		await page.evaluate(() => {
			const f = document.getElementById('frame');
			const sc = [...f.querySelectorAll('*')].find((e) => getComputedStyle(e).overflowY === 'auto');
			if (sc) f.style.height = Math.min(sc.scrollHeight + 76, 2600) + 'px';
		});
		await sleep(160);
	};
	const shot = async (name) => {
		const el = await page.$('#frame');
		await el.screenshot({ path: path.join(OUT, name) });
		console.log('saved', name);
	};
	const doBtn = async (what, wait = 1100) => { await page.click(`[data-do="${what}"]`, { timeout: 6000 }).catch(() => {}); await sleep(wait); };

	// ── 浅色 ──
	await doBtn('list', 700); await expand();
	await shot('real-1-项目列表.png');

	await doBtn('open', 1300);
	await doBtn('checkup', 1000);
	await doBtn('info', 500); await expand();
	await shot('real-2-详情-基本信息.png');

	await doBtn('chapters', 800); await expand();
	await shot('real-3-章节听书.png');

	await doBtn('lore', 1000); await expand();
	await shot('real-4-世界书.png');

	await doBtn('list', 400); await doBtn('open', 1300);
	await doBtn('polish-blocked', 1100); await expand();
	await shot('real-5-润色守卫拦下.png');

	await doBtn('batch', 1400); await expand();
	await shot('real-6-批量起草.png');

	// ── 深色（切主题后重跑关键四张）──
	await doBtn('theme', 500);

	await doBtn('list', 700); await expand();
	await shot('dark-1-项目列表.png');

	await doBtn('open', 1300);
	await doBtn('checkup', 1000);
	await doBtn('info', 500); await expand();
	await shot('dark-2-详情-基本信息.png');

	await doBtn('chapters', 800); await expand();
	await shot('dark-3-章节听书.png');

	await doBtn('lore', 1000); await expand();
	await shot('dark-4-世界书.png');

	await doBtn('list', 400); await doBtn('open', 1300);
	await doBtn('polish-blocked', 1100); await expand();
	await shot('dark-5-润色守卫拦下.png');

	await doBtn('batch', 1400); await expand();
	await shot('dark-6-批量起草.png');

	console.log('PAGE ERRORS:', errors.length ? errors.slice(0, 6) : 'none');
	await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
