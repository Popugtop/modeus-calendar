import 'dotenv/config';
import { ModeusAuthService } from './auth/ModeusAuthService';
import { loadTokens, saveTokens } from './auth/tokenCache';

async function main(): Promise<void> {
  const username = process.env['MODEUS_USERNAME'];
  const password = process.env['MODEUS_PASSWORD'];

  if (!username || !password) {
    throw new Error('Укажите MODEUS_USERNAME и MODEUS_PASSWORD в .env');
  }

  const auth = new ModeusAuthService(username, password);

  const cached = loadTokens();
  if (cached) {
    auth.idToken     = cached.idToken;
    auth.bearerToken = cached.bearerToken;
  } else {
    await auth.login();
    saveTokens(auth.idToken!, auth.bearerToken!);
  }

  console.log(`\nid_token:     ${auth.idToken?.slice(0, 60)}...`);
  console.log(`bearer_token: ${auth.bearerToken}`);
  console.log(`\nГотово. Токен сохранён в .tokens.json`);
}

main().catch((err: unknown) => {
  console.error('Ошибка:', err);
  process.exit(1);
});
