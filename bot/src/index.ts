import 'dotenv/config';
import { createReadStream } from 'fs';
import { Telegraf, Markup } from 'telegraf';
import cron from 'node-cron';
import { BotRepository } from './db';
import { BackupService } from './backup';

const BOT_TOKEN       = process.env['TELEGRAM_BOT_TOKEN'];
const ADMIN_ID        = parseInt(process.env['TELEGRAM_ADMIN_ID'] ?? '0', 10);
const BACKEND_URL     = process.env['BACKEND_URL'] ?? 'http://backend:3000';
const PUBLIC_URL      = (process.env['PUBLIC_URL'] ?? BACKEND_URL).replace(/\/$/, '');
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
const userState = new Map<number, { action: string; data?: string }>();

// Pending person lists for add-user selection
const pendingSelections = new Map<
  number,
  Array<{ id: string; name: string; specialty: string | null }>
>();

// Pending person lists for link-TG and delete-user selection
const pendingLinkSelections   = new Map<number, Array<{ name: string; modeusPersonId: string }>>();
const pendingDeleteSelections = new Map<number, Array<{ name: string; modeusPersonId: string }>>();

// ─── Admin check ──────────────────────────────────────────────────────────────
function isAdmin(userId: number): boolean {
  return userId === ADMIN_ID;
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYBOARD BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Статистика', 'stats')],
    [
      Markup.button.callback('👥 Пользователи', 'users_menu'),
      Markup.button.callback('🎟️ Инвайты',      'invites_menu'),
    ],
    [Markup.button.callback('📦 Бэкапы', 'backup_menu')],
  ]);
}

function usersMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('➕ Добавить',     'add_user'),
      Markup.button.callback('👥 Список',       'users_p_0'),
    ],
    [
      Markup.button.callback('🔗 Найти ссылку',  'find_link'),
      Markup.button.callback('🔗 Привязать TG',  'link_tg'),
    ],
    [Markup.button.callback('🗑️ Удалить пользователя', 'delete_user')],
    [Markup.button.callback('◀️ Главное меню',  'back_main')],
  ]);
}

function invitesMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🎟️ Создать код',  'create_invite'),
      Markup.button.callback('🔑 Список кодов', 'invites_p_0'),
    ],
    [Markup.button.callback('◀️ Главное меню', 'back_main')],
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
  const mark = (expr: string) => currentCron === expr ? '✅ ' : '';
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${mark('0 2 * * *')}🌙 Каждый день в 2:00`,  'backup_int_daily')],
    [Markup.button.callback(`${mark('0 */12 * * *')}🕛 Каждые 12 часов`, 'backup_int_12h')],
    [Markup.button.callback(`${mark('0 */6 * * *')}🕕 Каждые 6 часов`,   'backup_int_6h')],
    [Markup.button.callback(`${mark('0 * * * *')}🕐 Каждый час`,          'backup_int_1h')],
    [Markup.button.callback('✏️ Своё cron-выражение',                      'backup_int_custom')],
    [Markup.button.callback(`${currentCron ? '' : '✅ '}❌ Отключить`,     'backup_int_off')],
    [Markup.button.callback('◀️ Назад',                                    'backup_menu')],
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// START — public entry point (admin + users)
// ─────────────────────────────────────────────────────────────────────────────

bot.start(async ctx => {
  const userId = ctx.from.id;

  if (isAdmin(userId)) {
    await ctx.reply('👋 Добро пожаловать в панель управления *Modeus Calendar*', {
      parse_mode: 'Markdown',
      ...mainMenu(),
    });
    return;
  }

  // Non-admin: look up their subscription by Telegram ID
  const sub = repo.findByTelegramId(String(userId));
  if (sub) {
    const url = `${PUBLIC_URL}/${sub.calendarToken}`;
    await ctx.reply(
      `👋 Привет, *${sub.fio}*!\n\nТвоя ссылка на расписание:\n\`${url}\`\n\n_Добавь её в Calendar — расписание будет обновляться автоматически._`,
      { parse_mode: 'Markdown' },
    );
  } else {
    await ctx.reply(
      `👋 Привет!\n\nТвой Telegram ID: \`${userId}\`\n\nПередай его администратору — он привяжет ID к твоей подписке. После этого нажми /start снова.`,
      { parse_mode: 'Markdown' },
    );
  }
});

