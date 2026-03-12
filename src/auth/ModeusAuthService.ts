import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { randomBytes } from 'crypto';

/**
 * Реальный SSO-флоу utmn.modeus.org (по данным HAR-анализа):
 *
 *  Auth-сервер: auth.modeus.org (WSO2 Identity Server, НЕ Keycloak)
 *  Flow: OAuth2 Implicit (response_type=id_token token)
 *
 *  1. GET  auth.modeus.org/oauth2/authorize?response_type=id_token+token&client_id=...
 *          → 302 цепочка → fs.utmn.ru/adfs/ls?SAMLRequest=...  (ADFS login page)
 *
 *  2. GET  fs.utmn.ru/adfs/ls?SAMLRequest=...
 *          → 200  HTML-форма с hidden-полями (AuthState, CSRF и т.д.)
 *
 *  3. POST fs.utmn.ru/adfs/ls  (UserName + Password + hidden fields)
 *          → 200  HTML с формой авто-сабмита (SAMLResponse + RelayState)
 *
 *  4. POST https://auth.modeus.org/commonauth  (SAMLResponse + RelayState)
 *          → 302 → auth.modeus.org/oauth2/authorize?sessionDataKey=...
 *
 *  5. GET  auth.modeus.org/oauth2/authorize?sessionDataKey=...
 *          → 302 → redirect_uri#access_token=UUID&id_token=JWT&...
 *          ↑ СТОП — токен в URL-фрагменте Location заголовка (не тело, не куки)
 *
 *  Ключевой момент: после шага 4 мы следим за редиректами ВРУЧНУЮ,
 *  чтобы поймать Location с фрагментом (#access_token=...) до того,
 *  как axios уйдёт на SPA и потеряет его.
 */

const AUTH_SERVER     = 'https://auth.modeus.org';
const OAUTH_AUTH_URL  = `${AUTH_SERVER}/oauth2/authorize`;
const SAML_AUTH_URL   = `${AUTH_SERVER}/commonauth`;
const CLIENT_ID       = 'sKir7YQnOUu4G0eCfn3tTxnBfzca';
const REDIRECT_URI    = 'https://utmn.modeus.org/schedule-calendar/my';
const MODEUS_ORIGIN   = 'https://utmn.modeus.org';

/** axios-опции для ручного шага редиректа */
const MANUAL = {
  maxRedirects: 0,
  validateStatus: (s: number) => s >= 100 && s < 400,
};

export class ModeusAuthService {
  public bearerToken: string | null = null;
  public idToken:     string | null = null;

  public get cookieJar(): CookieJar { return this.jar; }

  private readonly jar:  CookieJar;
  private readonly http: AxiosInstance;
  private readonly username: string;
  private readonly password: string;

  constructor(username: string, password: string, jar?: CookieJar) {
    this.username = username;
    this.password = password;

    this.jar = jar ?? new CookieJar();

    this.http = wrapper(
      axios.create({
        jar: this.jar,
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
        validateStatus: (s) => s < 500,
      }),
    );
  }

  /** Возвращает axios-инстанс с Bearer + CookieJar для ModeusService */
  public getApiClient(): AxiosInstance {
    // API принимает id_token (JWT), а не access_token (UUID)
    const token = this.idToken ?? this.bearerToken;
    if (!token) {
      throw new Error('Не авторизован. Сначала вызовите login().');
    }

    return wrapper(
      axios.create({
        jar: this.jar,
        withCredentials: true,
        baseURL: MODEUS_ORIGIN,
        headers: {
          // Некоторые эндпоинты принимают Bearer, некоторые только куки.
          // Отправляем оба варианта — лишнее сервер проигнорирует.
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          Origin: MODEUS_ORIGIN,
          Referer: `${MODEUS_ORIGIN}/`,
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/145.0.0.0 Safari/537.36',
        },
        validateStatus: (s) => s < 500,
      }),
    );
  }

