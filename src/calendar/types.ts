import type { EventAttendee, EventLocation, ScheduleEvent } from '../types';

// ─── DB models ───────────────────────────────────────────────────────────────

export interface Subscription {
  id: number;
  fio: string;
  modeusPersonId: string;
  calendarToken: string;
  createdAt: string;
}

// ─── Enriched event (event + location + attendees) ───────────────────────────

export interface EnrichedEvent {
  event: Pick<ScheduleEvent, 'id' | 'name' | 'typeId' | 'startsAtLocal' | 'endsAtLocal'>;
  location: EventLocation;
  attendees: Pick<EventAttendee, 'roleId' | 'fullName'>[];
}
