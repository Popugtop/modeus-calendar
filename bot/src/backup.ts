import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import cron from 'node-cron';

export interface BackupInfo {
  filename: string;
  fullPath: string;
  date:     Date;
  sizeKb:   number;
}

const MAX_KEEP      = 30;
const BACKUP_PREFIX = 'backup_';

export class BackupService {
  readonly backupDir: string;
  private cronTask: ReturnType<typeof cron.schedule> | null = null;

  constructor(private readonly dbPath: string) {
    this.backupDir = path.join(path.dirname(dbPath), 'backups');
    mkdirSync(this.backupDir, { recursive: true });
  }

  /** Creates a timestamped backup using SQLite Online Backup API. */
  async create(): Promise<BackupInfo> {
    const now  = new Date();
    const pad  = (n: number) => String(n).padStart(2, '0');
    const stamp = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
    ].join('') + '_' + [
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join('');

    const filename = `${BACKUP_PREFIX}${stamp}.db`;
    const dest     = path.join(this.backupDir, filename);

    // SQLite Online Backup API — safe even with concurrent readers/writers
    const src = new Database(this.dbPath, { readonly: true });
    try {
      await src.backup(dest);
    } finally {
      src.close();
    }

    console.log(`[Backup] Создан: ${filename}`);
    this.prune();
    return this.stat(filename);
  }

  /** All backups, newest first. */
  list(): BackupInfo[] {
    if (!existsSync(this.backupDir)) return [];
    return readdirSync(this.backupDir)
      .filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith('.db'))
      .map(f => this.stat(f))
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  /** Restores the main DB from a backup file. */
  async restore(filename: string): Promise<void> {
    const src = path.join(this.backupDir, filename);
    if (!existsSync(src)) throw new Error(`Файл не найден: ${filename}`);

    const backupDb = new Database(src, { readonly: true });
    try {
      await backupDb.backup(this.dbPath);
    } finally {
      backupDb.close();
    }
    console.log(`[Backup] Восстановлен из: ${filename}`);
  }

  delete(filename: string): boolean {
    const p = path.join(this.backupDir, filename);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  }

  /** Starts (or replaces) the automatic backup cron. Empty string = disable. */
  startSchedule(cronExpr: string): void {
    this.cronTask?.stop();
    this.cronTask = null;
    if (!cronExpr) {
      console.log('[Backup] Авторасписание отключено.');
      return;
    }
    this.cronTask = cron.schedule(cronExpr, () => {
      void this.create().catch(err =>
        console.error('[Backup] Авто-бэкап не выполнен:', err),
      );
    });
    console.log(`[Backup] Авторасписание: "${cronExpr}"`);
  }

  /** Human-readable label for a backup (parsed from filename). */
  static label(info: BackupInfo): string {
    // filename: backup_20260312_020000.db
    const m = info.filename.match(/^backup_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.db$/);
    if (!m) return info.filename;
    const [, y, mo, d, h, mi] = m;
    return `${d}.${mo}.${y} ${h}:${mi} · ${info.sizeKb} KB`;
  }

  private stat(filename: string): BackupInfo {
    const fullPath = path.join(this.backupDir, filename);
    const s        = statSync(fullPath);
    return { filename, fullPath, date: s.mtime, sizeKb: Math.round(s.size / 1024) };
  }

  private prune(): void {
    this.list().slice(MAX_KEEP).forEach(b => {
      try { unlinkSync(b.fullPath); } catch { /* ignore */ }
    });
  }
}
