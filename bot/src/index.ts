import 'dotenv/config';
import { createReadStream } from 'fs';
import { Telegraf, Markup } from 'telegraf';
import cron from 'node-cron';
import { BotRepository } from './db';
import { BackupService } from './backup';

const BOT_TOKEN       = process.env['TELEGRAM_BOT_TOKEN'];
const ADMIN_ID        = parseInt(process.env['TELEGRAM_ADMIN_ID'] ?? '0', 10);
const BACKEND_URL     = process.env['BACKEND_URL'] ?? 'http://backend:3000';
const INTERNAL_SECRET = process.env['INTERNAL_SECRET'] ?? '';
const DB_PATH         = process.env['DB_PATH'] ?? '/app/data/calendar.db';

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_ID are required');
  process.exit(1);
}

const bot    = new Telegraf(BOT_TOKEN);
const repo   = new BotRepository(DB_PATH);
const backup = new BackupService(DB_PATH);

// ─── Start automatic backup schedule from saved setting ──────────────────────
const DEFAULT_BACKUP_CRON = '0 2 * * *';
backup.startSchedule(repo.getSetting('backup_cron', DEFAULT_BACKUP_CRON));

// ─── In-memory state for multi-step flows ────────────────────────────────────
const userState         = new Map<number, { action: string }>();
const pendingSelections = new Map<
  number,
  Array<{ id: string; name: string; specialty: string | null }>
>();

// ─── Admin-only middleware ────────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== ADMIN_ID) {
    await ctx.reply('⛔ Доступ запрещён.');
    return;
  }
  return next();
});

// ─── Keyboards ───────────────────────────────────────────────────────────────

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Статистика', 'stats')],
    [
      Markup.button.callback('🎟️ Создать инвайт-код', 'create_invite'),
      Markup.button.callback('➕ Добавить пользователя', 'add_user'),
    ],
    [
      Markup.button.callback('👥 Пользователи', 'users_p_0'),
      Markup.button.callback('🔑 Инвайт-коды', 'invites_p_0'),
    ],
    [Markup.button.callback('🔗 Найти ссылку', 'find_link')],
    [Markup.button.callback('📦 Бэкапы', 'backup_menu')],
  ]);
}

function backupMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💾 Создать и отправить бэкап', 'backup_create')],
    [Markup.button.callback('📋 Список бэкапов',            'backup_list_p_0')],
    [Markup.button.callback('♻️ Восстановить из бэкапа',    'backup_list_p_0_restore')],
    [Markup.button.callback('⏱️ Интервал автобэкапов',      'backup_int')],
    [Markup.button.callback('◀️ Назад',                     'back_main')],
  ]);
}

function intervalMenu(currentCron: string) {
  const label = (expr: string) => currentCron === expr ? '✅ ' : '';
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${label('0 2 * * *')}🌙 Каждый день в 2:00`,  'backup_int_daily')],
    [Markup.button.callback(`${label('0 */12 * * *')}🕛 Каждые 12 часов`, 'backup_int_12h')],
    [Markup.button.callback(`${label('0 */6 * * *')}🕕 Каждые 6 часов`,   'backup_int_6h')],
    [Markup.button.callback(`${label('0 * * * *')}🕐 Каждый час`,          'backup_int_1h')],
    [Markup.button.callback('✏️ Свой cron-выражение',                       'backup_int_custom')],
    [Markup.button.callback(`${currentCron ? '' : '✅ '}❌ Отключить`,      'backup_int_off')],
    [Markup.button.callback('◀️ Назад',                                     'backup_menu')],
  ]);
}

// ─── Start / Menu ─────────────────────────────────────────────────────────────

bot.start(async ctx => {
  await ctx.reply('👋 Добро пожаловать в панель управления *Modeus Calendar*', {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

bot.command('menu', async ctx => {
  await ctx.reply('Главное меню:', mainMenu());
});

// ─── Statistics ───────────────────────────────────────────────────────────────

bot.action('stats', async ctx => {
  await ctx.answerCbQuery();
  const s = repo.getStats();
  const recentLines =
    s.recentUsers.length > 0
      ? s.recentUsers.map(u => `  • ${u.fio} _(${u.createdAt.slice(0, 10)})_`).join('\n')
      : '  _нет пользователей_';
  const text = [
    '📊 *Статистика*',
    '',
    `👥 Подписчиков: *${s.users}*`,
    `🎟️ Инвайт-кодов создано: *${s.totalCodes}*`,
    `✅ Использовано: *${s.usedCodes}*`,
    `🆓 Доступно: *${s.totalCodes - s.usedCodes}*`,
    '',
    '*Последние регистрации:*',
    recentLines,
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'back_main')]]),
  });
});

// ─── Create invite code ───────────────────────────────────────────────────────

bot.action('create_invite', async ctx => {
  await ctx.answerCbQuery();
  const code = repo.createInviteCode();
  await ctx.editMessageText(
    `🎟️ *Новый инвайт-код создан*\n\nКод: \`${code}\`\n\n_Передайте этот код пользователю. Код одноразовый._`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎟️ Ещё один код', 'create_invite')],
        [Markup.button.callback('◀️ Назад', 'back_main')],
      ]),
    },
  );
});

