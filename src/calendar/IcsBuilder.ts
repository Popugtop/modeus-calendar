import ical, { ICalCalendarMethod } from 'ical-generator';
import type { EnrichedEvent, Subscription } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEZONE = 'Asia/Yekaterinburg'; // Tyumen = UTC+5, permanent (no DST since 2014)
const TZ_OFFSET = '+05:00';
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
    const { event, location, attendees } = enriched;

    // ── Dates (startsAtLocal is already in Yekaterinburg time, no TZ suffix) ──
    const start = new Date(event.startsAtLocal + TZ_OFFSET);
    const end   = new Date(event.endsAtLocal   + TZ_OFFSET);

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
    // Matches Modeus original format:
    //   "Лекционное занятие\n\nПреподаватель: Иванов И.И.\n\nПосмотреть в ...\n"
    const deepLink = buildDeepLink(event.id, event.startsAtLocal);
    const description = [
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

    // ── Subject code (second CATEGORIES line, extracted from event name) ──────
    // Event name format: "Курс / Тема занятия / КС Л-06"
    // Subject code is the last "/" segment with group code stripped.
    const subjectCode = extractSubjectCode(event.name);

    // ── Build event ───────────────────────────────────────────────────────────
    const calEvent = cal.createEvent({
      // UID = Modeus event UUID → consistent across refreshes, no duplicates
      id:          event.id,
      start,
      end,
      summary:     event.name,
      description,
      location:    locationStr || undefined,
      organizer:   { name: 'Modeus', email: 'noreply@modeus.org' },
      sequence:    0,
      categories:  buildCategories(typeName, subjectCode),
    });

    // Apply TZID so output is DTSTART;TZID=Asia/Yekaterinburg:...
    calEvent.timezone(TIMEZONE);
  }

  return cal.toString();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
