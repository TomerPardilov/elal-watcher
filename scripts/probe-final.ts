import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const headless = process.argv[2] !== 'headed';
const browser = await chromium.launch({ headless, channel: 'chromium', args: ['--disable-blink-features=AutomationControlled'] });
const page = await browser.newPage({
  viewport: { width: 1200, height: 800 },
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
});

const flightsResponse = page.waitForResponse(r => /\/api\/seatavailability\/lang\/\w+\/flights/i.test(r.url()), { timeout: 90_000 });
const t0 = Date.now();
await page.goto('https://www.elal.com/eng/seat-availability', { waitUntil: 'domcontentloaded', timeout: 60_000 });
const res = await flightsResponse;
const text = await res.text();
console.log(`headless=${headless} status=${res.status()} after ${Date.now() - t0}ms, ${text.length} bytes`);
writeFileSync('debug-seat-api.json', text);
const data = JSON.parse(text);
console.log('runDateTime', data.runDateTime, 'dates', data.dateRange?.dates);
console.log('origins to Israel:', data.flightsToIsrael?.map((o: any) => o.origin).join(','));
const dxb = data.flightsToIsrael?.find((o: any) => o.origin === 'DXB');
console.log('DXB entry:', dxb ? JSON.stringify(dxb, null, 1).slice(0, 3000) : 'NOT PRESENT');
await browser.close();