  /**
   * Полный флоу: OAuth2 Implicit + SAML ADFS.
   * После успешного выполнения: this.bearerToken = access_token (UUID)
   */
  public async login(): Promise<void> {
    // nonce — защита от replay-атак, случайная строка
    const nonce = randomBytes(20).toString('hex');
    const state = randomBytes(20).toString('hex');

    // ── Шаг 1: Инициируем OAuth2 Implicit flow ────────────────────────────────
    // auth.modeus.org получит запрос и сделает SAML AuthnRequest к ADFS.
    // axios проследует всю 302-цепочку и остановится на HTML-форме ADFS.
    const oauthUrl = `${OAUTH_AUTH_URL}?${new URLSearchParams({
      response_type: 'id_token token',
      client_id:     CLIENT_ID,
      redirect_uri:  REDIRECT_URI,
      scope:         'openid',
      nonce,
      state,
    })}`;

    console.log('[Auth] Шаг 1: OAuth2 Implicit → auth.modeus.org → ADFS...');
    const loginPageRes = await this.http.get(oauthUrl, { maxRedirects: 20 });
    const loginPageHtml: string = loginPageRes.data;
    const loginActionUrl: string =
      loginPageRes.request?.res?.responseUrl ?? oauthUrl;

    console.log(`[Auth] Страница логина: ${loginActionUrl}`);

    // ── Шаг 2: Парсим hidden-поля ADFS-формы ─────────────────────────────────
    const hiddenFields = this.parseHiddenFields(loginPageHtml);
    console.log(`[Auth] Шаг 2: Найдено скрытых полей: ${Object.keys(hiddenFields).length}`);

    if (Object.keys(hiddenFields).length === 0) {
      console.error('[Auth] Получен HTML (первые 500 симв.):', loginPageHtml.slice(0, 500));
      throw new Error(
        '[Auth] Форма ADFS не найдена. ' +
        `Финальный URL: ${loginActionUrl}`,
      );
    }

    // ── Шаг 3: POST кредeнциалов на ADFS ─────────────────────────────────────
    const formBody = new URLSearchParams({
      ...hiddenFields,
      UserName:   this.username,
      Password:   this.password,
      AuthMethod: 'FormsAuthentication',
    });

    console.log('[Auth] Шаг 3: Отправляем логин/пароль на ADFS...');
    // Разрешаем ADFS пройти свои внутренние 302-редиректы (пост → confirm → SAMLResponse).
    // Финальная страница должна содержать SAMLResponse-форму.
    const credsRes = await this.http.post(loginActionUrl, formBody.toString(), {
      maxRedirects: 10,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const credsHtml: string = typeof credsRes.data === 'string' ? credsRes.data : '';
    const credsFinalUrl: string = credsRes.request?.res?.responseUrl ?? loginActionUrl;

    // ── Шаг 4: Ищем SAMLResponse в ответе ────────────────────────────────────
    const samlHtml = await this.findSamlResponse(credsHtml, credsFinalUrl);

    // Парсим SAML-форму
    const $ = cheerio.load(samlHtml);
    const samlActionUrl = $('form').attr('action') ?? SAML_AUTH_URL;
    const samlFields    = this.parseHiddenFields(samlHtml);

    console.log(`[Auth] Шаг 4: Отправляем SAMLResponse → ${samlActionUrl}`);
    const samlRes = await this.http.post(
      samlActionUrl,
      new URLSearchParams(samlFields).toString(),
      {
        ...MANUAL,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://fs.utmn.ru/',
        },
      },
    );

    const samlLocation = samlRes.headers['location'] as string | undefined;
    if (!samlLocation) {
      throw new Error(`[Auth] commonauth не вернул Location (HTTP ${samlRes.status}).`);
    }

    // ── Шаг 5: Следим за редиректами вручную, ловим фрагмент ─────────────────
    console.log('[Auth] Шаг 5: Следуем за редиректами до access_token...');
    return this.followUntilFragment(
      samlLocation.startsWith('http')
        ? samlLocation
        : new URL(samlLocation, AUTH_SERVER).toString(),
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Приватные методы
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Ищет SAMLResponse в HTML-ответе после POST кредeнциалов.
   * ADFS может вернуть его сразу (200) или после одного-двух GET-редиректов.
   * Если в HTML есть форма входа снова — значит неверный пароль.
   */
  private async findSamlResponse(html: string, finalUrl: string): Promise<string> {
    if (html.includes('SAMLResponse')) {
      console.log('[Auth] Шаг 4: SAMLResponse найден в ответе.');
      return html;
    }

    // Неверный пароль: ADFS вернул форму логина снова
    if (html.includes('name="Password"') || html.includes('id="passwordInput"')) {
      throw new Error('[Auth] Неверный логин или пароль.');
    }

    // ADFS иногда делает ещё один GET после POST (PRG-паттерн).
    // Пробуем дополнительный GET на финальный URL.
    if (finalUrl && finalUrl.includes('fs.utmn.ru')) {
      console.log('[Auth] SAMLResponse не найден сразу, пробуем GET финального URL...');
      const followRes = await this.http.get(finalUrl, { maxRedirects: 5 });
      const followHtml: string = typeof followRes.data === 'string' ? followRes.data : '';

      if (followHtml.includes('SAMLResponse')) {
        return followHtml;
      }

      if (followHtml.includes('name="Password"') || followHtml.includes('id="passwordInput"')) {
        throw new Error('[Auth] Неверный логин или пароль.');
      }
    }

    throw new Error(
      `[Auth] SAMLResponse не найден после POST кредeнциалов. ` +
      `Финальный URL: ${finalUrl}\n` +
      `HTML (первые 300 симв.): ${html.slice(0, 300)}`,
    );
  }

  /**
   * Вручную следует по 302-цепочке, пока не найдёт #access_token= в Location.
   *
   * Это критически важно: HTTP-фрагменты (#...) НЕ отправляются браузером
   * на сервер, но они ПРИСУТСТВУЮТ в Location-заголовке 302-ответа.
   * axios с maxRedirects>0 ушёл бы на SPA и потерял фрагмент с токеном.
   */
  private async followUntilFragment(startUrl: string, maxSteps = 15): Promise<void> {
    let url = startUrl;

    for (let i = 0; i < maxSteps; i++) {
      // Проверяем текущий URL на наличие фрагмента с токеном
      const tokens = this.extractTokensFromFragment(url);
      if (tokens) {
        this.bearerToken = tokens.accessToken;
        this.idToken     = tokens.idToken;
        return;
      }

      const res = await this.http.get(url, MANUAL);

      // Проверяем Location заголовок нового редиректа
      const location = res.headers['location'] as string | undefined;

      if (!location) {
        // Нет редиректа — финальный ответ
        const finalUrl: string = res.request?.res?.responseUrl ?? url;
        const finalTokens = this.extractTokensFromFragment(finalUrl);
        if (finalTokens) {
          this.bearerToken = finalTokens.accessToken;
          this.idToken     = finalTokens.idToken;
          return;
        }
        throw new Error(`[Auth] Редиректы закончились без токена. URL: ${finalUrl}`);
      }

      // Абсолютный URL
      url = location.startsWith('http')
        ? location
        : new URL(location, AUTH_SERVER).toString();
    }

    throw new Error('[Auth] Превышено число шагов редиректа при поиске токена.');
  }

  /**
   * Извлекает access_token и id_token из URL-фрагмента вида:
   * https://utmn.modeus.org/...#access_token=UUID&id_token=JWT&...
   */
  private extractTokensFromFragment(
    url: string,
  ): { accessToken: string; idToken: string | null } | null {
    const hashIndex = url.indexOf('#');
    if (hashIndex === -1) return null;

    const fragment = url.slice(hashIndex + 1);
    const params   = new URLSearchParams(fragment);
    const accessToken = params.get('access_token');

    if (!accessToken) return null;

    return {
      accessToken,
      idToken: params.get('id_token'),
    };
  }

  /**
   * Парсит все <input type="hidden"> из HTML и возвращает объект {name: value}.
   */
  private parseHiddenFields(html: string): Record<string, string> {
    const $ = cheerio.load(html);
    const fields: Record<string, string> = {};

    $('input[type="hidden"]').each((_i, el) => {
      const name  = $(el).attr('name');
      const value = $(el).attr('value') ?? '';
      if (name) fields[name] = value;
    });

    return fields;
  }
}
