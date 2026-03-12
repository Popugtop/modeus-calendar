import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';

/**
 * SSO-флоу TюмГУ (fs.utmn.ru → utmn.modeus.org):
 *
 *  1. GET  https://utmn.modeus.org/
 *         → 302 → fs.utmn.ru/adfs/ls/?...  (ADFS login page)
 *
 *  2. GET  fs.utmn.ru/adfs/ls/?...
 *         → 200  HTML с формой: скрытые поля AuthState, __RequestVerificationToken и т.д.
 *
 *  3. POST fs.utmn.ru/adfs/ls/?...
 *         body: UserName + Password + скрытые поля
 *         → 200  HTML с SAMLResponse (форма авто-сабмит)
 *           или цепочка 302 с Set-Cookie
 *
 *  4. POST https://utmn.modeus.org/auth/realms/utmn/broker/adfs/endpoint
 *         body: SAMLResponse + RelayState
 *         → 302 → modeus с Set-Cookie: BEARER_TOKEN или аналог
 *
 *  5. Финальный GET → JSON или HTML, из которого достаём Bearer.
 *
 * axios-cookiejar-support + CookieJar автоматически сохраняют и отправляют куки
 * на каждом шаге. maxRedirects: 0 позволяет нам вручную управлять редиректами
 * там, где нужно вытащить промежуточные данные.
 */

/** URL первичной точки входа в Modeus, с которой стартует SSO */
const MODEUS_ORIGIN = 'https://utmn.modeus.org';
const SSO_ENTRY = `${MODEUS_ORIGIN}/`;

export class ModeusAuthService {
  /** Итоговый Bearer-токен; устанавливается после успешного login() */
  public bearerToken: string | null = null;

  private readonly jar: CookieJar;
  private readonly client: AxiosInstance;
  private readonly username: string;
  private readonly password: string;

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;

    // CookieJar — хранилище кук, которое tough-cookie автоматически
    // применяет ко всем запросам через axios-cookiejar-support.
    this.jar = new CookieJar();

