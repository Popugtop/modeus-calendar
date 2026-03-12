import 'dotenv/config';
import { ModeusAuthService } from './auth/ModeusAuthService';
import { ModeusService } from './api/ModeusService';

/**
 * Загружаем переменные окружения и проверяем их наличие.
 * Все секреты должны лежать в .env (не коммитьте его!).
 */
function loadEnv(): { username: string; password: string } {
  const username = process.env['MODEUS_USERNAME'];
  const password = process.env['MODEUS_PASSWORD'];

  if (!username || !password) {
    throw new Error(
      'Укажите MODEUS_USERNAME и MODEUS_PASSWORD в файле .env\n' +
        'Пример: cp .env.example .env',
    );
  }

  return { username, password };
}

async function main(): Promise<void> {
  // ── 1. Инициализация ───────────────────────────────────────────────────────
  const { username, password } = loadEnv();

  const authService = new ModeusAuthService(username, password);
  const modeusService = new ModeusService(authService);

  // ── 2. Авторизация ─────────────────────────────────────────────────────────
  // Весь SSO-флоу: GET → парсинг hidden fields → POST creds → обработка SAML → токен
  console.log('Авторизация...');
  await authService.login();
  console.log(`Токен получен: ${authService.bearerToken?.slice(0, 30)}...`);

  // ── 3. Оценки текущего студента ─────────────────────────────────────────────
  console.log('\n── Успеваемость ──────────────────────────────────────────────');
  try {
    const performance = await modeusService.getMyPerformance();
    if (performance.data.length === 0) {
      console.log('Оценок пока нет.');
    } else {
      for (const grade of performance.data) {
        const mark = grade.gradeValue ?? '—';
        const passed = grade.passed === undefined ? '' : grade.passed ? ' ✓' : ' ✗';
        console.log(`  ${grade.moduleName}: ${mark}${passed}`);
      }
    }
  } catch (err) {
    console.error('Ошибка при получении оценок:', (err as Error).message);
  }

  // ── 4. Расписание на текущую неделю ────────────────────────────────────────
  // UUID студента можно получить из профиля или из JWT-payload.
  // Здесь используем заглушку — замените на реальный UUID.
  const MY_PERSON_ID = process.env['MODEUS_PERSON_ID'] ?? 'YOUR-UUID-HERE';

  if (MY_PERSON_ID !== 'YOUR-UUID-HERE') {
    console.log('\n── Расписание (текущая неделя) ───────────────────────────────');
    try {
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay() + 1); // Понедельник
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6); // Воскресенье

      const schedule = await modeusService.getSchedule({
        size: 50,
        timeMin: weekStart.toISOString(),
        timeMax: weekEnd.toISOString(),
        attendeePersonId: [MY_PERSON_ID],
      });

      const events = Object.values(schedule.data.events);
      console.log(`Найдено занятий: ${events.length}`);
      for (const ev of events) {
        const start = new Date(ev.startDateLocal).toLocaleString('ru-RU');
        console.log(`  [${start}] ${ev.name}`);
      }
    } catch (err) {
      console.error('Ошибка при получении расписания:', (err as Error).message);
    }
  } else {
    console.log('\n[Расписание пропущено] Укажите MODEUS_PERSON_ID в .env');
  }

  // ── 5. Активные кампании выбора элективов ──────────────────────────────────
  console.log('\n── Активные кампании выбора ──────────────────────────────────');
  try {
    const selections = await modeusService.getActiveSelections();
    if (selections.data.length === 0) {
      console.log('Активных кампаний нет.');
    } else {
      for (const sel of selections.data) {
        console.log(`  [${sel.id}] ${sel.name} (статус: ${sel.status ?? '?'})`);

        // Показываем доступные модули для первой кампании
        const modules = await modeusService.getSelectionModules(sel.id);
        for (const mod of modules.data) {
          const free = mod.capacity - mod.enrolledCount;
          const selected = mod.selected ? ' [выбран]' : '';
          console.log(
            `    • ${mod.name} | мест: ${free}/${mod.capacity}${selected}`,
          );
        }

        // Пример: записаться на первый модуль с местами (закомментировано)
        // const available = modules.data.find(m => m.enrolledCount < m.capacity && !m.selected);
        // if (available) {
        //   const result = await modeusService.applyForModule(sel.id, available.id);
        //   console.log('Записан на:', available.name, result);
        // }

        break; // Показываем только первую кампанию
      }
    }
  } catch (err) {
    console.error('Ошибка при получении кампаний:', (err as Error).message);
  }

  console.log('\nГотово.');
}

main().catch((err: unknown) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
