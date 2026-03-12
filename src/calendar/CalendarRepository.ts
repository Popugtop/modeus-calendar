import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import type { EnrichedEvent, Subscription } from './types';

// ─── Raw DB row shapes ────────────────────────────────────────────────────────

interface SubscriptionRow {
  id: number;
  fio: string;
  modeus_person_id: string;
  calendar_token: string;
  created_at: string;
}

interface CacheRow {
  id: number;
  subscription_id: number;
  events_json: string;
  schedule_hash: string;
  updated_at: string;
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

// ─── Repository ───────────────────────────────────────────────────────────────

export class CalendarRepository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        fio              TEXT    NOT NULL,
        modeus_person_id TEXT    NOT NULL UNIQUE,
        calendar_token   TEXT    NOT NULL UNIQUE,
        created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS schedule_cache (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        events_json     TEXT    NOT NULL,
        schedule_hash   TEXT    NOT NULL,
        updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(subscription_id)
      );

      CREATE TABLE IF NOT EXISTS invite_codes (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        code             TEXT    NOT NULL UNIQUE,
        used             INTEGER NOT NULL DEFAULT 0,
        used_by_fio      TEXT,
        created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        used_at          TEXT
      );

      CREATE TABLE IF NOT EXISTS event_sequences (
        event_id    TEXT    PRIMARY KEY,
        sequence    INTEGER NOT NULL DEFAULT 0,
        event_hash  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // ─── Subscriptions ──────────────────────────────────────────────────────────

  createSubscription(fio: string, modeusPersonId: string): Subscription {
    const existing = this.findSubscriptionByPersonId(modeusPersonId);
    if (existing) return existing;

    const token = randomBytes(24).toString('hex');

    this.db
      .prepare(
        `INSERT INTO subscriptions (fio, modeus_person_id, calendar_token)
         VALUES (@fio, @modeusPersonId, @token)`,
      )
      .run({ fio, modeusPersonId, token });

    return this.findSubscriptionByToken(token)!;
  }

  findSubscriptionByToken(token: string): Subscription | null {
    const row = this.db
      .prepare<[string], SubscriptionRow>(
        `SELECT * FROM subscriptions WHERE calendar_token = ?`,
      )
      .get(token);

    return row ? mapRow(row) : null;
  }

  findSubscriptionByPersonId(modeusPersonId: string): Subscription | null {
    const row = this.db
      .prepare<[string], SubscriptionRow>(
        `SELECT * FROM subscriptions WHERE modeus_person_id = ?`,
      )
      .get(modeusPersonId);

    return row ? mapRow(row) : null;
  }

  getAllSubscriptions(): Subscription[] {
    const rows = this.db
      .prepare<[], SubscriptionRow>(`SELECT * FROM subscriptions`)
      .all();

    return rows.map(mapRow);
  }

  // ─── Schedule cache ─────────────────────────────────────────────────────────

  /**
   * Upsert enriched events for a subscription.
   * @returns true if cache was updated (hash changed), false if identical
   */
  saveScheduleCache(
    subscriptionId: number,
    events: EnrichedEvent[],
    hash: string,
  ): boolean {
    const existing = this.db
      .prepare<[number], Pick<CacheRow, 'schedule_hash'>>(
        `SELECT schedule_hash FROM schedule_cache WHERE subscription_id = ?`,
      )
      .get(subscriptionId);

    if (existing?.schedule_hash === hash) return false;

    const json = JSON.stringify(events);

    this.db
      .prepare(
        `INSERT INTO schedule_cache (subscription_id, events_json, schedule_hash, updated_at)
         VALUES (@subscriptionId, @json, @hash, datetime('now'))
         ON CONFLICT(subscription_id) DO UPDATE
           SET events_json  = excluded.events_json,
               schedule_hash = excluded.schedule_hash,
               updated_at    = excluded.updated_at`,
      )
      .run({ subscriptionId, json, hash });

    return true;
  }

  getScheduleCache(subscriptionId: number): EnrichedEvent[] | null {
    const row = this.db
      .prepare<[number], Pick<CacheRow, 'events_json'>>(
        `SELECT events_json FROM schedule_cache WHERE subscription_id = ?`,
      )
      .get(subscriptionId);

    if (!row) return null;

    try {
      return JSON.parse(row.events_json) as EnrichedEvent[];
    } catch {
      console.error(`[CalendarRepository] Corrupt cache for subscription ${subscriptionId}, clearing.`);
      this.db.prepare(`DELETE FROM schedule_cache WHERE subscription_id = ?`).run(subscriptionId);
      return null;
    }
  }

  // ─── Event sequences ─────────────────────────────────────────────────────────

  /**
   * For each event, checks if its content hash has changed.
   * If changed (or new): increments sequence and records updated_at.
   * Returns a map of eventId → { sequence, updatedAt }.
   */
  updateEventSequences(
    events: Array<{ eventId: string; hash: string }>,
  ): Map<string, { sequence: number; updatedAt: string }> {
    interface SeqRow { sequence: number; event_hash: string; updated_at: string }

    const result = new Map<string, { sequence: number; updatedAt: string }>();

    const select = this.db.prepare<[string], SeqRow>(
      `SELECT sequence, event_hash, updated_at FROM event_sequences WHERE event_id = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO event_sequences (event_id, sequence, event_hash, updated_at)
       VALUES (?, 0, ?, datetime('now'))`,
    );
    const update = this.db.prepare(
      `UPDATE event_sequences
       SET sequence = sequence + 1, event_hash = ?, updated_at = datetime('now')
       WHERE event_id = ?`,
    );

    const process = this.db.transaction(() => {
      for (const { eventId, hash } of events) {
        const existing = select.get(eventId);

        if (!existing) {
          insert.run(eventId, hash);
          result.set(eventId, { sequence: 0, updatedAt: new Date().toISOString() });
        } else if (existing.event_hash !== hash) {
          update.run(hash, eventId);
          result.set(eventId, { sequence: existing.sequence + 1, updatedAt: new Date().toISOString() });
        } else {
          result.set(eventId, { sequence: existing.sequence, updatedAt: existing.updated_at });
        }
      }
    });

    process();
    return result;
  }

  // ─── Invite codes ───────────────────────────────────────────────────────────

  createInviteCode(): string {
    const code = randomBytes(4).toString('hex').toUpperCase();
    this.db.prepare(`INSERT INTO invite_codes (code) VALUES (?)`).run(code);
    return code;
  }

  isInviteCodeValid(code: string): boolean {
    const row = this.db.prepare<[string], { id: number }>(
      `SELECT id FROM invite_codes WHERE code = ? AND used = 0`,
    ).get(code);
    return !!row;
  }

  useInviteCode(code: string, usedByFio: string): void {
    this.db
      .prepare(
        `UPDATE invite_codes SET used = 1, used_by_fio = ?, used_at = datetime('now') WHERE code = ?`,
      )
      .run(usedByFio, code);
  }

  listInviteCodes(limit = 10, offset = 0): InviteCodeInfo[] {
    return this.db
      .prepare<[number, number], InviteCodeRow>(
        `SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset)
      .map(mapInviteRow);
  }

  countInviteCodes(): number {
    return (
      this.db
        .prepare<[], { count: number }>(`SELECT COUNT(*) as count FROM invite_codes`)
        .get()?.count ?? 0
    );
  }

  getStats(): {
    users: number;
    totalCodes: number;
    usedCodes: number;
    recentUsers: { fio: string; createdAt: string }[];
  } {
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
        `SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT 5`,
      )
      .all()
      .map(r => ({ fio: r.fio, createdAt: r.created_at }));
    return { users, totalCodes, usedCodes, recentUsers };
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    fio: row.fio,
    modeusPersonId: row.modeus_person_id,
    calendarToken: row.calendar_token,
    createdAt: row.created_at,
  };
}

function mapInviteRow(row: InviteCodeRow): InviteCodeInfo {
  return {
    code: row.code,
    used: row.used === 1,
    usedByFio: row.used_by_fio,
    createdAt: row.created_at,
    usedAt: row.used_at,
  };
}
