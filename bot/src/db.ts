import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

interface SubscriptionRow {
  id: number;
  fio: string;
  modeus_person_id: string;
  calendar_token: string;
  telegram_id: string | null;
  created_at: string;
}

interface InviteCodeRow {
  id: number;
  code: string;
  used: number;
  used_by_fio: string | null;
  created_at: string;
  used_at: string | null;
}

export interface InviteCodeInfo {
  code: string;
  used: boolean;
  usedByFio: string | null;
  createdAt: string;
  usedAt: string | null;
}

export interface StatsInfo {
  users: number;
  totalCodes: number;
  usedCodes: number;
  recentUsers: { fio: string; createdAt: string }[];
}

export class BotRepository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        code             TEXT    NOT NULL UNIQUE,
        used             INTEGER NOT NULL DEFAULT 0,
        used_by_fio      TEXT,
        created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        used_at          TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Migrate existing DBs
    try { this.db.exec(`ALTER TABLE subscriptions ADD COLUMN telegram_id TEXT`); } catch { /* already exists */ }
  }

  getSetting(key: string, defaultValue = ''): string {
    const row = this.db
      .prepare<[string], { value: string }>(`SELECT value FROM settings WHERE key = ?`)
      .get(key);
    return row?.value ?? defaultValue;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  createInviteCode(): string {
    const code = randomBytes(4).toString('hex').toUpperCase();
    this.db.prepare(`INSERT INTO invite_codes (code) VALUES (?)`).run(code);
    return code;
  }

  getStats(): StatsInfo {
    const users =
      this.db
        .prepare<[], { count: number }>(`SELECT COUNT(*) as count FROM subscriptions`)
        .get()?.count ?? 0;
    const totalCodes =
      this.db
        .prepare<[], { count: number }>(`SELECT COUNT(*) as count FROM invite_codes`)
        .get()?.count ?? 0;
    const usedCodes =
      this.db
        .prepare<[], { count: number }>(
          `SELECT COUNT(*) as count FROM invite_codes WHERE used = 1`,
        )
        .get()?.count ?? 0;
    const recentUsers = this.db
      .prepare<[], SubscriptionRow>(
        `SELECT fio, created_at FROM subscriptions ORDER BY created_at DESC LIMIT 5`,
      )
      .all()
      .map(r => ({ fio: r.fio, createdAt: r.created_at }));
    return { users, totalCodes, usedCodes, recentUsers };
  }

  listSubscriptions(
    page: number,
    pageSize: number,
  ): { items: { fio: string; createdAt: string; telegramId: string | null }[]; total: number } {
    const total =
      this.db
        .prepare<[], { count: number }>(`SELECT COUNT(*) as count FROM subscriptions`)
        .get()?.count ?? 0;
    const items = this.db
      .prepare<[number, number], SubscriptionRow>(
        `SELECT fio, created_at, telegram_id FROM subscriptions ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(pageSize, page * pageSize)
      .map(r => ({ fio: r.fio, createdAt: r.created_at, telegramId: r.telegram_id }));
    return { items, total };
  }

  findSubscriptionsByFio(
    query: string,
  ): { fio: string; calendarToken: string; modeusPersonId: string; telegramId: string | null }[] {
    return this.db
      .prepare<[string], SubscriptionRow>(
        `SELECT fio, calendar_token, modeus_person_id, telegram_id FROM subscriptions WHERE fio LIKE ? ORDER BY fio LIMIT 10`,
      )
      .all(`%${query}%`)
      .map(r => ({ fio: r.fio, calendarToken: r.calendar_token, modeusPersonId: r.modeus_person_id, telegramId: r.telegram_id }));
  }

  findByTelegramId(telegramId: string): { fio: string; calendarToken: string } | null {
    const row = this.db
      .prepare<[string], SubscriptionRow>(
        `SELECT fio, calendar_token FROM subscriptions WHERE telegram_id = ?`,
      )
      .get(telegramId);
    return row ? { fio: row.fio, calendarToken: row.calendar_token } : null;
  }

  linkTelegramId(modeusPersonId: string, telegramId: string): boolean {
    const result = this.db
      .prepare(`UPDATE subscriptions SET telegram_id = ? WHERE modeus_person_id = ?`)
      .run(telegramId, modeusPersonId);
    return result.changes > 0;
  }

  deleteSubscription(modeusPersonId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM subscriptions WHERE modeus_person_id = ?`)
      .run(modeusPersonId);
    return result.changes > 0;
  }

  deleteInviteCode(code: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM invite_codes WHERE code = ? AND used = 0`)
      .run(code);
    return result.changes > 0;
  }

  listInviteCodes(
    page: number,
    pageSize: number,
  ): { items: InviteCodeInfo[]; total: number } {
    const total =
      this.db
        .prepare<[], { count: number }>(`SELECT COUNT(*) as count FROM invite_codes`)
        .get()?.count ?? 0;
    const items = this.db
      .prepare<[number, number], InviteCodeRow>(
        `SELECT code, used, used_by_fio, created_at, used_at FROM invite_codes ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(pageSize, page * pageSize)
      .map(r => ({
        code:      r.code,
        used:      r.used === 1,
        usedByFio: r.used_by_fio,
        createdAt: r.created_at,
        usedAt:    r.used_at,
      }));
    return { items, total };
  }
}
