import 'dotenv/config';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SEAT_AVAILABILITY_URL = 'https://www.elal.com/eng/seat-availability';
const FLIGHTS_API_PATTERN = /\/api\/seatavailability\/lang\/\w+\/flights/i;
// Headless Chromium reports "HeadlessChrome/...", which the EL AL WAF denies outright (HTTP 492).
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const POLL_INTERVAL_MS = 60_000;
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
  travelDate: string; // YYYY-MM-DD
}

interface TelegramConfig {
  token: string;
  chatId: string;
}

interface CheckResult {
  runDateTime: string;
  originListed: boolean;
  dateInRange: boolean;
  dateRange: string[];
  availableFlights: Array<{ flightNumber: string; depTime: string; seatCount?: number; seatType?: string }>;
  totalRouteFlights: number;
}

function parseWatchConfig(): WatchConfig {
  const travelDate = process.env.TRAVEL_DATE ?? '2026-10-02';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) {
    throw new Error(`TRAVEL_DATE must use YYYY-MM-DD format, got: ${travelDate}`);
  }
  return {
    originCode: (process.env.ORIGIN_CODE ?? 'DXB').toUpperCase(),
    destinationCode: (process.env.DESTINATION_CODE ?? 'TLV').toUpperCase(),
    travelDate
  };
}

function parseTelegramConfig(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  return token && chatId ? { token, chatId } : null;
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
  const apiDate = toApiDate(config.travelDate);
  const groups = config.destinationCode === 'TLV' ? data.flightsToIsrael : data.flightsFromIsrael;
  const group = groups.find(g => g.origin === config.originCode)
    ?? groups.find(g => g.flights.some(f => f.routeFrom === config.originCode && f.routeTo === config.destinationCode));
  const routeFlights = (group?.flights ?? []).filter(
    f => f.routeFrom === config.originCode && f.routeTo === config.destinationCode
  );

  const availableFlights = routeFlights.flatMap(f =>
    f.flightsDates
      .filter(d => d.flightsDate === apiDate && (d.seatCount ?? 0) > 0)
      .map(d => ({ flightNumber: f.flightNumber, depTime: f.segmentDepTime, seatCount: d.seatCount, seatType: d.seatType }))
  );

  return {
    runDateTime: data.runDateTime,
    originListed: routeFlights.length > 0,
    dateInRange: data.dateRange.dates.includes(apiDate),
    dateRange: data.dateRange.dates,
    availableFlights,
    totalRouteFlights: routeFlights.length
  };
}

function formatMessage(result: CheckResult, config: WatchConfig): { title: string; body: string; found: boolean } {
  const route = `${config.originCode} -> ${config.destinationCode}`;
  const date = toApiDate(config.travelDate);

  if (result.availableFlights.length > 0) {
    const lines = result.availableFlights.map(
      f => `${f.flightNumber} dep ${f.depTime} - ${f.seatCount} seat(s) [${f.seatType}]`
    );
    return {
      found: true,
      title: `EL AL: ${route} seats on ${date}!`,
      body: [`Book now: ${SEAT_AVAILABILITY_URL}`, ...lines, `(EL AL data as of ${result.runDateTime})`].join('\n')
    };
  }

  let reason: string;
  if (!result.dateInRange) {
    reason = `${date} not yet in EL AL's published window (${result.dateRange[0]} - ${result.dateRange.at(-1)})`;
  } else if (!result.originListed) {
    reason = `${config.originCode} is not listed among EL AL origins at all`;
  } else {
    reason = `${result.totalRouteFlights} ${route} flight(s) listed, none with seats on ${date}`;
  }
  return {
    found: false,
    title: `EL AL: no ${route} seats yet`,
    body: `${reason}\n(EL AL data as of ${result.runDateTime})`
  };
}

function sendDesktopNotification(title: string, body: string, urgent: boolean): Promise<void> {
  const args = ['--app-name=EL AL Watcher', `--urgency=${urgent ? 'critical' : 'normal'}`, title, body];
  return new Promise(resolve => {
    execFile('notify-send', args, () => resolve());
  });
}

async function sendTelegram(config: TelegramConfig, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }
}

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(LOG_FILE, stamped + '\n');
}

async function notify(title: string, body: string, urgent: boolean, telegram: TelegramConfig | null): Promise<void> {
  await sendDesktopNotification(title, body, urgent);
  if (telegram) {
    try {
      await sendTelegram(telegram, `${title}\n${body}`);
    } catch (error) {
      log(`telegram failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function runOnce(config: WatchConfig, telegram: TelegramConfig | null): Promise<void> {
  try {
    const data = await fetchSeatAvailability();
    const result = evaluate(data, config);
    const message = formatMessage(result, config);
    log(`${message.title} | ${message.body.replace(/\n/g, ' | ')}`);
    await notify(message.title, message.body, message.found, telegram);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`check failed: ${reason}`);
    await notify('EL AL watcher: check failed', reason.slice(0, 300), false, telegram);
  }
}

async function main(): Promise<void> {
  const config = parseWatchConfig();
  const telegram = parseTelegramConfig();
  const once = process.argv.includes('--once');
  // Lets a time-limited host (e.g. a GitHub Actions job) stop before being killed.
  const maxRunMinutes = Number(process.env.MAX_RUN_MINUTES ?? 0);
  const deadline = maxRunMinutes > 0 ? Date.now() + maxRunMinutes * 60_000 : Infinity;

  log(`watching ${config.originCode} -> ${config.destinationCode} on ${config.travelDate}, every ${POLL_INTERVAL_MS / 1000}s, telegram=${telegram ? 'on' : 'off'}${maxRunMinutes > 0 ? `, max ${maxRunMinutes} min` : ''}`);

  do {
    await runOnce(config, telegram);
    if (once) break;
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      log('max run time reached, exiting');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (true);
}

process.on('unhandledRejection', reason => {
  log(`unhandled rejection (ignored): ${reason instanceof Error ? reason.message : String(reason)}`);
});

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
