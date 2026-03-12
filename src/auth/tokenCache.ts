import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const CACHE_FILE = join(process.cwd(), '.tokens.json');

export interface TokenCache {
  idToken: string;
  bearerToken: string;
}

export function saveTokens(idToken: string, bearerToken: string): void {
  const cache: TokenCache = { idToken, bearerToken };
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  console.log('[TokenCache] Токены сохранены.');
}

/**
 * Загружает токены из файла и проверяет, не истёк ли id_token по полю exp в JWT.
 * Возвращает null если файл не найден или токен просрочен.
 */
export function loadTokens(): TokenCache | null {
  if (!existsSync(CACHE_FILE)) return null;

  try {
    const cache: TokenCache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));

    const payload = JSON.parse(
      Buffer.from(cache.idToken.split('.')[1], 'base64url').toString(),
    ) as { exp: number };

    const expiresIn = payload.exp - Math.floor(Date.now() / 1000);

    if (expiresIn <= 60) {
      console.log('[TokenCache] Токен истёк, нужен повторный логин.');
      return null;
    }

    console.log(`[TokenCache] Токен действителен ещё ${Math.round(expiresIn / 60)} мин.`);
    return cache;
  } catch {
    return null;
  }
}
