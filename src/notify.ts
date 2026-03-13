/**
 * Sends a Markdown message to the Telegram admin.
 * Uses the Bot API directly — no Telegraf dependency needed in the backend.
 * Silently ignores failures so a notification issue never crashes the app.
 */
export async function notifyAdmin(text: string): Promise<void> {
  const token   = process.env['TELEGRAM_BOT_TOKEN'];
  const adminId = process.env['TELEGRAM_ADMIN_ID'];
  if (!token || !adminId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: adminId, text, parse_mode: 'Markdown' }),
    });
  } catch {
    // Notification failures must not propagate
  }
}
