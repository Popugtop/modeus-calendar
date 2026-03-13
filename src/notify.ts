async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch {
    // Notification failures must not propagate
  }
}

/**
 * Sends a Markdown message to the Telegram admin.
 * Uses the Bot API directly — no Telegraf dependency needed in the backend.
 */
export async function notifyAdmin(text: string): Promise<void> {
  const adminId = process.env['TELEGRAM_ADMIN_ID'];
  if (!adminId) return;
  await sendTelegramMessage(adminId, text);
}

/**
 * Sends a Markdown message to a specific user by Telegram ID.
 */
export async function notifyUser(telegramId: string, text: string): Promise<void> {
  await sendTelegramMessage(telegramId, text);
}
