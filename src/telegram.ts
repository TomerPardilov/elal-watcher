import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number; first_name?: string } };
}

export interface BotOptions {
  token: string;
  seedChatId?: string;
  subscribersFile: string;
  // When set, the subscribers file is AES-256-GCM encrypted (the repo is public).
  encryptionKey?: string;
  // Commit + push the subscribers file after each change (used inside GitHub Actions).
  gitPersist: boolean;
  log: (line: string) => void;
}

export class TelegramBot {
  private readonly subscribers = new Set<string>();
  private offset = 0;
  private lastStatusHtml: string | null = null;

  constructor(private readonly opts: BotOptions) {
    this.load();
    if (opts.seedChatId && !this.subscribers.has(opts.seedChatId)) {
      this.subscribers.add(opts.seedChatId);
      this.persist();
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  setLastStatus(html: string): void {
    this.lastStatusHtml = html;
  }

  // Reads pending /start, /stop, /status commands. Call this often (every few seconds).
  async pollCommands(): Promise<void> {
    const updates = (await this.api('getUpdates', {
      offset: this.offset,
      timeout: 0,
      allowed_updates: ['message']
    })) as TelegramUpdate[];

    for (const update of updates) {
      this.offset = update.update_id + 1;
      const text = update.message?.text?.trim();
      if (!text || !update.message) continue;
      const chatId = String(update.message.chat.id);
      const command = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
      const name = update.message.chat.first_name ?? 'there';

      if (command === '/start') {
        const isNew = !this.subscribers.has(chatId);
        if (isNew) {
          this.subscribers.add(chatId);
          this.persist();
          this.opts.log(`new subscriber ${chatId} (${this.subscribers.size} total)`);
        }
        await this.sendSafe(chatId,
          `👋 Hi ${escapeHtml(name)}! ${isNew ? 'You are now <b>subscribed</b>' : 'You are already subscribed'} to EL AL seat alerts.\n` +
          `You will get an update <b>every minute</b>.\n\n` +
          `Commands: /status – current result · /stop – unsubscribe`);
        if (this.lastStatusHtml) await this.sendSafe(chatId, this.lastStatusHtml);
      } else if (command === '/stop') {
        if (this.subscribers.delete(chatId)) {
          this.persist();
          this.opts.log(`unsubscribed ${chatId} (${this.subscribers.size} total)`);
        }
        await this.sendSafe(chatId, '🔕 Unsubscribed. Send /start any time to subscribe again.');
      } else if (command === '/status') {
        await this.sendSafe(chatId, this.lastStatusHtml ?? '⏳ No check has completed yet, try again in a minute.');
      } else {
        await this.sendSafe(chatId, 'Commands: /start – subscribe · /status – current result · /stop – unsubscribe');
      }
    }
  }

  async broadcast(html: string): Promise<void> {
    for (const chatId of [...this.subscribers]) {
      try {
        await this.send(chatId, html);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // User blocked the bot or deleted the chat; stop sending to them.
        if (/403|blocked|chat not found|deactivated/i.test(message)) {
          this.subscribers.delete(chatId);
          this.persist();
          this.opts.log(`removed subscriber ${chatId}: ${message}`);
        } else {
          this.opts.log(`telegram send to ${chatId} failed (ignored): ${message}`);
        }
      }
    }
  }

  private async send(chatId: string, html: string): Promise<void> {
    await this.api('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
  }

  private async sendSafe(chatId: string, html: string): Promise<void> {
    try {
      await this.send(chatId, html);
    } catch (error) {
      this.opts.log(`telegram reply to ${chatId} failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async api(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`https://api.telegram.org/bot${this.opts.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    const json = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    if (!response.ok || !json.ok) {
      throw new Error(`Telegram ${method} HTTP ${response.status}: ${json.description ?? 'unknown error'}`);
    }
    return json.result;
  }

  private load(): void {
    if (!existsSync(this.opts.subscribersFile)) return;
    try {
      const raw = readFileSync(this.opts.subscribersFile, 'utf8');
      const list = JSON.parse(this.opts.encryptionKey ? decrypt(raw, this.opts.encryptionKey) : raw) as string[];
      for (const id of list) this.subscribers.add(String(id));
      this.opts.log(`loaded ${this.subscribers.size} subscriber(s)`);
    } catch (error) {
      this.opts.log(`could not read subscribers file (starting empty): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    const json = JSON.stringify([...this.subscribers]);
    writeFileSync(this.opts.subscribersFile, this.opts.encryptionKey ? encrypt(json, this.opts.encryptionKey) : json + '\n');
    if (!this.opts.gitPersist) return;
    const file = this.opts.subscribersFile;
    const script =
      `git add "${file}" && git -c user.name=elal-watcher-bot -c user.email=bot@users.noreply.github.com ` +
      `commit -q -m "chore: update subscribers [skip ci]" && git pull --rebase -q && git push -q`;
    execFile('sh', ['-c', script], (error, _stdout, stderr) => {
      if (error) this.opts.log(`git persist failed (ignored): ${stderr.trim() || error.message}`);
    });
  }
}

function keyBytes(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) throw new Error('SUBSCRIBERS_KEY must be 64 hex characters (32 bytes)');
  return key;
}

function encrypt(plain: string, hexKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(hexKey), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.') + '\n';
}

function decrypt(blob: string, hexKey: string): string {
  const [iv, tag, data] = blob.trim().split('.').map(part => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(hexKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
