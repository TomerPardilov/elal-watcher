import 'dotenv/config';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { TelegramBot, escapeHtml } from './telegram.js';

const SEAT_AVAILABILITY_URL = 'https://www.elal.com/eng/seat-availability';
const FLIGHTS_API_PATTERN = /\/api\/seatavailability\/lang\/\w+\/flights/i;
// Headless Chromium reports "HeadlessChrome/...", which the EL AL WAF denies outright (HTTP 492).
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const POLL_INTERVAL_MS = 60_000;
const COMMAND_POLL_MS = 5_000;
const LOG_FILE = 'watcher.log';

interface FlightDate {
  flightsDate: string;
  seatCount?: number;
  seatType?: string;
}

interface ApiFlight {
  flightCarrier: string;
  flightNumber: string;
  routeFrom: string;
  routeTo: string;
  segmentDepTime: string;
  flightsDates: FlightDate[];
  isFlightAvailable: boolean;
  originDetails?: { cityName?: string; countryName?: string };
  destinationDetails?: { cityName?: string; countryName?: string };
}

interface ApiOriginGroup {
  origin: string;
  flights: ApiFlight[];
}

interface SeatAvailabilityResponse {
  responseCode: number;
  runDateTime: string;
  dateRange: { dates: string[] };
  flightsToIsrael: ApiOriginGroup[];
  flightsFromIsrael: ApiOriginGroup[];
}

interface WatchConfig {
  originCode: string;
  destinationCode: string;
  travelDates: string[]; // YYYY-MM-DD
}

interface DateResult {
  travelDate: string; // YYYY-MM-DD
  apiDate: string; // DD.MM
  inRange: boolean;
  availableFlights: Array<{ flightNumber: string; depTime: string; seatCount?: number; seatType?: string }>;
}

interface CheckResult {
  runDateTime: string;
  originListed: boolean;
  totalRouteFlights: number;
  dateRange: string[];
  dates: DateResult[];
}

interface Message {
  title: string;
  plain: string;
  html: string;
  found: boolean;
  alertKey: string; // identifies the set of available seats, to avoid re-sending the same alert
}

function parseWatchConfig(): WatchConfig {
  const raw = process.env.TRAVEL_DATES ?? process.env.TRAVEL_DATE ?? '2026-10-02,2026-10-03,2026-10-04,2026-10-05,2026-10-06,2026-10-07,2026-10-08,2026-10-09';
  const travelDates = raw.split(',').map(d => d.trim()).filter(Boolean);
  for (const d of travelDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new Error(`TRAVEL_DATES must be comma-separated YYYY-MM-DD values, got: ${d}`);
    }
  }
  if (travelDates.length === 0) {
    throw new Error('TRAVEL_DATES is empty');
  }
  return {
    originCode: (process.env.ORIGIN_CODE ?? 'DXB').toUpperCase(),
    destinationCode: (process.env.DESTINATION_CODE ?? 'TLV').toUpperCase(),
    travelDates
  };
}

function createTelegramBot(): TelegramBot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return new TelegramBot({
    token,
    seedChatId: process.env.TELEGRAM_CHAT_ID,
    subscribersFile: process.env.SUBSCRIBERS_FILE ?? 'subscribers.json',
    encryptionKey: process.env.SUBSCRIBERS_KEY,
    gitPersist: process.env.GIT_PERSIST === '1',
    log
  });
}

// API uses "DD.MM" keys
function toApiDate(isoDate: string): string {
  const [, month, day] = isoDate.split('-');
  return `${day}.${month}`;
}

