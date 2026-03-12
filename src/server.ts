import 'dotenv/config';
import path from 'path';
import express, { type Request, type Response } from 'express';
import { ModeusAuthService } from './auth/ModeusAuthService';
import { ModeusService } from './api/ModeusService';
import { loadTokens, saveTokens } from './auth/tokenCache';
import { CalendarRepository } from './calendar/CalendarRepository';
import { ScheduleSyncService } from './calendar/ScheduleSyncService';
import { buildIcs } from './calendar/IcsBuilder';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH = process.env['DB_PATH'] ?? './calendar.db';

// ─── Auth ──────────────────────────────────────────────────────────────────────

async function createModeusService(): Promise<ModeusService> {
  const username = process.env['MODEUS_USERNAME'];
  const password = process.env['MODEUS_PASSWORD'];
  if (!username || !password) {
    throw new Error('Укажите MODEUS_USERNAME и MODEUS_PASSWORD в .env');
  }

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

  return new ModeusService(auth);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const modeus = await createModeusService();
  const repo   = new CalendarRepository(DB_PATH);
  const sync   = new ScheduleSyncService(modeus, repo);

  const app = express();
  app.use(express.json());

  // ── Статика фронтенда (React build) ──────────────────────────────────────────
  const clientDist = path.join(__dirname, '../client/dist');
  app.use(express.static(clientDist));

  // ── POST /api/calendar/register ──────────────────────────────────────────────
  //
  // Body: { "fio": "Иванов Иван Иванович" }
  //
  // 1. Searches Modeus for the person by name.
  // 2. Creates a subscription in the DB (idempotent by modeusPersonId).
  // 3. Triggers an immediate background sync for the new subscriber.
  // 4. Returns { token, url } where url is the ICS feed path.

  app.post('/api/calendar/register', (req: Request, res: Response) => {
    void (async () => {
      const fio = (req.body as { fio?: string }).fio?.trim();

      if (!fio) {
        res.status(400).json({ error: 'Поле "fio" обязательно.' });
        return;
      }

      // Search person in Modeus
      const { persons } = await modeus.searchPersons(fio, 5);

      if (persons.length === 0) {
        res.status(404).json({ error: `Человек "${fio}" не найден в Modeus.` });
        return;
      }

      // If multiple results — client should narrow the search. For now take first.
      const person = persons[0]!;

      // Create (or return existing) subscription
      const sub = repo.createSubscription(person.fullName, person.id);

      // Trigger immediate sync in background (don't block the response)
      void sync.syncOne(sub).catch((err: unknown) =>
        console.error('[Register] Фоновый sync упал:', err),
      );

      const host = req.headers['host'] ?? `localhost:${PORT}`;
      const protocol = req.headers['x-forwarded-proto'] ?? req.protocol;
      // Short URL: calendar.popugtop.dev/<token>
      const feedUrl = `${protocol}://${host}/${sub.calendarToken}`;

      res.status(201).json({
        message: `Подписка создана для "${person.fullName}".`,
        token:   sub.calendarToken,
        url:     feedUrl,
      });
    })();
  });

  // ── GET /<token>[.ics] ────────────────────────────────────────────────────────
  //
  // Tokens are 48-char hex strings (randomBytes(24).toString('hex')).
  // Using a regex prevents this route from matching /api, /assets, etc.
  // Supports: /<token>  and  /<token>.ics  (some calendar clients append .ics)

  function serveIcs(token: string, res: Response): void {
    const sub = repo.findSubscriptionByToken(token);
    if (!sub) {
      res.status(404).send('Subscription not found');
      return;
    }
    const events = repo.getScheduleCache(sub.id);
    if (!events) {
      res.status(503).send('Schedule not yet synced, try again in a few seconds');
      return;
    }
    const ics = buildIcs(sub, events);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="schedule-${token.slice(0, 8)}.ics"`);
    res.send(ics);
  }

  // Matches /abcdef0123...  (48 hex chars, optionally followed by .ics)
  app.get(/^\/([0-9a-f]{48})(\.ics)?$/i, (req: Request, res: Response) => {
    serveIcs((req.params as unknown as string[])[0] ?? '', res);
  });

  // ── SPA fallback — все остальные пути отдают index.html ──────────────────────
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // ─── Start ───────────────────────────────────────────────────────────────────

  sync.start();

  app.listen(PORT, () => {
    console.log(`[Server] Слушает http://localhost:${PORT}`);
    console.log(`[Server] POST /api/calendar/register — создать подписку`);
    console.log(`[Server] GET  /<48-hex-token>[.ics]  — ICS-фид`);
  });
}

main().catch((err: unknown) => {
  console.error('Ошибка запуска сервера:', err);
  process.exit(1);
});