// ─── Users list with pagination ───────────────────────────────────────────────

bot.action(/^users_p_(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const page      = parseInt((ctx.match as RegExpMatchArray)[1] ?? '0', 10);
  const PAGE_SIZE = 10;
  const { items, total } = repo.listSubscriptions(page, PAGE_SIZE);

  let text: string;
  if (total === 0) {
    text = '👥 *Пользователи*\n\n_Нет подписчиков._';
  } else {
    const lines = items.map((s, i) => `${page * PAGE_SIZE + i + 1}. ${s.fio}`);
    text = `👥 *Пользователи* (всего: ${total})\n\n${lines.join('\n')}`;
  }

  const navButtons: ReturnType<typeof Markup.button.callback>[] = [];
  if (page > 0) navButtons.push(Markup.button.callback('◀️', `users_p_${page - 1}`));
  if ((page + 1) * PAGE_SIZE < total)
    navButtons.push(Markup.button.callback('▶️', `users_p_${page + 1}`));

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      ...(navButtons.length > 0 ? [navButtons] : []),
      [Markup.button.callback('◀️ Назад', 'back_main')],
    ]),
  });
});

// ─── Invite codes list with pagination ───────────────────────────────────────

bot.action(/^invites_p_(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const page      = parseInt((ctx.match as RegExpMatchArray)[1] ?? '0', 10);
  const PAGE_SIZE = 10;
  const { items, total } = repo.listInviteCodes(page, PAGE_SIZE);

  let text: string;
  if (total === 0) {
    text = '🔑 *Инвайт-коды*\n\n_Кодов нет._';
  } else {
    const lines = items.map(c => {
      const status = c.used ? `✅ ${c.usedByFio ?? '?'}` : '🆓 свободен';
      return `\`${c.code}\` — ${status}`;
    });
    text = `🔑 *Инвайт-коды* (всего: ${total})\n\n${lines.join('\n')}`;
  }

  const navButtons: ReturnType<typeof Markup.button.callback>[] = [];
  if (page > 0) navButtons.push(Markup.button.callback('◀️', `invites_p_${page - 1}`));
  if ((page + 1) * PAGE_SIZE < total)
    navButtons.push(Markup.button.callback('▶️', `invites_p_${page + 1}`));

  // Delete buttons for each unused code on this page
  const deleteButtons = items
    .filter(c => !c.used)
    .map(c => [Markup.button.callback(`🗑️ Удалить ${c.code}`, `del_inv_${c.code}`)]);

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      ...deleteButtons,
      ...(navButtons.length > 0 ? [navButtons] : []),
      [Markup.button.callback('🎟️ Создать код', 'create_invite')],
      [Markup.button.callback('◀️ Назад', 'back_main')],
    ]),
  });
});

// ─── Delete unused invite code ────────────────────────────────────────────────

