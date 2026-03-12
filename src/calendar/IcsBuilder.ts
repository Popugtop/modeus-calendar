import ical, { ICalCalendarMethod } from 'ical-generator';
import type { EnrichedEvent, Subscription } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEZONE = 'Asia/Yekaterinburg'; // Tyumen = UTC+5, permanent (no DST since 2014)
const MODEUS_ORIGIN = 'https://utmn.modeus.org';

const TYPE_NAMES: Record<string, string> = {
  LECT:      'Лекционное занятие',
  SEMI:      'Практическое занятие',
  LAB:       'Лабораторное занятие',
  CUR_CHECK: 'Текущий контроль',
  CONS:      'Консультация',
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Builds an ICS string from cached enriched events.
 * UIDs are based on the Modeus event UUID — Apple Calendar won't create
 * duplicates when the subscription is refreshed.
 */
export function buildIcs(
  subscription: Subscription,
  events: EnrichedEvent[],
): string {
  const cal = ical({
    name:   `Расписание ${subscription.fio}`,
    method: ICalCalendarMethod.PUBLISH,
    prodId: { company: 'ModeusCalBot', product: 'ModeusCalendar', language: 'RU' },
    timezone: TIMEZONE,
  });

  for (const enriched of events) {
    const { event, courseName, sequence, lastModified, location, attendees } = enriched;

    // ── Dates (startsAtLocal is already in Yekaterinburg time, no TZ suffix) ──
    const start = parseLocalDt(event.startsAtLocal);
    const end   = parseLocalDt(event.endsAtLocal);

    // ── Location ──────────────────────────────────────────────────────────────
    // ICS format: "Главный корпус / 210"  (building first, then room number)
    // The CLI displays it the other way — "210, Главный корпус" — so we reverse.
    let locationStr = '';
    if (location._embedded?.rooms?.[0]) {
      const r = location._embedded.rooms[0];
      locationStr = r.building ? `${r.building.name} / ${r.name}` : r.name;
    } else if (location.customLocation) {
      locationStr = location.customLocation;
    }

    // ── Attendees → teachers ──────────────────────────────────────────────────
    const teachers = attendees
      .filter(a => a.roleId === 'TEACH')
      .map(a => a.fullName)
      .join(', ');

    // ── Type name ─────────────────────────────────────────────────────────────
    const typeName = TYPE_NAMES[event.typeId ?? ''] ?? event.typeId ?? 'Занятие';

    // ── Description ───────────────────────────────────────────────────────────
    const timeRange  = `${fmtTime(event.startsAtLocal)}–${fmtTime(event.endsAtLocal)}`;
    const deepLink   = buildDeepLink(event.id, event.startsAtLocal);
    const description = [
      timeRange,
      '',
      courseName ? `Предмет: ${courseName}` : '',
      typeName,
      '',
      teachers ? `Преподаватель: ${teachers}` : '',
      '',
      `Посмотреть в Моем расписании: ${deepLink.web}`,
      `Посмотреть в мобильной версии: ${deepLink.mobile}`,
      '',
    ]
      .join('\n')
      .replace(/\n{3,}/g, '\n\n') // collapse repeated blank lines
      .trimEnd();

    // ── Subject code — use courseName if available, else extract from name ───
    const subjectCode = courseName ?? extractSubjectCode(event.name);

    // ── Build event ───────────────────────────────────────────────────────────
    // start/end are bare local datetime strings (no TZ suffix).
    // ical-generator parses them with new Date() on a UTC server → local getters
    // equal UTC getters.  calEvent.timezone() then sets TZID and tells the
    // formatter to use local (not UTC) getters, so:
    //   "2026-03-10T08:30:00" → DTSTART;TZID=Asia/Yekaterinburg:20260310T083000
    const calEvent = cal.createEvent({
      id:          event.id,
      start,
      end,
      summary:     formatSummary(event.name, courseName),
      description,
      location:    locationStr || undefined,
      organizer:   { name: 'Modeus', email: 'noreply@modeus.org' },
      sequence,
      categories:  buildCategories(typeName, subjectCode),
    });

    calEvent.timezone(TIMEZONE);
    calEvent.lastModified(new Date(lastModified));
  }

  return cal.toString();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the local datetime string as-is (no TZ suffix).
 * ical-generator parses it with new Date() on a UTC server → local === UTC,
 * so .getHours() yields the Tyumen local hour.  calEvent.timezone() then
 * wraps the output as DTSTART;TZID=Asia/Yekaterinburg:20260310T083000.
 */
function parseLocalDt(localStr: string): string {
  return localStr;
}

/** Extracts "HH:MM" from "2026-03-10T08:30:00" */
function fmtTime(localDt: string): string {
  return localDt.slice(11, 16);
}

/**
 * Formats event summary.
 * If courseName is available, uses "CourseName | TopicName".
 * Otherwise falls back to splitting the event name by "/".
 */
function formatSummary(name: string, courseName: string | null): string {
  if (courseName) {
    return `${courseName} | ${name}`;
  }
  // Fallback: split "Course / Topic / Code" → "Course | Topic"
  const segments = name.split('/').map(s => s.trim()).filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[0]} | ${segments[1]}`;
  }
  return name;
}

/**
 * Builds deep-link URLs for the event, matching the Modeus ICS format:
 *   https://utmn.modeus.org/schedule-calendar/my?selectedEvent=...
 */
function buildDeepLink(
  eventId: string,
  startsAtLocal: string,
): { web: string; mobile: string } {
  const eventParam = JSON.stringify({ eventId });
  const calParam   = JSON.stringify({
    view: 'agendaWeek',
    date: `${startsAtLocal}.000Z`,
  });

  // Fully percent-encode both params. ical-generator will handle ICS text
  // escaping of any special characters inside the DESCRIPTION property.
  const eventEnc = encodeURIComponent(eventParam);
  const calEnc   = encodeURIComponent(calParam);

  const baseWeb    = `${MODEUS_ORIGIN}/schedule-calendar/my`;
  const baseMobile = `${MODEUS_ORIGIN}/schedule-calendar/mobile`;

  const qs = `selectedEvent=${eventEnc}&calendar=${calEnc}`;

  return {
    web:    `${baseWeb}?${qs}`,
    mobile: `${baseMobile}?${qs}`,
  };
}

/**
 * Extracts the subject abbreviation from the last "/" segment of the event name.
 *
 * "Дискретная математика 1 / Контрольная работа / ДМ 1 ЛБ-04"
 *   → last segment "ДМ 1 ЛБ-04"
 *   → strip group code "ЛБ-04" → "ДМ 1"
 *
 * Group code pattern: 1–4 uppercase Cyrillic/Latin letters + hyphen + digits
 */
function extractSubjectCode(evName: string): string | null {
  const segments = evName.split('/');
  const last = segments[segments.length - 1]?.trim();
  if (!last) return null;

  // Strip trailing group code like "Л-06", "ЛБ-04", "П-02", "СМ-01"
  const code = last
    .replace(/\s+[А-ЯЁA-Z]{1,4}-\d+$/u, '')
    .trim();

  return code || null;
}

function buildCategories(
  typeName: string,
  subjectCode: string | null,
): { name: string }[] {
  const cats: { name: string }[] = [{ name: typeName }];
  if (subjectCode) cats.push({ name: subjectCode });
  return cats;
}
