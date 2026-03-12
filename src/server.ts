import 'dotenv/config';
import { existsSync } from 'fs';
import path from 'path';
import express, { type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ModeusAuthService } from './auth/ModeusAuthService';
import { ModeusService } from './api/ModeusService';
import { loadTokens, saveTokens } from './auth/tokenCache';
import { CalendarRepository } from './calendar/CalendarRepository';
import { ScheduleSyncService } from './calendar/ScheduleSyncService';
import { buildIcs } from './calendar/IcsBuilder';

const PORT    = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH = process.env['DB_PATH'] ?? './calendar.db';

// ─── Validation ───────────────────────────────────────────────────────────────

// Matches "Фамилия Имя Отчество" — 3 Cyrillic words, each capitalized.
// Allows hyphenated parts (Иванова-Петрова).
const FIO_RE = /^[А-ЯЁ][а-яё]+(-[А-ЯЁ][а-яё]+)? [А-ЯЁ][а-яё]+(-[А-ЯЁ][а-яё]+)? [А-ЯЁ][а-яё]+(-[А-ЯЁ][а-яё]+)?$/u;

function validateFio(fio: string): string | null {
  if (fio.length > 120) return 'ФИО слишком длинное';
  if (!FIO_RE.test(fio))  return 'Введите полное ФИО на кириллице (Фамилия Имя Отчество)';
  return null;
}

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

  // Trust X-Forwarded-* headers from Caddy / nginx reverse proxy.
  // Required for correct IP in rate limiter and correct protocol in URLs.
  app.set('trust proxy', 1);

  // Limit body size — prevents memory exhaustion from oversized payloads.
  app.use(express.json({ limit: '16kb' }));

  // ── Static frontend (React build) — only if built ────────────────────────────
  // In Docker, the frontend container (nginx) serves static files instead.
  const clientDist = path.join(__dirname, '../client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, {
      // Cache static assets for 1 year (they are content-hashed by Vite)
      maxAge: '1y',
      immutable: true,
      // Never cache index.html
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));
  }

  // ── Rate limiter: max 20 register requests per 15 min per IP ─────────────────
  const registerLimiter = rateLimit({
    windowMs:         15 * 60 * 1000,
    max:              20,
    standardHeaders:  'draft-7',
    legacyHeaders:    false,
    message:          { error: 'Слишком много запросов. Попробуйте через 15 минут.' },
  });

  // ── POST /api/calendar/register ──────────────────────────────────────────────
  app.post('/api/calendar/register', registerLimiter, (req: Request, res: Response) => {
    void (async () => {
      const raw = (req.body as { fio?: unknown }).fio;

      // Type guard — only accept strings
      if (typeof raw !== 'string') {
        res.status(400).json({ error: 'Поле "fio" должно быть строкой.' });
        return;
      }

      const fio = raw.trim();
      const validationError = validateFio(fio);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const { persons } = await modeus.searchPersons(fio, 5);

      if (persons.length === 0) {
        res.status(404).json({ error: `Человек не найден в Modeus.` });
        return;
      }

      const person = persons[0]!;
      const sub    = repo.createSubscription(person.fullName, person.id);

      // Sync in background — don't block the response
      void sync.syncOne(sub).catch((err: unknown) =>
        console.error('[Register] Фоновый sync упал:', err),
      );

      const host     = req.headers['host'] ?? `localhost:${PORT}`;
      const protocol = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
      const feedUrl  = `${protocol}://${host}/${sub.calendarToken}`;

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
  // Regex route prevents matching /api/*, /assets/*, etc.

  function serveIcs(token: string, res: Response): void {
    const sub = repo.findSubscriptionByToken(token);
    if (!sub) {
      res.status(404).send('Subscription not found');
      return;
    }
    const events = repo.getScheduleCache(sub.id);
    if (!events) {
      res.status(503).send('Schedule not yet synced, try again in a moment');
      return;
    }
    const ics = buildIcs(sub, events);
    // Explicit cache headers: calendar clients should re-fetch periodically
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="schedule-${token.slice(0, 8)}.ics"`);
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(ics);
  }

  app.get(/^\/([0-9a-f]{48})(\.ics)?$/i, (req: Request, res: Response) => {
    // In Express 5, unnamed regex capture groups come in req.params[0], [1], etc.
    const params = req.params as Record<string, string>;
    serveIcs(params[0] ?? '', res);
  });

  // ── SPA fallback ─────────────────────────────────────────────────────────────
  // Only active when client/dist exists (non-Docker / single-process mode).
  if (existsSync(clientDist)) {
    app.use((_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // ─── Start ───────────────────────────────────────────────────────────────────
  sync.start();

  app.listen(PORT, () => {
    console.log(`[Server] Listening on http://localhost:${PORT}`);
  });
}

main().catch((err: unknown) => {
  console.error('Startup error:', err);
  process.exit(1);
});