bot.action(/^del_inv_([0-9A-F]{8})$/, async ctx => {
  await ctx.answerCbQuery();
  const code    = (ctx.match as RegExpMatchArray)[1]!;
  const deleted = repo.deleteInviteCode(code);
  const notice  = deleted
    ? `🗑️ Код \`${code}\` удалён.`
    : `⚠️ Код \`${code}\` не найден или уже использован.`;

  await ctx.editMessageText(notice, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔑 К списку кодов', 'invites_p_0')]]),
  });
});

// ─── Add user flow ────────────────────────────────────────────────────────────

bot.action('add_user', async ctx => {
  await ctx.answerCbQuery();
  userState.set(ctx.from!.id, { action: 'awaiting_fio' });
  await ctx.editMessageText(
    '➕ *Добавить пользователя*\n\nВведите полное ФИО пользователя:\n_(Фамилия Имя Отчество)_',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_main')]]),
    },
  );
});

// ─── Back to main menu ────────────────────────────────────────────────────────

bot.action('back_main', async ctx => {
  await ctx.answerCbQuery();
  userState.delete(ctx.from!.id);
  pendingSelections.delete(ctx.from!.id);
  await ctx.editMessageText('Главное меню:', mainMenu());
});

// ─── Person selection from multiple results ───────────────────────────────────

bot.action(/^pick_(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const idx     = parseInt((ctx.match as RegExpMatchArray)[1] ?? '0', 10);
  const persons = pendingSelections.get(ctx.from!.id);
  if (!persons || idx >= persons.length) {
    await ctx.editMessageText('❌ Сессия устарела. Попробуйте снова.', mainMenu());
    return;
  }
  const person = persons[idx]!;
  pendingSelections.delete(ctx.from!.id);

  await ctx.editMessageText('⏳ Регистрируем...');

  try {
    const response = await fetch(`${BACKEND_URL}/api/internal/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({ personId: person.id, personName: person.name }),
    });

    const data = (await response.json()) as {
      message?: string;
      url?: string;
      error?: string;
    };

    if (!response.ok) {
      await ctx.editMessageText(
        `❌ Ошибка: ${data.error ?? 'неизвестная ошибка'}`,
        mainMenu(),
      );
      return;
    }

    await ctx.editMessageText(
      `✅ *${data.message}*\n\nСсылка на календарь:\n\`${data.url}\``,
      { parse_mode: 'Markdown', ...mainMenu() },
    );
  } catch (err: unknown) {
    await ctx.editMessageText(`❌ Ошибка соединения: ${String(err)}`, mainMenu());
  }
});

// ─── Find calendar link ───────────────────────────────────────────────────────

