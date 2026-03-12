import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

interface SubscriptionRow {
  id: number;
  fio: string;
  modeus_person_id: string;
  calendar_token: string;
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
    `);
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
  ): { items: { fio: string; createdAt: string }[]; total: number } {
    const total =
      this.db
        .prepare<[], { count: number }>(`SELECT COUNT(*) as count FROM subscriptions`)
        .get()?.count ?? 0;
    const items = this.db
      .prepare<[number, number], SubscriptionRow>(
        `SELECT fio, created_at FROM subscriptions ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(pageSize, page * pageSize)
      .map(r => ({ fio: r.fio, createdAt: r.created_at }));
    return { items, total };
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
