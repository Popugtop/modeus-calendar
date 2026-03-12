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
        console.log(
          `${label} Примеры event.name: ` +
          enriched.slice(0, 3).map(e => JSON.stringify(e.event.name)).join(', '),
        );
      }

      const hash    = computeHash(enriched);
      const updated = this.repo.saveScheduleCache(sub.id, enriched, hash);

      if (updated) {
        console.log(`${label} Кэш обновлён (${enriched.length} событий).`);
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

    const events = (schedule._embedded?.events ?? []).sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );

    // Build course-unit-realization ID → name map from the embedded data
    const courseMap = new Map<string, string>();
    const curs = schedule._embedded?.['course-unit-realizations'] ?? [];
    for (const cur of curs) {
      courseMap.set(cur.id, cur.nameShort || cur.name || '');
    }

    // Fetch location + attendees in parallel for all events
    const enriched = await Promise.all(
      events.map(async (ev): Promise<EnrichedEvent> => {
        const [location, attendees] = await Promise.all([
          this.modeus.getEventLocation(ev.id).catch(() => ({})),
          this.modeus.getEventAttendees(ev.id).catch(() => []),
        ]);

        // Resolve course name from _links → course-unit-realization href
        let courseName: string | null = null;
        const curHref = ev._links?.['course-unit-realization']?.href;
        if (curHref) {
          // href like "/schedule-calendar-v2/api/calendar/course-unit-realizations/UUID"
          const curId = curHref.split('/').pop();
          if (curId) courseName = courseMap.get(curId) ?? null;
        }

        return {
          event: {
            id:           ev.id,
            name:         ev.name,
            typeId:       ev.typeId,
            startsAtLocal: ev.startsAtLocal,
            endsAtLocal:   ev.endsAtLocal,
          },
          courseName,
          location:  location  as EnrichedEvent['location'],
          attendees: (attendees as EnrichedEvent['attendees']),
        };
      }),
    );

    return enriched;
  }
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

function computeHash(events: EnrichedEvent[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}