bot.action('find_link', async ctx => {
  await ctx.answerCbQuery();
  userState.set(ctx.from!.id, { action: 'awaiting_link_query' });
  await ctx.editMessageText(
    '🔗 *Найти ссылку на календарь*\n\nВведите ФИО (или часть) пользователя:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'back_main')]]),
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// BACKUP MENU
// ─────────────────────────────────────────────────────────────────────────────

bot.action('backup_menu', async ctx => {
  await ctx.answerCbQuery();
  const list  = backup.list();
  const cron  = repo.getSetting('backup_cron', DEFAULT_BACKUP_CRON);
  const cronLabel = cron || 'отключено';
  await ctx.editMessageText(
    `📦 *Бэкапы*\n\nВсего бэкапов: *${list.length}*\nАвторасписание: \`${cronLabel}\``,
    { parse_mode: 'Markdown', ...backupMenu() },
  );
});

// ─── Create & send backup ─────────────────────────────────────────────────────

bot.action('backup_create', async ctx => {
  await ctx.answerCbQuery('⏳ Создаём бэкап...');
  await ctx.editMessageText('⏳ Создаём бэкап, подождите...');

  try {
    const info = await backup.create();
    await ctx.replyWithDocument(
      { source: createReadStream(info.fullPath), filename: info.filename },
      { caption: `💾 Бэкап создан: *${BackupService.label(info)}*`, parse_mode: 'Markdown' },
    );
    await ctx.editMessageText(
      `✅ Бэкап \`${info.filename}\` создан и отправлен.`,
      { parse_mode: 'Markdown', ...backupMenu() },
    );
  } catch (err: unknown) {
    await ctx.editMessageText(`❌ Ошибка создания бэкапа: ${String(err)}`, backupMenu());
  }
});

// ─── Backup list (two modes: normal view and restore-picker) ──────────────────

const PAGE_SIZE_BACKUPS = 5;

function buildBackupListMessage(
  page: number,
  restoreMode: boolean,
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const list  = backup.list();
  const total = list.length;
  const items = list.slice(page * PAGE_SIZE_BACKUPS, (page + 1) * PAGE_SIZE_BACKUPS);

  const title = restoreMode ? '♻️ *Выберите бэкап для восстановления*' : '📋 *Список бэкапов*';
  let text: string;

  if (total === 0) {
    text = `${title}\n\n_Бэкапов нет._`;
  } else {
    const lines = items.map((b, i) =>
      `${page * PAGE_SIZE_BACKUPS + i + 1}. ${BackupService.label(b)}`,
    );
    text = `${title} (всего: ${total})\n\n${lines.join('\n')}`;
  }

  const navButtons: ReturnType<typeof Markup.button.callback>[] = [];
  if (page > 0)
    navButtons.push(
      Markup.button.callback('◀️', `backup_list_p_${page - 1}${restoreMode ? '_restore' : ''}`),
    );
  if ((page + 1) * PAGE_SIZE_BACKUPS < total)
    navButtons.push(
      Markup.button.callback('▶️', `backup_list_p_${page + 1}${restoreMode ? '_restore' : ''}`),
    );

  const itemButtons = items.map(b =>
    [Markup.button.callback(BackupService.label(b), `backup_pick_${b.filename}`)],
  );

  const keyboard = Markup.inlineKeyboard([
    ...itemButtons,
    ...(navButtons.length > 0 ? [navButtons] : []),
    [Markup.button.callback('◀️ Назад', 'backup_menu')],
  ]);

  return { text, keyboard };
}

bot.action(/^backup_list_p_(\d+)(_restore)?$/, async ctx => {
  await ctx.answerCbQuery();
  const m           = ctx.match as RegExpMatchArray;
  const page        = parseInt(m[1] ?? '0', 10);
  const restoreMode = !!m[2];
  const { text, keyboard } = buildBackupListMessage(page, restoreMode);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
});

// ─── Single backup detail view ────────────────────────────────────────────────

bot.action(/^backup_pick_(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const filename = (ctx.match as RegExpMatchArray)[1]!;
  const list     = backup.list();
  const info     = list.find(b => b.filename === filename);

  if (!info) {
    await ctx.editMessageText('❌ Бэкап не найден.', backupMenu());
    return;
  }

  const text = [
    `📁 *${info.filename}*`,
    `Дата: ${info.date.toLocaleString('ru-RU')}`,
    `Размер: ${info.sizeKb} KB`,
  ].join('\n');

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📨 Отправить файл',        `backup_send_${filename}`)],
      [Markup.button.callback('♻️ Восстановить',           `backup_restore_${filename}`)],
      [Markup.button.callback('🗑️ Удалить',                `backup_del_${filename}`)],
      [Markup.button.callback('◀️ К списку',               'backup_list_p_0')],
    ]),
  });
});

// ─── Send backup file ─────────────────────────────────────────────────────────

bot.action(/^backup_send_(.+)$/, async ctx => {
  await ctx.answerCbQuery('⏳ Отправляем файл...');
  const filename = (ctx.match as RegExpMatchArray)[1]!;
  const list     = backup.list();
  const info     = list.find(b => b.filename === filename);

  if (!info) {
    await ctx.editMessageText('❌ Бэкап не найден.', backupMenu());
    return;
  }

  try {
    await ctx.replyWithDocument(
      { source: createReadStream(info.fullPath), filename: info.filename },
      { caption: `📁 ${BackupService.label(info)}`, parse_mode: 'Markdown' },
    );
    await ctx.answerCbQuery('✅ Файл отправлен');
  } catch (err: unknown) {
    await ctx.reply(`❌ Ошибка отправки: ${String(err)}`);
  }
});

