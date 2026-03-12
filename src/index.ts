import 'dotenv/config';
import * as readline from 'readline';
import { ModeusAuthService } from './auth/ModeusAuthService';
import { ModeusService } from './api/ModeusService';
import { loadTokens, saveTokens } from './auth/tokenCache';
import type { EventAttendee, EventLocation, Person, StudentInfo } from './types';

const TYPE_NAMES: Record<string, string> = {
  LECT:      'Лекционное занятие',
  SEMI:      'Практическое занятие',
  LAB:       'Лабораторное занятие',
  CUR_CHECK: 'Текущий контроль',
  CONS:      'Консультация',
};

const TYPE_ICONS: Record<string, string> = {
  LECT:      '✍️',
  SEMI:      '🧪',
  LAB:       '🔬',
  CUR_CHECK: '📝',
  CONS:      '💬',
};

const DAY_NAMES = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));

// ─── Поиск человека ──────────────────────────────────────────────────────────

async function selectPerson(modeus: ModeusService): Promise<Person> {
  while (true) {
    const query = await ask('Введите ФИО или фамилию: ');
    if (!query.trim()) continue;

    const { persons, students } = await modeus.searchPersons(query.trim());

    if (persons.length === 0) {
      console.log('Никого не найдено, попробуйте ещё раз.\n');
      continue;
    }

    // Строим Map personId → StudentInfo для быстрого доступа
    const studentMap = new Map<string, StudentInfo>(students.map(s => [s.personId, s]));

    console.log('\nВыберите, расписание какого человека вы хотите посмотреть:');
    persons.forEach((p, i) => {
      const s = studentMap.get(p.id);
      const direction = s
        ? `${s.specialtyName ?? ''}${s.specialtyProfile ? ' — ' + s.specialtyProfile : ''}`
        : 'преподаватель / сотрудник';
      console.log(`${i + 1}. ${p.fullName}`);
      console.log(`   ${direction}\n`);
    });

    if (persons.length === 1) {
      console.log(`Найден один человек: ${persons[0].fullName}`);
      return persons[0];
    }

    const choice = await ask(`Введите номер (0 — новый поиск, 1–${persons.length}): `);
    const idx = parseInt(choice.trim(), 10);
    if (idx === 0) { console.log(); continue; }
    if (idx >= 1 && idx <= persons.length) return persons[idx - 1];
    console.log('Неверный номер, попробуйте ещё раз.\n');
  }
}

// ─── Вывод расписания ─────────────────────────────────────────────────────────

async function printSchedule(modeus: ModeusService, personId: string): Promise<void> {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const fmt  = (d: string) => d.slice(8, 10) + '.' + d.slice(5, 7);
  const hhmm = (dt: string) => dt.slice(11, 16);

  const schedule = await modeus.getSchedule({
    size: 500,
    timeMin: weekStart.toISOString(),
    timeMax: weekEnd.toISOString(),
    attendeePersonId: [personId],
  });

  const events = (schedule._embedded?.events ?? [])
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  // Загружаем детали параллельно
  const details = await Promise.all(
    events.map(async ev => {
      const [location, attendees] = await Promise.all([
        modeus.getEventLocation(ev.id).catch(() => ({})),
        modeus.getEventAttendees(ev.id).catch(() => []),
      ]);
      return { ev, location, attendees };
    }),
  );

  console.log(`\nРасписание на ${fmt(weekStart.toISOString())} - ${fmt(weekEnd.toISOString())}:\n`);

  for (let i = 0; i < 7; i++) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + i);
    const dayStr   = day.toISOString().slice(0, 10);
    const dayLabel = `${DAY_NAMES[day.getDay()]} ${fmt(dayStr)}:`;

    const dayDetails = details.filter(({ ev }) => ev.startsAtLocal.startsWith(dayStr));

    console.log(dayLabel);

    if (dayDetails.length === 0) {
      console.log('Занятий нет\n');
      continue;
    }

    for (const { ev, location, attendees } of dayDetails) {
      const typeName = TYPE_NAMES[ev.typeId ?? ''] ?? ev.typeId ?? '—';
      const typeIcon = TYPE_ICONS[ev.typeId ?? ''] ?? '📖';

      const loc = location as EventLocation;
      let roomStr = '—';
      if (loc._embedded?.rooms?.[0]) {
        const r = loc._embedded.rooms[0];
        roomStr = r.building ? `${r.name}, ${r.building.name}` : r.name;
      } else if (loc.customLocation) {
        roomStr = loc.customLocation;
      }

      const teachers = (attendees as EventAttendee[])
        .filter(a => a.roleId === 'TEACH')
        .map(a => a.fullName)
        .join(', ') || '—';

      console.log(`⏰ ${hhmm(ev.startsAtLocal)} - ${hhmm(ev.endsAtLocal)}`);
      console.log(`📚 ${ev.name}`);
      console.log(`${typeIcon} ${typeName}`);
      console.log(`🏫 ${roomStr}`);
      console.log(`👨‍🏫 ${teachers}`);
      console.log();
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const username = process.env['MODEUS_USERNAME'];
  const password = process.env['MODEUS_PASSWORD'];
  if (!username || !password) throw new Error('Укажите MODEUS_USERNAME и MODEUS_PASSWORD в .env');

  const cached = loadTokens();
  let auth: ModeusAuthService;
  if (cached) {
    auth = new ModeusAuthService(username, password, cached.jar);
    auth.idToken     = cached.cache.idToken;
    auth.bearerToken = cached.cache.bearerToken;
  } else {
    auth = new ModeusAuthService(username, password);
    await auth.login();
    await saveTokens(auth.idToken!, auth.bearerToken!, auth.cookieJar);
  }

  const modeus = new ModeusService(auth);

  const person = await selectPerson(modeus);
  rl.close();

  await printSchedule(modeus, person.id);
}

main().catch((err: unknown) => {
  rl.close();
  console.error('Ошибка:', err);
  process.exit(1);
});