bot.command('menu', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply('Главное меню:', mainMenu());
});

// ─── Admin-only guard for all subsequent handlers ────────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.updateType === 'callback_query' || ctx.updateType === 'message') {
    if (!isAdmin(ctx.from?.id ?? 0)) {
      if (ctx.updateType === 'callback_query') await ctx.answerCbQuery();
      return;
    }
  }
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────

bot.action('back_main', async ctx => {
  await ctx.answerCbQuery();
  userState.delete(ctx.from!.id);
  pendingSelections.delete(ctx.from!.id);
  pendingLinkSelections.delete(ctx.from!.id);
  pendingDeleteSelections.delete(ctx.from!.id);
  await ctx.editMessageText('Главное меню:', mainMenu());
});

bot.action('users_menu', async ctx => {
  await ctx.answerCbQuery();
  userState.delete(ctx.from!.id);
  pendingSelections.delete(ctx.from!.id);
  pendingLinkSelections.delete(ctx.from!.id);
  pendingDeleteSelections.delete(ctx.from!.id);
  await ctx.editMessageText('👥 *Пользователи*', { parse_mode: 'Markdown', ...usersMenu() });
});

bot.action('invites_menu', async ctx => {
  await ctx.answerCbQuery();
  userState.delete(ctx.from!.id);
  await ctx.editMessageText('🎟️ *Инвайт-коды*', { parse_mode: 'Markdown', ...invitesMenu() });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATISTICS
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// ── РАЗДЕЛ: ПОЛЬЗОВАТЕЛИ ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// ─── Add user ─────────────────────────────────────────────────────────────────

bot.action('add_user', async ctx => {
  await ctx.answerCbQuery();
  userState.set(ctx.from!.id, { action: 'awaiting_fio' });
  await ctx.editMessageText(
    '➕ *Добавить пользователя*\n\nВведите полное ФИО:\n_(Фамилия Имя Отчество)_',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'users_menu')]]),
    },
  );
});

// Person selection after multiple results from add_user
bot.action(/^pick_(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const idx     = parseInt((ctx.match as RegExpMatchArray)[1] ?? '0', 10);
  const persons = pendingSelections.get(ctx.from!.id);
  if (!persons || idx >= persons.length) {
    await ctx.editMessageText('❌ Сессия устарела. Попробуйте снова.', usersMenu());
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

    const data = (await response.json()) as { message?: string; url?: string; error?: string };

    if (!response.ok) {
      await ctx.editMessageText(`❌ Ошибка: ${data.error ?? 'неизвестная ошибка'}`, usersMenu());
      return;
    }

    await ctx.editMessageText(
      `✅ *${data.message}*\n\nСсылка на календарь:\n\`${data.url}\``,
      { parse_mode: 'Markdown', ...usersMenu() },
    );
  } catch (err: unknown) {
    await ctx.editMessageText(`❌ Ошибка соединения: ${String(err)}`, usersMenu());
  }
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
    const lines = items.map((s, i) => {
      const tg = s.telegramId ? ` 🔔` : '';
      return `${page * PAGE_SIZE + i + 1}. ${s.fio}${tg}`;
    });
    text = `👥 *Пользователи* (всего: ${total})\n🔔 = подключены уведомления\n\n${lines.join('\n')}`;
  }

  const navButtons: ReturnType<typeof Markup.button.callback>[] = [];
  if (page > 0) navButtons.push(Markup.button.callback('◀️', `users_p_${page - 1}`));
  if ((page + 1) * PAGE_SIZE < total)
    navButtons.push(Markup.button.callback('▶️', `users_p_${page + 1}`));

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      ...(navButtons.length > 0 ? [navButtons] : []),
      [Markup.button.callback('◀️ Назад', 'users_menu')],
    ]),
  });
});