// ─── Restore: confirmation step ───────────────────────────────────────────────

bot.action(/^backup_restore_(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const filename = (ctx.match as RegExpMatchArray)[1]!;

  await ctx.editMessageText(
    `⚠️ *Восстановление из бэкапа*\n\n` +
    `Файл: \`${filename}\`\n\n` +
    `Текущие данные будут *перезаписаны*. Бот перезапустится после восстановления.\n` +
    `Backend нужно перезапустить вручную: \`docker compose restart backend\`\n\n` +
    `Вы уверены?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, восстановить', `backup_confirm_${filename}`)],
        [Markup.button.callback('❌ Отмена',            'backup_list_p_0')],
      ]),
    },
  );
});

// ─── Restore: execute ─────────────────────────────────────────────────────────

bot.action(/^backup_confirm_(.+)$/, async ctx => {
  await ctx.answerCbQuery('⏳ Восстанавливаем...');
  const filename = (ctx.match as RegExpMatchArray)[1]!;

  await ctx.editMessageText('⏳ Восстанавливаем данные из бэкапа...');

  try {
    await backup.restore(filename);
    await ctx.editMessageText(
      `✅ *Восстановление завершено*\n\n` +
      `Бот перезапускается...\n` +
      `Перезапустите backend: \`docker compose restart backend\``,
      { parse_mode: 'Markdown' },
    );
    // Restart the bot so it reconnects to the restored DB
    setTimeout(() => process.exit(0), 1500);
  } catch (err: unknown) {
    await ctx.editMessageText(`❌ Ошибка восстановления: ${String(err)}`, backupMenu());
  }
});

// ─── Delete backup ────────────────────────────────────────────────────────────

bot.action(/^backup_del_(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const filename = (ctx.match as RegExpMatchArray)[1]!;
  const ok       = backup.delete(filename);
  const text     = ok
    ? `🗑️ Бэкап \`${filename}\` удалён.`
    : `⚠️ Файл не найден: \`${filename}\``;

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('📋 К списку', 'backup_list_p_0')]]),
  });
});

// ─── Backup interval settings ─────────────────────────────────────────────────

bot.action('backup_int', async ctx => {
  await ctx.answerCbQuery();
  const current = repo.getSetting('backup_cron', DEFAULT_BACKUP_CRON);
  const label   = current || 'отключено';
  await ctx.editMessageText(
    `⏱️ *Интервал автобэкапов*\n\nТекущее расписание: \`${label}\``,
    { parse_mode: 'Markdown', ...intervalMenu(current) },
  );
});

const CRON_PRESETS: Record<string, string> = {
  backup_int_daily: '0 2 * * *',
  backup_int_12h:   '0 */12 * * *',
  backup_int_6h:    '0 */6 * * *',
  backup_int_1h:    '0 * * * *',
  backup_int_off:   '',
};

bot.action(/^backup_int_(daily|12h|6h|1h|off)$/, async ctx => {
  await ctx.answerCbQuery();
  const key   = (ctx.match as RegExpMatchArray)[0]!;
  const expr  = CRON_PRESETS[key] ?? '';
  repo.setSetting('backup_cron', expr);
  backup.startSchedule(expr);
  const label = expr || 'отключено';
  await ctx.editMessageText(
    `✅ Расписание обновлено: \`${label}\``,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'backup_int')]]),
    },
  );
});

bot.action('backup_int_custom', async ctx => {
  await ctx.answerCbQuery();
  userState.set(ctx.from!.id, { action: 'awaiting_cron' });
  await ctx.editMessageText(
    '✏️ *Свой cron-интервал*\n\n' +
    'Введите cron-выражение (5 полей):\n' +
    '`минуты часы день месяц день_недели`\n\n' +
    'Примеры:\n' +
    '`0 2 * * *` — каждый день в 2:00\n' +
    '`0 */6 * * *` — каждые 6 часов\n' +
    '`30 3 * * 1` — каждый понедельник в 3:30',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'backup_int')]]),
    },
  );
});

