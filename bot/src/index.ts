import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { BotRepository } from './db';

const BOT_TOKEN      = process.env['TELEGRAM_BOT_TOKEN'];
const ADMIN_ID       = parseInt(process.env['TELEGRAM_ADMIN_ID'] ?? '0', 10);
const BACKEND_URL    = process.env['BACKEND_URL'] ?? 'http://backend:3000';
const INTERNAL_SECRET = process.env['INTERNAL_SECRET'] ?? '';
const DB_PATH        = process.env['DB_PATH'] ?? '/app/data/calendar.db';

if (!BOT_TOKEN || !ADMIN_ID) {
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_ID are required');
  process.exit(1);
}

const bot  = new Telegraf(BOT_TOKEN);
const repo = new BotRepository(DB_PATH);

// State management for multi-step flows
const userState        = new Map<number, { action: string }>();
const pendingSelections = new Map<
  number,
  Array<{ id: string; name: string; specialty: string | null }>
>();

// Admin-only middleware
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== ADMIN_ID) {
    await ctx.reply('⛔ Доступ запрещён.');
    return;
  }
  return next();
});

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
  ]);
}

bot.start(async ctx => {
  await ctx.reply('👋 Добро пожаловать в панель управления *Modeus Calendar*', {
    parse_mode: 'Markdown',
    ...mainMenu(),
  });
});

bot.command('menu', async ctx => {
  await ctx.reply('Главное меню:', mainMenu());
});

// Statistics
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

// Create invite code
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

// Users list with pagination
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

// Invite codes list with pagination
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

  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      ...(navButtons.length > 0 ? [navButtons] : []),
      [Markup.button.callback('🎟️ Создать код', 'create_invite')],
      [Markup.button.callback('◀️ Назад', 'back_main')],
    ]),
  });
});

// Add user flow
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

// Back to main menu
bot.action('back_main', async ctx => {
  await ctx.answerCbQuery();
  userState.delete(ctx.from!.id);
  pendingSelections.delete(ctx.from!.id);
  await ctx.editMessageText('Главное меню:', mainMenu());
});

// Person selection from multiple results
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

// Text messages handler (for add_user FIO input)
bot.on('text', async ctx => {
  const state = userState.get(ctx.from.id);
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

    // Delete the "Searching..." message
    await ctx.telegram
      .deleteMessage(ctx.chat.id, statusMsg.message_id)
      .catch(() => {});

    if (!response.ok) {
      await ctx.reply(`❌ Ошибка: ${data.error ?? 'неизвестная ошибка'}`, mainMenu());
      return;
    }

    if (data.status === 'multiple' && data.persons) {
      // Store selections and show picker
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

      await ctx.reply(
        'Найдено несколько человек. Выберите нужного:',
        Markup.inlineKeyboard(buttons),
      );
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

bot
  .launch({ dropPendingUpdates: true })
  .then(() => {
    console.log(`[Bot] Started, admin ID: ${ADMIN_ID}`);
  })
  .catch((err: unknown) => {
    console.error('[Bot] Failed to start:', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