// ─── Find calendar link ───────────────────────────────────────────────────────

bot.action('find_link', async ctx => {
  await ctx.answerCbQuery();
  userState.set(ctx.from!.id, { action: 'awaiting_link_query' });
  await ctx.editMessageText(
    '🔗 *Найти ссылку на календарь*\n\nВведите ФИО (или часть) пользователя:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'users_menu')]]),
    },
  );
});

// ─── Link Telegram ID to user ─────────────────────────────────────────────────

bot.action('link_tg', async ctx => {
  await ctx.answerCbQuery();
  userState.set(ctx.from!.id, { action: 'awaiting_link_tg_fio' });
  await ctx.editMessageText(
    '🔗 *Привязать Telegram ID*\n\nВведите ФИО пользователя (или часть):',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'users_menu')]]),
    },
  );
});

bot.action(/^link_tg_pick_(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const idx     = parseInt((ctx.match as RegExpMatchArray)[1] ?? '0', 10);
  const persons = pendingLinkSelections.get(ctx.from!.id);
  if (!persons || idx >= persons.length) {
    await ctx.editMessageText('❌ Сессия устарела.', usersMenu());
    return;
  }
  const person = persons[idx]!;
  pendingLinkSelections.delete(ctx.from!.id);
  userState.set(ctx.from!.id, { action: 'awaiting_link_tg_id', data: person.modeusPersonId });
  await ctx.editMessageText(
    `🔗 Пользователь: *${person.name}*\n\nВведите Telegram ID для привязки:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'users_menu')]]),
    },
  );
});

// ─── Delete user ──────────────────────────────────────────────────────────────

bot.action('delete_user', async ctx => {
  await ctx.answerCbQuery();
  userState.set(ctx.from!.id, { action: 'awaiting_delete_fio' });
  await ctx.editMessageText(
    '🗑️ *Удалить пользователя*\n\nВведите ФИО (или часть) пользователя:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'users_menu')]]),
    },
  );
});

bot.action(/^delete_pick_(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const idx     = parseInt((ctx.match as RegExpMatchArray)[1] ?? '0', 10);
  const persons = pendingDeleteSelections.get(ctx.from!.id);
  if (!persons || idx >= persons.length) {
    await ctx.editMessageText('❌ Сессия устарела.', usersMenu());
    return;
  }
  const person = persons[idx]!;
  // Keep selection alive for confirm step
  userState.set(ctx.from!.id, { action: 'delete_confirm', data: JSON.stringify(person) });

  await ctx.editMessageText(
    `⚠️ *Удалить пользователя?*\n\n*${person.name}*\n\nЭто действие необратимо — подписка и кэш расписания будут удалены.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да, удалить', 'delete_confirm')],
        [Markup.button.callback('❌ Отмена',       'users_menu')],
      ]),
    },
  );
});

bot.action('delete_confirm', async ctx => {
  await ctx.answerCbQuery();
  const state = userState.get(ctx.from!.id);
  if (state?.action !== 'delete_confirm' || !state.data) {
    await ctx.editMessageText('❌ Сессия устарела.', usersMenu());
    return;
  }
  const person = JSON.parse(state.data) as { name: string; modeusPersonId: string };
  userState.delete(ctx.from!.id);
  pendingDeleteSelections.delete(ctx.from!.id);

  const ok = repo.deleteSubscription(person.modeusPersonId);
  if (ok) {
    await ctx.editMessageText(
      `🗑️ Пользователь *${person.name}* удалён.`,
      { parse_mode: 'Markdown', ...usersMenu() },
    );
  } else {
    await ctx.editMessageText(`⚠️ Пользователь не найден (уже удалён?).`, usersMenu());
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── РАЗДЕЛ: ИНВАЙТ-КОДЫ ──────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

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
        [Markup.button.callback('◀️ Назад',         'invites_menu')],
      ]),
    },
  );
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

  const deleteButtons = items
    .filter(c => !c.used)
    .map(c => [Markup.button.callback(`🗑️ Удалить ${c.code}`, `del_inv_${c.code}`)]);

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      ...deleteButtons,
      ...(navButtons.length > 0 ? [navButtons] : []),
      [Markup.button.callback('🎟️ Создать код', 'create_invite')],
      [Markup.button.callback('◀️ Назад',       'invites_menu')],
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

