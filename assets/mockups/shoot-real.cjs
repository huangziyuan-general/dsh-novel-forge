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

	// 截图专用：把面板调宽 + 精确裁到「内容实际底部」。
	// 不能用滚动容器的 scrollHeight —— 稿纸 textarea 的内部滚动会把父容器 scrollHeight
	// 撑大 300px 多，出来的图下半截全是空白；而且每调一次还再涨几 px。
	// 改为遍历可见元素的 getBoundingClientRect().bottom 取最大值，才是内容真正画到哪。
	const expand = async () => {
		await page.evaluate(() => {
			const f = document.getElementById('frame');
			f.classList.remove('narrow');
			f.classList.add('wide');
			f.style.width = '520px';
			// 先还原高度，让内部滚动容器按新宽度重新排版
			f.style.height = '780px';
		});
		await sleep(200);
		await page.evaluate(() => {
			const f = document.getElementById('frame');
			let bottom = 0;
			[...f.querySelectorAll('*')].forEach((e) => {
				const cs = getComputedStyle(e);
				if (cs.visibility === 'hidden' || cs.display === 'none') return;
				const r = e.getBoundingClientRect();
				// 只认落在面板水平范围内、高度有效的元素；忽略溢出到视口外的
				if (r.height > 0 && r.left >= f.getBoundingClientRect().left - 1) {
					bottom = Math.max(bottom, r.bottom);
				}
			});
			const pad = 16; // 底部留一点呼吸，不留大片空白
			const h = Math.max(360, Math.min(Math.ceil(bottom - f.getBoundingClientRect().top) + pad, 2600));
			f.style.height = h + 'px';
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
	await doBtn('write', 1400); await expand();
	await shot('real-2-详情-写作台.png');

	await doBtn('assets', 1400); await expand();
	await shot('real-2b-详情-资料.png');

	await doBtn('chapters', 1400); await expand();
	await shot('real-3-章节听书.png');

	await doBtn('lore', 1400); await expand();
	await shot('real-4-世界书.png');

	await doBtn('list', 400); await doBtn('open', 1300);
	await doBtn('polish-blocked', 1100); await expand();
	await shot('real-5-润色守卫拦下.png');

	await doBtn('batch', 1800); await expand();
	await shot('real-6-批量起草.png');

	// ── 深色（切主题后重跑关键四张）──
	await doBtn('theme', 500);

	await doBtn('list', 700); await expand();
	await shot('dark-1-项目列表.png');

	await doBtn('open', 1300);
	await doBtn('checkup', 1000);
	await doBtn('write', 1400); await expand();
	await shot('dark-2-详情-写作台.png');

	await doBtn('assets', 1400); await expand();
	await shot('dark-2b-详情-资料.png');

	await doBtn('chapters', 1400); await expand();
	await shot('dark-3-章节听书.png');

	await doBtn('lore', 1400); await expand();
	await shot('dark-4-世界书.png');

	await doBtn('list', 400); await doBtn('open', 1300);
	await doBtn('polish-blocked', 1100); await expand();
	await shot('dark-5-润色守卫拦下.png');

	await doBtn('batch', 1800); await expand();
	await shot('dark-6-批量起草.png');

	console.log('PAGE ERRORS:', errors.length ? errors.slice(0, 6) : 'none');
	await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
