import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CookieJar } from 'tough-cookie';

const CACHE_FILE = join(process.cwd(), '.tokens.json');

export interface TokenCache {
  idToken: string;
  bearerToken: string;
  cookies: ReturnType<CookieJar['serializeSync']>;
}

export async function saveTokens(
  idToken: string,
  bearerToken: string,
  jar: CookieJar,
): Promise<void> {
  const cookies = jar.serializeSync();
  const cache: TokenCache = { idToken, bearerToken, cookies };
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  console.log('[TokenCache] Токены и куки сохранены.');
}

/**
 * Загружает токены и куки из файла.
 * Возвращает null если файл не найден или JWT просрочен.
 */
export function loadTokens(): { cache: TokenCache; jar: CookieJar } | null {
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

    const jar = CookieJar.deserializeSync(cache.cookies!);
    console.log(`[TokenCache] Токен действителен ещё ${Math.round(expiresIn / 60)} мин.`);
    return { cache, jar };
  } catch {
    return null;
  }
}
