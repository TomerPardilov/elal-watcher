# EL AL Flight Watcher

Checks EL AL's seat-availability feed for a one-way route (default Dubai `DXB` -> Tel Aviv `TLV` on 2026-10-02) every 60 seconds and sends a desktop notification **every cycle** — both when seats are found and when they are not.

## How it works

EL AL publishes a JSON feed behind its "seat availability" page:
`https://www.elal.com/api/SeatAvailability/lang/eng/flights`.
The site is protected by a bot manager that rejects plain HTTP clients, so the script opens the page in headless Chromium (with the automation flag hidden), lets the page call the API itself, and reads the JSON response. No form filling, no screen scraping.

The feed covers a rolling ~8-day window. Until 02.10 enters that window the notification will say so explicitly.

## Setup

```bash
cp .env.example .env     # edit if you want a different route/date
npm install
npx playwright install chromium
```

## Run

```bash
npm run check   # one check, then exit (good for testing)
npm start       # check every 60 s forever
```

Every check also appends a line to `watcher.log`.

## Configuration (`.env`)

| Key | Default | Notes |
|---|---|---|
| `ORIGIN_CODE` | `DXB` | IATA code |
| `DESTINATION_CODE` | `TLV` | IATA code |
| `TRAVEL_DATES` | `2026-10-02,2026-10-03,2026-10-04` | comma-separated `YYYY-MM-DD` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | empty | Optional. Telegram is blocked on some corporate networks; failures are logged and ignored. |

## Notes

- If you see `check failed: flights API returned HTTP 492`, the EL AL WAF has temporarily rate-limited your IP. It clears on its own; the script will keep retrying every minute.
- `scripts/probe-final.ts` is a diagnostic that fetches the feed once and prints the origins list and the DXB entry: `npx tsx scripts/probe-final.ts`.