async function fetchSeatAvailability(): Promise<SeatAvailabilityResponse> {
  // Radware bot-manager rejects automation-flagged browsers; this flag clears navigator.webdriver.
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--disable-blink-features=AutomationControlled']
  });
  try {
    const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1200, height: 800 }, userAgent: USER_AGENT });
    // Promise.all keeps both promises handled, so a goto failure can't leave waitForResponse as an unhandled rejection.
    const [response] = await Promise.all([
      page.waitForResponse(r => FLIGHTS_API_PATTERN.test(r.url()), { timeout: 90_000 }),
      page.goto(SEAT_AVAILABILITY_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    ]);
    if (response.status() !== 200) {
      throw new Error(`flights API returned HTTP ${response.status()}`);
    }
    const data = (await response.json()) as SeatAvailabilityResponse;
    if (!Array.isArray(data.flightsToIsrael)) {
      throw new Error('flights API returned unexpected payload');
    }
    return data;
  } finally {
    await browser.close();
  }
}

function evaluate(data: SeatAvailabilityResponse, config: WatchConfig): CheckResult {
  const groups = config.destinationCode === 'TLV' ? data.flightsToIsrael : data.flightsFromIsrael;
  const group = groups.find(g => g.origin === config.originCode)
    ?? groups.find(g => g.flights.some(f => f.routeFrom === config.originCode && f.routeTo === config.destinationCode));
  const routeFlights = (group?.flights ?? []).filter(
    f => f.routeFrom === config.originCode && f.routeTo === config.destinationCode
  );

  const dates = config.travelDates.map(travelDate => {
    const apiDate = toApiDate(travelDate);
    return {
      travelDate,
      apiDate,
      inRange: data.dateRange.dates.includes(apiDate),
      availableFlights: routeFlights.flatMap(f =>
        f.flightsDates
          .filter(d => d.flightsDate === apiDate && (d.seatCount ?? 0) > 0)
          .map(d => ({ flightNumber: f.flightNumber, depTime: f.segmentDepTime, seatCount: d.seatCount, seatType: d.seatType }))
      )
    };
  });

  return {
    runDateTime: data.runDateTime,
    originListed: routeFlights.length > 0,
    totalRouteFlights: routeFlights.length,
    dateRange: data.dateRange.dates,
    dates
  };
}

function formatMessage(result: CheckResult, config: WatchConfig): Message {
  const route = `${config.originCode} → ${config.destinationCode}`;
  const found = result.dates.some(d => d.availableFlights.length > 0);
  const window = `${result.dateRange[0]} – ${result.dateRange.at(-1)}`;

  const plain: string[] = [];
  const html: string[] = [];

  if (found) {
    plain.push(`SEATS FOUND ${route}`);
    html.push(`🟢🟢🟢 <b>SEATS FOUND</b> 🟢🟢🟢`, `✈️ <b>${escapeHtml(route)}</b>`, '');
  } else {
    plain.push(`No ${route} seats yet`);
    html.push(`🔴 <b>No seats yet</b>  ✈️ <b>${escapeHtml(route)}</b>`, '');
  }

  for (const d of result.dates) {
    if (d.availableFlights.length > 0) {
      plain.push(`[OK] ${d.apiDate}:`);
      html.push(`✅ <b>${d.apiDate}</b>`);
      for (const f of d.availableFlights) {
        plain.push(`   ${f.flightNumber} dep ${f.depTime} - ${f.seatCount} seat(s) [${f.seatType}]`);
        html.push(`   🎟 <code>${escapeHtml(f.flightNumber)}</code> dep <b>${escapeHtml(f.depTime)}</b> — <b>${f.seatCount}</b> seat(s) [${escapeHtml(f.seatType ?? '?')}]`);
      }
    } else if (!d.inRange) {
      plain.push(`[--] ${d.apiDate}: not yet in EL AL window (${window})`);
      html.push(`⚪ <b>${d.apiDate}</b> — not yet in EL AL window (${escapeHtml(window)})`);
    } else if (!result.originListed) {
      plain.push(`[X] ${d.apiDate}: ${config.originCode} not listed as an EL AL origin`);
      html.push(`❌ <b>${d.apiDate}</b> — ${escapeHtml(config.originCode)} not listed as an EL AL origin`);
    } else {
      plain.push(`[X] ${d.apiDate}: ${result.totalRouteFlights} flight(s) listed, no seats`);
      html.push(`❌ <b>${d.apiDate}</b> — ${result.totalRouteFlights} flight(s) listed, no seats`);
    }
  }

  if (found) {
    plain.push('', `Book now: ${SEAT_AVAILABILITY_URL}`);
    html.push('', `👉 <a href="${SEAT_AVAILABILITY_URL}">BOOK NOW</a>`);
  }
  plain.push(`(EL AL data as of ${result.runDateTime})`);
  html.push('', `🕒 <i>EL AL data as of ${escapeHtml(result.runDateTime)}</i>`);

  return {
    found,
    alertKey: result.dates.flatMap(d => d.availableFlights.map(f => `${d.apiDate}/${f.flightNumber}/${f.depTime}/${f.seatCount}`)).sort().join(','),
    title: plain[0],
    plain: plain.slice(1).join('\n').trim(),
    html: html.join('\n')
  };
}

