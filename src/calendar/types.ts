import type { EventAttendee, EventLocation, ScheduleEvent } from '../types';

// ─── DB models ───────────────────────────────────────────────────────────────

export interface Subscription {
  id: number;
  fio: string;
  modeusPersonId: string;
  calendarToken: string;
  telegramId: string | null;
  createdAt: string;
}

// ─── Enriched event (event + location + attendees) ───────────────────────────

export interface EnrichedEvent {
  event: Pick<ScheduleEvent, 'id' | 'name' | 'typeId' | 'startsAtLocal' | 'endsAtLocal'>;
  courseName: string | null;
  /** iCalendar SEQUENCE — increments on every detected change to this event */
  sequence: number;
  /** ISO timestamp of last detected change (used for LAST-MODIFIED in ICS) */
  lastModified: string;
  location: EventLocation;
  attendees: Pick<EventAttendee, 'roleId' | 'fullName'>[];
}