    // wrapper() патчит инстанс axios, добавляя поддержку jar.
    this.client = wrapper(
      axios.create({
        jar: this.jar,
        // Следовать редиректам автоматически; куки сохраняются в jar на каждом шаге.
        maxRedirects: 20,
        withCredentials: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/124.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8',
        },
        // Не бросать исключение на 3xx/4xx — обрабатываем сами там, где нужно.
        validateStatus: (status) => status < 500,
      }),
    );
  }

  /** Возвращает AxiosInstance с Bearer-токеном для использования в ModeusService */
  public getApiClient(): AxiosInstance {
    if (!this.bearerToken) {
      throw new Error('Не авторизован. Сначала вызовите login().');
    }
    return wrapper(
      axios.create({
        jar: this.jar,
        withCredentials: true,
        baseURL: MODEUS_ORIGIN,
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/124.0.0.0 Safari/537.36',
        },
        validateStatus: (status) => status < 500,
      }),
    );
  }

  /**
   * Полный SSO-флоу. После успешного выполнения this.bearerToken будет установлен.
   */
  public async login(): Promise<void> {
    // ── Шаг 1: GET стартового URL Modeus ─────────────────────────────────────
    // axios проследит все 302-редиректы и в итоге вернёт HTML страницы логина ADFS.
    // CookieJar соберёт все Set-Cookie по пути.
    console.log('[Auth] Шаг 1: Открываем страницу входа...');
    const loginPageResponse = await this.client.get(SSO_ENTRY);
    const loginPageHtml: string = loginPageResponse.data;

    // Финальный URL после редиректов — нужен для корректного POST
    const loginActionUrl: string =
      loginPageResponse.request?.res?.responseUrl ?? SSO_ENTRY;

    console.log(`[Auth] Страница логина получена: ${loginActionUrl}`);

    // ── Шаг 2: Парсим скрытые поля формы ─────────────────────────────────────
    const hiddenFields = this.parseHiddenFields(loginPageHtml);
    console.log(
      `[Auth] Шаг 2: Найдено скрытых полей: ${Object.keys(hiddenFields).length}`,
    );

    // ── Шаг 3: POST с кредами + скрытыми полями ───────────────────────────────
    // ADFS ожидает application/x-www-form-urlencoded.
    const formBody = new URLSearchParams({
      ...hiddenFields,
      UserName: this.username,
      Password: this.password,
      AuthMethod: 'FormsAuthentication',
    });

    console.log('[Auth] Шаг 3: Отправляем логин...');
    const postResponse = await this.client.post(loginActionUrl, formBody.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const postHtml: string = postResponse.data;
    const postFinalUrl: string =
      postResponse.request?.res?.responseUrl ?? loginActionUrl;

    // ── Шаг 4: Проверяем результат ────────────────────────────────────────────
    // Вариант A: ADFS вернул SAMLResponse (форма авто-сабмит → Modeus)
    if (postHtml.includes('SAMLResponse')) {
      console.log('[Auth] Шаг 4a: Найден SAMLResponse — отправляем в Modeus...');
      await this.submitSamlResponse(postHtml);
      return;
    }

    // Вариант B: Мы уже на Modeus и токен в URL или в куках
    const tokenFromUrl = this.extractTokenFromUrl(postFinalUrl);
    if (tokenFromUrl) {
      this.bearerToken = tokenFromUrl;
      console.log('[Auth] Токен извлечён из URL финального редиректа.');
      return;
    }

    // Вариант C: Токен в куках (некоторые конфигурации ADFS)
    const tokenFromCookie = await this.extractTokenFromCookies();
    if (tokenFromCookie) {
      this.bearerToken = tokenFromCookie;
      console.log('[Auth] Токен извлечён из кук.');
      return;
    }

    // Вариант D: Токен возвращается JSON'ом при финальном GET /api/auth/current
    const tokenFromApi = await this.fetchTokenFromApi();
    if (tokenFromApi) {
      this.bearerToken = tokenFromApi;
      console.log('[Auth] Токен получен через /api/auth/current.');
      return;
    }

    throw new Error(
      '[Auth] Не удалось извлечь Bearer-токен. ' +
      'Проверьте логин/пароль и структуру SSO-флоу.',
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Приватные методы
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Парсит все <input type="hidden"> из HTML формы и возвращает объект key→value.
   * Cheerio позволяет работать с DOM без браузера, как jQuery на сервере.
   */
  private parseHiddenFields(html: string): Record<string, string> {
    const $ = cheerio.load(html);
    const fields: Record<string, string> = {};

    $('input[type="hidden"]').each((_i, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') ?? '';
      if (name) fields[name] = value;
    });

    return fields;
  }

  /**
   * Шаг 4a: После POST на ADFS мы получаем HTML со скрытой формой,
   * которая содержит SAMLResponse и RelayState. Браузер авто-сабмитит её.
   * Мы делаем это вручную через POST на action-URL формы.
   */
  private async submitSamlResponse(html: string): Promise<void> {
    const $ = cheerio.load(html);
    const form = $('form');
    const actionUrl = form.attr('action') ?? `${MODEUS_ORIGIN}/auth/realms/utmn/broker/adfs/endpoint`;

    const samlFields = this.parseHiddenFields(html);
    const samlBody = new URLSearchParams(samlFields);

    console.log(`[Auth] SAML POST → ${actionUrl}`);
    const samlResponse = await this.client.post(actionUrl, samlBody.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const samlFinalUrl: string =
      samlResponse.request?.res?.responseUrl ?? actionUrl;

    // После SAML-обмена Modeus обычно делает ещё один редирект с токеном в URL
    const tokenFromUrl = this.extractTokenFromUrl(samlFinalUrl);
    if (tokenFromUrl) {
      this.bearerToken = tokenFromUrl;
      return;
    }

    // Или кладёт его в куки
    const tokenFromCookie = await this.extractTokenFromCookies();
    if (tokenFromCookie) {
      this.bearerToken = tokenFromCookie;
      return;
    }

    // Или JSON в теле ответа (редко, но бывает)
    if (typeof samlResponse.data === 'object' && samlResponse.data?.token) {
      this.bearerToken = samlResponse.data.token as string;
      return;
    }

    // Последний шанс — дёрнуть /api/auth/current
    const tokenFromApi = await this.fetchTokenFromApi();
    if (tokenFromApi) {
      this.bearerToken = tokenFromApi;
      return;
    }

    throw new Error('[Auth] SAML-обмен завершён, но токен не найден.');
  }

  /**
   * Некоторые реализации Modeus возвращают JWT в параметре `token` финального URL
   * вида: https://utmn.modeus.org/#token=eyJ...
   */
  private extractTokenFromUrl(url: string): string | null {
    // Проверяем fragment (#token=...) и query (?token=...)
    const patterns = [/#token=([^&]+)/, /[?&]token=([^&]+)/];
    for (const re of patterns) {
      const match = re.exec(url);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    return null;
  }

  /**
   * Ищем токен в куках, которые Modeus мог установить как access_token / jwt / bearer.
   * CookieJar.getcookies() возвращает все куки для домена.
   */
  private async extractTokenFromCookies(): Promise<string | null> {
    const cookies = await this.jar.getCookies(MODEUS_ORIGIN);
    const tokenCookieNames = ['access_token', 'jwt', 'bearer', 'token', 'id_token'];

    for (const cookie of cookies) {
      if (tokenCookieNames.includes(cookie.key.toLowerCase())) {
        return cookie.value;
      }
    }
    return null;
  }

  /**
   * Финальный запрос: некоторые версии Modeus отдают токен через специальный эндпоинт.
   * Если он недоступен — просто возвращаем null.
   */
  private async fetchTokenFromApi(): Promise<string | null> {
    try {
      const res = await this.client.get(`${MODEUS_ORIGIN}/api/auth/current`, {
        validateStatus: (s) => s < 500,
      });
      if (res.status === 200 && res.data?.token) {
        return res.data.token as string;
      }
      // Также проверяем заголовок Authorization в ответе (нестандартно, но встречается)
      const authHeader = res.headers['authorization'] as string | undefined;
      if (authHeader?.startsWith('Bearer ')) {
        return authHeader.slice(7);
      }
    } catch {
      // Эндпоинт не существует — это нормально
    }
    return null;
  }
}