function sendDesktopNotification(title: string, body: string, urgent: boolean): Promise<void> {
  const args = ['--app-name=EL AL Watcher', `--urgency=${urgent ? 'critical' : 'normal'}`, title, body];
  return new Promise(resolve => {
    execFile('notify-send', args, () => resolve());
  });
}

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(LOG_FILE, stamped + '\n');
}

let lastAlertKey = '';

async function notify(message: Message, bot: TelegramBot | null): Promise<void> {
  await sendDesktopNotification(message.title, message.plain, message.found);
  if (bot) {
    bot.setLastStatus(message.html);
    // Push only when seats exist AND the available set changed; otherwise it's available via /status.
    if (message.found && message.alertKey !== lastAlertKey) {
      await bot.broadcast(message.html);
      log(`broadcast seat alert to ${bot.subscriberCount} subscriber(s)`);
    }
  }
  lastAlertKey = message.alertKey;
}

async function runOnce(config: WatchConfig, bot: TelegramBot | null): Promise<void> {
  try {
    const data = await fetchSeatAvailability();
    const result = evaluate(data, config);
    const message = formatMessage(result, config);
    log(`${message.title} | ${message.plain.replace(/\n+/g, ' | ')} | subscribers=${bot?.subscriberCount ?? 0}`);
    await notify(message, bot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`check failed: ${reason}`);
    const short = reason.slice(0, 300);
    await notify({
      found: false,
      alertKey: lastAlertKey,
      title: 'EL AL watcher: check failed',
      plain: short,
      html: `⚠️ <b>Check failed</b>\n<code>${escapeHtml(short)}</code>\n<i>Will retry in a minute</i>`
    }, bot);
  }
}

// Sleeps until the next check while answering /start, /stop, /status promptly.
async function waitAndServeCommands(bot: TelegramBot | null, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, Math.min(COMMAND_POLL_MS, until - Date.now())));
    if (bot) {
      await bot.pollCommands().catch(error => {
        log(`telegram poll failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}

async function main(): Promise<void> {
  const config = parseWatchConfig();
  const bot = createTelegramBot();
  const once = process.argv.includes('--once');
  // Lets a time-limited host (e.g. a GitHub Actions job) stop before being killed.
  const maxRunMinutes = Number(process.env.MAX_RUN_MINUTES ?? 0);
  const deadline = maxRunMinutes > 0 ? Date.now() + maxRunMinutes * 60_000 : Infinity;

  log(`watching ${config.originCode} -> ${config.destinationCode} on ${config.travelDates.join(', ')}, every ${POLL_INTERVAL_MS / 1000}s, telegram=${bot ? `on (${bot.subscriberCount} subscribers)` : 'off'}${maxRunMinutes > 0 ? `, max ${maxRunMinutes} min` : ''}`);

  do {
    await runOnce(config, bot);
    if (once) break;
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      log('max run time reached, exiting');
      break;
    }
    await waitAndServeCommands(bot, POLL_INTERVAL_MS);
  } while (true);
}

process.on('unhandledRejection', reason => {
  log(`unhandled rejection (ignored): ${reason instanceof Error ? reason.message : String(reason)}`);
});

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
