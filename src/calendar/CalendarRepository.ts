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

    return JSON.parse(row.events_json) as EnrichedEvent[];
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
