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

const PORT             = parseInt(process.env['PORT'] ?? '3000', 10);
const DB_PATH          = process.env['DB_PATH'] ?? './calendar.db';
const INVITE_REQUIRED  = process.env['INVITE_REQUIRED'] !== 'false'; // default true
const INTERNAL_SECRET  = process.env['INTERNAL_SECRET'] ?? '';

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
      const body = req.body as {
        fio?: unknown;
        inviteCode?: unknown;
        personId?: unknown;
        personName?: unknown;
      };

      const host     = req.headers['host'] ?? `localhost:${PORT}`;
      const protocol = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;

      // ── Pre-selected person (from multiple-results flow) ──────────────────
      if (typeof body.personId === 'string' && typeof body.personName === 'string') {
        const personId   = body.personId.trim();
        const personName = body.personName.trim();
        const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';

        const existing = repo.findSubscriptionByPersonId(personId);

        if (existing) {
          res.status(409).json({ error: `Пользователь "${personName}" уже зарегистрирован.` });
          return;
        }

        if (INVITE_REQUIRED) {
          if (!inviteCode || !repo.isInviteCodeValid(inviteCode)) {
            res.status(403).json({ error: 'Неверный или уже использованный инвайт-код.' });
            return;
          }
        }

        const sub = repo.createSubscription(personName, personId);
        if (INVITE_REQUIRED && inviteCode) repo.useInviteCode(inviteCode, personName);
        void sync.syncOne(sub).catch((err: unknown) =>
          console.error('[Register] Фоновый sync упал:', err),
        );

        const feedUrl = `${protocol}://${host}/${sub.calendarToken}`;
        res.status(201).json({
          message: `Подписка создана для "${personName}".`,
          token: sub.calendarToken,
          url:   feedUrl,
        });
        return;
      }

      // ── FIO-based search ──────────────────────────────────────────────────
      const raw = body.fio;

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

      const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';

      const { persons, students } = await modeus.searchPersons(fio, 10);

      if (persons.length === 0) {
        res.status(404).json({ error: 'Человек не найден в Modeus.' });
        return;
      }

      // Multiple results — let user pick (don't validate invite yet)
      if (persons.length > 1) {
        const personList = persons.map(p => ({
          id:           p.id,
          fullName:     p.fullName,
          specialtyName: students.find(s => s.personId === p.id)?.specialtyName ?? null,
        }));
        res.status(200).json({ status: 'multiple', persons: personList });
        return;
      }

      const person   = persons[0]!;
      const existing = repo.findSubscriptionByPersonId(person.id);

      if (existing) {
        res.status(409).json({ error: `Пользователь "${person.fullName}" уже зарегистрирован.` });
        return;
      }

      if (INVITE_REQUIRED) {
        if (!inviteCode || !repo.isInviteCodeValid(inviteCode)) {
          res.status(403).json({ error: 'Неверный или уже использованный инвайт-код.' });
          return;
        }
      }

      const sub = repo.createSubscription(person.fullName, person.id);
      if (INVITE_REQUIRED && inviteCode) repo.useInviteCode(inviteCode, person.fullName);
      void sync.syncOne(sub).catch((err: unknown) =>
        console.error('[Register] Фоновый sync упал:', err),
      );

      const feedUrl = `${protocol}://${host}/${sub.calendarToken}`;
      res.status(201).json({
        message: `Подписка создана для "${person.fullName}".`,
        token: sub.calendarToken,
        url:   feedUrl,
      });
    })();
  });

  // ── POST /api/internal/register ──────────────────────────────────────────────
  app.post('/api/internal/register', (req: Request, res: Response) => {
    void (async () => {
      const secret = req.headers['x-internal-secret'];
      if (!secret || secret !== INTERNAL_SECRET) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const body = req.body as { fio?: string; personId?: string; personName?: string };

      const host     = req.headers['host'] ?? `localhost:${PORT}`;
      const protocol = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;

      // Direct registration by personId (from bot person selection)
      if (body.personId && body.personName) {
        const existing = repo.findSubscriptionByPersonId(body.personId);
        const sub = repo.createSubscription(body.personName, body.personId);
        if (!existing)
          void sync.syncOne(sub).catch((e: unknown) =>
            console.error('[Internal] sync failed:', e),
          );

        const feedUrl = `${protocol}://${host}/${sub.calendarToken}`;
        res.status(existing ? 200 : 201).json({
          message: existing
            ? `Подписка уже существует для "${body.personName}".`
            : `Подписка создана для "${body.personName}".`,
          token: sub.calendarToken,
          url:   feedUrl,
        });
        return;
      }

      // Search by FIO
      if (!body.fio || typeof body.fio !== 'string') {
        res.status(400).json({ error: 'Укажите fio или personId+personName.' });
        return;
      }

      const fio = body.fio.trim();
      const validationError = validateFio(fio);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }

      const { persons, students } = await modeus.searchPersons(fio, 10);

      if (persons.length === 0) {
        res.status(404).json({ error: 'Человек не найден в Modeus.' });
        return;
      }

      if (persons.length > 1) {
        const personList = persons.map(p => ({
          id:            p.id,
          fullName:      p.fullName,
          specialtyName: students.find(s => s.personId === p.id)?.specialtyName ?? null,
        }));
        res.status(200).json({ status: 'multiple', persons: personList });
        return;
      }

      const person   = persons[0]!;
      const existing = repo.findSubscriptionByPersonId(person.id);
      const sub      = repo.createSubscription(person.fullName, person.id);
      if (!existing)
        void sync.syncOne(sub).catch((e: unknown) =>
          console.error('[Internal] sync failed:', e),
        );

      const feedUrl = `${protocol}://${host}/${sub.calendarToken}`;
      res.status(existing ? 200 : 201).json({
        message: existing
          ? `Подписка уже существует для "${person.fullName}".`
          : `Подписка создана для "${person.fullName}".`,
        token: sub.calendarToken,
        url:   feedUrl,
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