// ─────────────────────────────────────────────────────────────────────────────
// ── РАЗДЕЛ: БЭКАПЫ ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

bot.action('backup_menu', async ctx => {
  await ctx.answerCbQuery();
  const list      = backup.list();
  const cronExpr  = repo.getSetting('backup_cron', DEFAULT_BACKUP_CRON);
  const cronLabel = cronExpr || 'отключено';
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

// ─── Backup list (normal view + restore picker) ───────────────────────────────

const PAGE_SIZE_BACKUPS = 5;

function buildBackupListMessage(
  page: number,
  restoreMode: boolean,
): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const list  = backup.list();
  const total = list.length;
  const items = list.slice(page * PAGE_SIZE_BACKUPS, (page + 1) * PAGE_SIZE_BACKUPS);

  const title = restoreMode ? '♻️ *Выберите бэкап для восстановления*' : '📋 *Список бэкапов*';
  const text  = total === 0
    ? `${title}\n\n_Бэкапов нет._`
    : `${title} (всего: ${total})\n\n${items.map((b, i) => `${page * PAGE_SIZE_BACKUPS + i + 1}. ${BackupService.label(b)}`).join('\n')}`;

  const navButtons: ReturnType<typeof Markup.button.callback>[] = [];
  if (page > 0)
    navButtons.push(Markup.button.callback('◀️', `backup_list_p_${page - 1}${restoreMode ? '_restore' : ''}`));
  if ((page + 1) * PAGE_SIZE_BACKUPS < total)
    navButtons.push(Markup.button.callback('▶️', `backup_list_p_${page + 1}${restoreMode ? '_restore' : ''}`));

  const itemButtons = items.map(b =>
    [Markup.button.callback(BackupService.label(b), `backup_pick_${b.filename}`)],
  );

  return {
    text,
    keyboard: Markup.inlineKeyboard([
      ...itemButtons,
      ...(navButtons.length > 0 ? [navButtons] : []),
      [Markup.button.callback('◀️ Назад', 'backup_menu')],
    ]),
  };
}

bot.action(/^backup_list_p_(\d+)(_restore)?$/, async ctx => {
  await ctx.answerCbQuery();
  const m           = ctx.match as RegExpMatchArray;
  const page        = parseInt(m[1] ?? '0', 10);
  const restoreMode = !!m[2];
  const { text, keyboard } = buildBackupListMessage(page, restoreMode);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
});

// ─── Single backup detail ─────────────────────────────────────────────────────

bot.action(/^backup_pick_(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const filename = (ctx.match as RegExpMatchArray)[1]!;
  const info     = backup.list().find(b => b.filename === filename);

  if (!info) {
    await ctx.editMessageText('❌ Бэкап не найден.', backupMenu());
    return;
  }

  await ctx.editMessageText(
    [`📁 *${info.filename}*`, `Дата: ${info.date.toLocaleString('ru-RU')}`, `Размер: ${info.sizeKb} KB`].join('\n'),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📨 Отправить файл',   `backup_send_${filename}`)],
        [Markup.button.callback('♻️ Восстановить',      `backup_restore_${filename}`)],
        [Markup.button.callback('🗑️ Удалить',           `backup_del_${filename}`)],
        [Markup.button.callback('◀️ К списку',          'backup_list_p_0')],
      ]),
    },
  );
});

// ─── Send backup file ─────────────────────────────────────────────────────────