// ─── Text message handler ─────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const state = userState.get(ctx.from.id);

  // ── Custom cron expression ───────────────────────────────────────────────
  if (state?.action === 'awaiting_cron') {
    userState.delete(ctx.from.id);
    const expr = ctx.message.text.trim();

    // Validate cron expression
    if (!isCronValid(expr)) {
      await ctx.reply(
        '❌ Некорректное cron-выражение. Попробуйте снова или выберите пресет.',
        Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'backup_int')]]),
      );
      return;
    }

    repo.setSetting('backup_cron', expr);
    backup.startSchedule(expr);
    await ctx.reply(
      `✅ Расписание установлено: \`${expr}\``,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Меню', 'backup_int')]]) },
    );
    return;
  }

  // ── Link lookup by FIO ──────────────────────────────────────────────────
  if (state?.action === 'awaiting_link_query') {
    userState.delete(ctx.from.id);
    const query = ctx.message.text.trim();

    if (!query) {
      await ctx.reply('❌ Пустой запрос.', mainMenu());
      return;
    }

    const results = repo.findSubscriptionsByFio(query);

    if (results.length === 0) {
      await ctx.reply(
        `🔗 По запросу «${query}» ничего не найдено.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔗 Попробовать ещё', 'find_link')],
          [Markup.button.callback('◀️ Меню', 'back_main')],
        ]),
      );
      return;
    }

    const lines = results.map(r => {
      const url = `${BACKEND_URL}/${r.calendarToken}`;
      return `👤 *${r.fio}*\n\`${url}\``;
    });

    await ctx.reply(
      `🔗 *Найдено: ${results.length}*\n\n${lines.join('\n\n')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔗 Ещё поиск', 'find_link')],
          [Markup.button.callback('◀️ Меню', 'back_main')],
        ]),
      },
    );
    return;
  }

  // ── FIO for add_user ─────────────────────────────────────────────────────
  if (state?.action !== 'awaiting_fio') return;

  userState.delete(ctx.from.id);
  const fio = ctx.message.text.trim();
  const statusMsg = await ctx.reply('⏳ Ищем в Modeus...');

  try {
    const response = await fetch(`${BACKEND_URL}/api/internal/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({ fio }),
    });

    const data = (await response.json()) as {
      status?: string;
      persons?: Array<{ id: string; fullName: string; specialtyName: string | null }>;
      message?: string;
      url?: string;
      error?: string;
    };

    await ctx.telegram
      .deleteMessage(ctx.chat.id, statusMsg.message_id)
      .catch(() => {});

    if (!response.ok) {
      await ctx.reply(`❌ Ошибка: ${data.error ?? 'неизвестная ошибка'}`, mainMenu());
      return;
    }

    if (data.status === 'multiple' && data.persons) {
      pendingSelections.set(
        ctx.from.id,
        data.persons.map(p => ({
          id:        p.id,
          name:      p.fullName,
          specialty: p.specialtyName,
        })),
      );

      const buttons = data.persons.map((p, i) => {
        const label = p.specialtyName
          ? `${p.fullName} (${p.specialtyName.slice(0, 30)})`
          : p.fullName;
        return [Markup.button.callback(label, `pick_${i}`)];
      });
      buttons.push([Markup.button.callback('❌ Отмена', 'back_main')]);

      await ctx.reply('Найдено несколько человек. Выберите нужного:', Markup.inlineKeyboard(buttons));
      return;
    }

    await ctx.reply(`✅ *${data.message}*\n\nСсылка на календарь:\n\`${data.url}\``, {
      parse_mode: 'Markdown',
      ...mainMenu(),
    });
  } catch (err: unknown) {
    await ctx.reply(`❌ Ошибка: ${String(err)}`, mainMenu());
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isCronValid(expr: string): boolean {
  try {
    return cron.validate(expr);
  } catch {
    return false;
  }
}

// ─── Launch ───────────────────────────────────────────────────────────────────

bot
  .launch({ dropPendingUpdates: true })
  .then(() => {
    console.log(`[Bot] Started, admin ID: ${ADMIN_ID}`);
  })
  .catch((err: unknown) => {
    console.error('[Bot] Failed to start:', err);
    process.exit(1);
  });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
