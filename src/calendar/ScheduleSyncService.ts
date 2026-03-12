import { createHash } from 'crypto';
import cron from 'node-cron';
import type { ModeusService } from '../api/ModeusService';
import type { EnrichedEvent } from './types';
import type { CalendarRepository } from './CalendarRepository';
import type { Subscription } from './types';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SyncConfig {
  /** node-cron expression. Default: every 3 hours */
  cronSchedule: string;
  /** How many weeks ahead to fetch. Default: 4 */
  weeksAhead: number;
}

const DEFAULTS: SyncConfig = {
  cronSchedule: process.env['CRON_SCHEDULE'] ?? '0 */3 * * *',
  weeksAhead:   parseInt(process.env['SYNC_WEEKS_AHEAD'] ?? '4', 10),
};

// ─── Service ──────────────────────────────────────────────────────────────────

export class ScheduleSyncService {
  private task: ReturnType<typeof cron.schedule> | null = null;
  private readonly config: SyncConfig;

  constructor(
    private readonly modeus: ModeusService,
    private readonly repo: CalendarRepository,
    config: Partial<SyncConfig> = {},
  ) {
    this.config = { ...DEFAULTS, ...config };
  }

  start(): void {
    if (this.task) return;

    console.log(`[Sync] Cron запущен: "${this.config.cronSchedule}"`);

    this.task = cron.schedule(this.config.cronSchedule, () => {
      void this.syncAll();
    });

    // Initial sync on startup
    void this.syncAll();
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  async syncAll(): Promise<void> {
    const subs = this.repo.getAllSubscriptions();
    if (subs.length === 0) {
      console.log('[Sync] Нет подписок для синхронизации.');
      return;
    }

    console.log(`[Sync] Синхронизируем ${subs.length} подписок...`);

    for (const sub of subs) {
      await this.syncOne(sub);
    }
  }

  async syncOne(sub: Subscription): Promise<void> {
    const label = `[Sync:${sub.fio}]`;
    try {
      const enriched = await this.fetchEnrichedEvents(sub.modeusPersonId);

      if (enriched.length > 0) {
        const withRoom    = enriched.filter(e => e.location?._embedded?.rooms?.length).length;
        const withCustom  = enriched.filter(e => e.location?.customLocation).length;
        const noLocation  = enriched.length - withRoom - withCustom;
        console.log(
          `${label} ${enriched.length} событий: ` +
          `${withRoom} с аудиторией, ${withCustom} с customLocation, ${noLocation} без места.`,
        );
      }

      const hash    = computeHash(enriched);
      const updated = this.repo.saveScheduleCache(sub.id, enriched, hash);

      if (updated) {
        console.log(`${label} Кэш обновлён.`);
      } else {
        console.log(`${label} Без изменений.`);
      }
    } catch (err: unknown) {
      console.error(`${label} Ошибка синхронизации:`, err);
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async fetchEnrichedEvents(
    modeusPersonId: string,
  ): Promise<EnrichedEvent[]> {
    const now = new Date();

    // timeMin = start of current day (UTC midnight)
    const timeMin = new Date(now);
    timeMin.setUTCHours(0, 0, 0, 0);

    // timeMax = timeMin + N weeks
    const timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + this.config.weeksAhead * 7);

    const schedule = await this.modeus.getSchedule({
      size:               500,
      timeMin:            timeMin.toISOString(),
      timeMax:            timeMax.toISOString(),
      attendeePersonId:   [modeusPersonId],
    });

    const emb = schedule._embedded;

    const events = (emb?.events ?? []).sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );

    // ── Build course-unit-realization ID → name map ──────────────────────────
    const courseMap = new Map<string, string>();
    for (const cur of emb?.['course-unit-realizations'] ?? []) {
      courseMap.set(cur.id, cur.nameShort || cur.name || '');
    }

    // ── Build rooms map: roomId → { name, building } ─────────────────────────
    const roomMap = new Map<string, { id: string; name: string; building?: { id: string; name: string } }>();
    for (const room of emb?.rooms ?? []) {
      roomMap.set(room.id, {
        id:       room.id,
        name:     room.name,
        building: room.building ? { id: room.building.id, name: room.building.name } : undefined,
      });
    }

    // ── Build event-rooms map: eventId → roomId ───────────────────────────────
    // event-rooms join entries link event UUIDs to room UUIDs.
    const eventRoomMap = new Map<string, string>(); // eventId → roomId
    for (const er of emb?.['event-rooms'] ?? []) {
      const eventId = er._links?.event?.href?.split('/').pop();
      const roomId  = er._links?.room?.href?.split('/').pop();
      if (eventId && roomId) eventRoomMap.set(eventId, roomId);
    }

    // ── Build location map: eventId → EventLocation ──────────────────────────
    const locationMap = new Map<string, EnrichedEvent['location']>();
    for (const loc of emb?.['event-locations'] ?? []) {
      const evId = loc.eventId;
      if (!evId) continue;

      const customLocation = loc.customLocation ?? undefined;

      // Primary: room from event-rooms join; secondary: event-rooms link on location
      let rooms: Array<{ id: string; name: string; building?: { id: string; name: string } }> | undefined;

      const roomId = eventRoomMap.get(evId)
        ?? (() => {
          const href = (loc._links?.['event-rooms'] as { href?: string } | undefined)?.href;
          if (!href) return undefined;
          // href points to the event-room join entry, not the room directly.
          // We already built eventRoomMap from event-rooms entries above.
          // If it's not there, skip (shouldn't happen with a well-formed response).
          return undefined;
        })();

      if (roomId) {
        const room = roomMap.get(roomId);
        if (room) rooms = [room];
      }

      locationMap.set(evId, {
        customLocation,
        _embedded: rooms ? { rooms } : undefined,
      });
    }

    // ── Build persons map: personId → fullName ───────────────────────────────
    const personMap = new Map<string, string>();
    for (const p of emb?.persons ?? []) {
      personMap.set(p.id, p.fullName);
    }

    // ── Build attendees map: eventId → [{roleId, fullName}] ─────────────────
    const attendeesMap = new Map<string, Array<{ roleId: string; fullName: string }>>();
    for (const ea of emb?.['event-attendees'] ?? []) {
      const eventId  = ea._links?.event?.href?.split('/').pop();
      const personId = ea._links?.person?.href?.split('/').pop();
      const roleId   = ea.roleId;
      if (!eventId || !roleId) continue;

      const fullName = personId ? (personMap.get(personId) ?? '') : '';
      if (!attendeesMap.has(eventId)) attendeesMap.set(eventId, []);
      attendeesMap.get(eventId)!.push({ roleId, fullName });
    }

    // ── Assemble enriched events ──────────────────────────────────────────────
    const enriched: EnrichedEvent[] = events.map(ev => {
      // Resolve course name from _links → course-unit-realization href
      let courseName: string | null = null;
      const curHref = ev._links?.['course-unit-realization']?.href;
      if (curHref) {
        const curId = curHref.split('/').pop();
        if (curId) courseName = courseMap.get(curId) ?? null;
      }

      return {
        event: {
          id:            ev.id,
          name:          ev.name,
          typeId:        ev.typeId,
          startsAtLocal: ev.startsAtLocal,
          endsAtLocal:   ev.endsAtLocal,
        },
        courseName,
        sequence:     0,
        lastModified: new Date().toISOString(),
        location:     locationMap.get(ev.id) ?? {},
        attendees:    attendeesMap.get(ev.id) ?? [],
      };
    });

    // ── Per-event sequence tracking ──────────────────────────────────────────
    const seqInput = enriched.map(e => ({
      eventId: e.event.id,
      hash: createHash('sha256')
        .update(JSON.stringify({ event: e.event, courseName: e.courseName, location: e.location, attendees: e.attendees }))
        .digest('hex'),
    }));

    const seqMap = this.repo.updateEventSequences(seqInput);

    for (const e of enriched) {
      const s = seqMap.get(e.event.id);
      if (s) {
        e.sequence     = s.sequence;
        e.lastModified = s.updatedAt;
      }
    }

    return enriched;
  }
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

function computeHash(events: EnrichedEvent[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}