bot.action(/^backup_send_(.+)$/, async ctx => {
  await ctx.answerCbQuery('⏳ Отправляем файл...');
  const filename = (ctx.match as RegExpMatchArray)[1]!;
  const info     = backup.list().find(b => b.filename === filename);

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

// ─── Restore: confirmation ────────────────────────────────────────────────────

bot.action(/^backup_restore_(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const filename = (ctx.match as RegExpMatchArray)[1]!;

  await ctx.editMessageText(
    `⚠️ *Восстановление из бэкапа*\n\nФайл: \`${filename}\`\n\n` +
    `Текущие данные будут *перезаписаны*. Бот перезапустится после восстановления.\n` +
    `Backend нужно перезапустить вручную: \`docker compose restart backend\`\n\nВы уверены?`,
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
      `✅ *Восстановление завершено*\n\nБот перезапускается...\nПерезапустите backend: \`docker compose restart backend\``,
      { parse_mode: 'Markdown' },
    );
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
  await ctx.editMessageText(
    `⏱️ *Интервал автобэкапов*\n\nТекущее расписание: \`${current || 'отключено'}\``,
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
  const key  = (ctx.match as RegExpMatchArray)[0]!;
  const expr = CRON_PRESETS[key] ?? '';
  repo.setSetting('backup_cron', expr);
  backup.startSchedule(expr);
  await ctx.editMessageText(
    `✅ Расписание обновлено: \`${expr || 'отключено'}\``,
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

// ─────────────────────────────────────────────────────────────────────────────
// TEXT MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.on('text', async ctx => {
  const state = userState.get(ctx.from.id);

  // ── Custom cron expression ───────────────────────────────────────────────
  if (state?.action === 'awaiting_cron') {
    userState.delete(ctx.from.id);
    const expr = ctx.message.text.trim();
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

  // ── Link TG: search by FIO ───────────────────────────────────────────────
  if (state?.action === 'awaiting_link_tg_fio') {
    userState.delete(ctx.from.id);
    const results = repo.findSubscriptionsByFio(ctx.message.text.trim());
    if (results.length === 0) {
      await ctx.reply('❌ Пользователь не найден.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Меню', 'users_menu')]]));
      return;
    }
    if (results.length === 1) {
      const p = results[0]!;
      userState.set(ctx.from.id, { action: 'awaiting_link_tg_id', data: p.modeusPersonId });
      const tgInfo = p.telegramId ? `\nТекущий TG ID: \`${p.telegramId}\`` : '';
      await ctx.reply(
        `🔗 Пользователь: *${p.fio}*${tgInfo}\n\nВведите новый Telegram ID:`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'users_menu')]]) },
      );
      return;
    }
    pendingLinkSelections.set(ctx.from.id, results.map(r => ({ name: r.fio, modeusPersonId: r.modeusPersonId })));
    const buttons = results.map((r, i) => [Markup.button.callback(r.fio, `link_tg_pick_${i}`)]);
    buttons.push([Markup.button.callback('❌ Отмена', 'users_menu')]);
    await ctx.reply('Найдено несколько. Выберите пользователя:', Markup.inlineKeyboard(buttons));
    return;
  }

  // ── Link TG: set telegram ID ─────────────────────────────────────────────
  if (state?.action === 'awaiting_link_tg_id') {
    userState.delete(ctx.from.id);
    const input = ctx.message.text.trim();
    if (!/^\d+$/.test(input)) {
      await ctx.reply('❌ Telegram ID должен состоять только из цифр.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Меню', 'users_menu')]]));
      return;
    }
    const ok = repo.linkTelegramId(state.data ?? '', input);
    await ctx.reply(
      ok ? `✅ Telegram ID \`${input}\` привязан.` : '❌ Пользователь не найден.',
      { parse_mode: 'Markdown', ...usersMenu() },
    );
    return;
  }

  // ── Find link by FIO ─────────────────────────────────────────────────────
  if (state?.action === 'awaiting_link_query') {
    userState.delete(ctx.from.id);
    const query   = ctx.message.text.trim();
    const results = repo.findSubscriptionsByFio(query);
    if (results.length === 0) {
      await ctx.reply(
        `🔗 По запросу «${query}» ничего не найдено.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🔗 Попробовать ещё', 'find_link')],
          [Markup.button.callback('◀️ Меню',             'users_menu')],
        ]),
      );
      return;
    }
    const lines = results.map(r => `👤 *${r.fio}*\n\`${PUBLIC_URL}/${r.calendarToken}\``);
    await ctx.reply(
      `🔗 *Найдено: ${results.length}*\n\n${lines.join('\n\n')}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔗 Ещё поиск', 'find_link')],
          [Markup.button.callback('◀️ Меню',       'users_menu')],
        ]),
      },
    );
    return;
  }

  // ── Delete user: search by FIO ───────────────────────────────────────────
  if (state?.action === 'awaiting_delete_fio') {
    userState.delete(ctx.from.id);
    const results = repo.findSubscriptionsByFio(ctx.message.text.trim());
    if (results.length === 0) {
      await ctx.reply('❌ Пользователь не найден.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Меню', 'users_menu')]]));
      return;
    }
    if (results.length === 1) {
      const p = results[0]!;
      userState.set(ctx.from.id, { action: 'delete_confirm', data: JSON.stringify({ name: p.fio, modeusPersonId: p.modeusPersonId }) });
      await ctx.reply(
        `⚠️ *Удалить пользователя?*\n\n*${p.fio}*\n\nЭто необратимо — подписка и кэш расписания будут удалены.`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Да, удалить', 'delete_confirm')],
            [Markup.button.callback('❌ Отмена',       'users_menu')],
          ]),
        },
      );
      return;
    }
    pendingDeleteSelections.set(ctx.from.id, results.map(r => ({ name: r.fio, modeusPersonId: r.modeusPersonId })));
    const buttons = results.map((r, i) => [Markup.button.callback(r.fio, `delete_pick_${i}`)]);
    buttons.push([Markup.button.callback('❌ Отмена', 'users_menu')]);
    await ctx.reply('Найдено несколько. Выберите пользователя для удаления:', Markup.inlineKeyboard(buttons));
    return;
  }

  // ── Add user: FIO ────────────────────────────────────────────────────────
  if (state?.action !== 'awaiting_fio') return;

  userState.delete(ctx.from.id);
  const fio       = ctx.message.text.trim();
  const statusMsg = await ctx.reply('⏳ Ищем в Modeus...');

  try {
    const response = await fetch(`${BACKEND_URL}/api/internal/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
      body: JSON.stringify({ fio }),
    });

    const data = (await response.json()) as {
      status?: string;
      persons?: Array<{ id: string; fullName: string; specialtyName: string | null }>;
      message?: string;
      url?: string;
      error?: string;
    };

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});

    if (!response.ok) {
      await ctx.reply(`❌ Ошибка: ${data.error ?? 'неизвестная ошибка'}`, usersMenu());
      return;
    }

    if (data.status === 'multiple' && data.persons) {
      pendingSelections.set(
        ctx.from.id,
        data.persons.map(p => ({ id: p.id, name: p.fullName, specialty: p.specialtyName })),
      );
      const buttons = data.persons.map((p, i) => {
        const label = p.specialtyName
          ? `${p.fullName} (${p.specialtyName.slice(0, 30)})`
          : p.fullName;
        return [Markup.button.callback(label, `pick_${i}`)];
      });
      buttons.push([Markup.button.callback('❌ Отмена', 'users_menu')]);
      await ctx.reply('Найдено несколько человек. Выберите нужного:', Markup.inlineKeyboard(buttons));
      return;
    }

    await ctx.reply(`✅ *${data.message}*\n\nСсылка на календарь:\n\`${data.url}\``, {
      parse_mode: 'Markdown',
      ...usersMenu(),
    });
  } catch (err: unknown) {
    await ctx.reply(`❌ Ошибка: ${String(err)}`, usersMenu());
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isCronValid(expr: string): boolean {
  try { return cron.validate(expr); } catch { return false; }
}

// ─── Launch ───────────────────────────────────────────────────────────────────

bot
  .launch({ dropPendingUpdates: true })
  .then(() => { console.log(`[Bot] Started, admin ID: ${ADMIN_ID}`); })
  .catch((err: unknown) => { console.error('[Bot] Failed to start:', err); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
