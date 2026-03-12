import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import type {
  ApplyModuleBody,
  ApplyModuleResponse,
  CancelModuleBody,
  EventAttendee,
  EventDetails,
  EventLocation,
  ModulesResponse,
  PerformanceResponse,
  Person,
  PersonSearchResponse,
  PersonsResponse,
  ScheduleRequestBody,
  ScheduleResponse,
  SelectionsResponse,
  StudentInfo,
} from '../types';
import type { ModeusAuthService } from '../auth/ModeusAuthService';

export class ModeusService {
  private readonly client: AxiosInstance;

  /**
   * Принимает либо готовый ModeusAuthService (после login()),
   * либо raw Bearer-токен — для гибкости.
   */
  constructor(auth: ModeusAuthService | string) {
    if (typeof auth === 'string') {
      // raw-токен: создаём простой клиент без jar (куки уже не нужны)
      this.client = axios.create({
        baseURL: 'https://utmn.modeus.org',
        headers: {
          Authorization: `Bearer ${auth}`,
          'Content-Type': 'application/json',
        },
      });
    } else {
      // Берём уже настроенный клиент из ModeusAuthService (с jar и токеном)
      this.client = auth.getApiClient();
    }
  }

  // ─── Расписание ─────────────────────────────────────────────────────────────

  /**
   * Получить расписание студента(-ов) за заданный период.
   *
   * @param body.attendeePersonId  UUID студента (можно несколько)
   * @param body.timeMin           Начало периода (ISO-8601)
   * @param body.timeMax           Конец периода (ISO-8601)
   * @param body.size              Максимальное число событий в ответе
   */
  async getSchedule(body: ScheduleRequestBody): Promise<ScheduleResponse> {
    const res = await this.client.post<ScheduleResponse>(
      `/schedule-calendar-v2/api/calendar/events/search?tz=Asia%2FTyumen`,
      body,
    );
    this.assertOk(res.status, 'getSchedule');
    return res.data;
  }

  /**
   * Поиск людей по ФИО (или части).
   * Возвращает persons + students с информацией о специальности.
   */
  async searchPersons(fullName: string, size = 10): Promise<{ persons: Person[]; students: StudentInfo[] }> {
    const res = await this.client.post<PersonSearchResponse>(
      '/schedule-calendar-v2/api/people/persons/search',
      { fullName, sort: '+fullName', size, page: 0 },
    );
    this.assertOk(res.status, 'searchPersons');
    return {
      persons:  res.data._embedded?.persons  ?? [],
      students: res.data._embedded?.students ?? [],
    };
  }

  async getEventLocation(eventId: string): Promise<EventLocation> {
    const res = await this.client.get<EventLocation>(
      `/schedule-calendar-v2/api/calendar/events/${eventId}/location`,
    );
    this.assertOk(res.status, 'getEventLocation');
    return res.data;
  }

  async getEventAttendees(eventId: string): Promise<EventAttendee[]> {
    const res = await this.client.get<EventAttendee[]>(
      `/schedule-calendar-v2/api/calendar/events/${eventId}/attendees`,
    );
    this.assertOk(res.status, 'getEventAttendees');
    return res.data;
  }

  /**
   * Детальная информация о конкретном занятии.
   */
  async getEvent(eventId: string): Promise<EventDetails> {
    const res = await this.client.get<EventDetails>(
      `/schedule-app/api/events/${eventId}`,
    );
    this.assertOk(res.status, 'getEvent');
    return res.data;
  }

  /**
   * Список участников (преподавателей и студентов) конкретного занятия.
   */
  async getEventPersons(eventId: string): Promise<PersonsResponse> {
    const res = await this.client.get<PersonsResponse>(
      `/people-app/api/persons`,
      { params: { eventId } },
    );
    this.assertOk(res.status, 'getEventPersons');
    return res.data;
  }

  // ─── Оценки / Успеваемость ──────────────────────────────────────────────────

  /**
   * Успеваемость текущего студента (ID определяется сервером по токену).
   */
  async getMyPerformance(): Promise<PerformanceResponse> {
    const res = await this.client.get<PerformanceResponse>(
      '/journals-app/api/v1/journals/students/me/performance',
    );
    this.assertOk(res.status, 'getMyPerformance');
    return res.data;
  }

  // ─── Выбор элективов (choice-app) ───────────────────────────────────────────

  /**
   * Список активных кампаний выбора для текущего студента.
   * Возвращает массив selections, каждый со своим id.
   */
  async getActiveSelections(): Promise<SelectionsResponse> {
    const res = await this.client.get<SelectionsResponse>(
      '/choice-app/api/v2/students/me/selections/active',
    );
    this.assertOk(res.status, 'getActiveSelections');
    return res.data;
  }

  /**
   * Список модулей (предметов/секций), доступных для выбора в данной кампании.
   * Ответ включает поля capacity (мест всего) и enrolledCount (уже записано).
   */
  async getSelectionModules(selectionId: string): Promise<ModulesResponse> {
    const res = await this.client.get<ModulesResponse>(
      `/choice-app/api/v2/selections/${selectionId}/modules`,
    );
    this.assertOk(res.status, 'getSelectionModules');
    return res.data;
  }

  /**
   * Записаться на модуль в кампании выбора.
   *
   * Перед отправкой POST-запроса проверяет наличие свободных мест:
   * enrolledCount < capacity. Если мест нет — бросает ошибку без запроса к API.
   *
   * @param selectionId  ID кампании
   * @param moduleId     ID модуля
   * @param priority     Приоритет (1 = первый)
   */
  async applyForModule(
    selectionId: string,
    moduleId: string,
    priority: number = 1,
  ): Promise<ApplyModuleResponse> {
    // ── Предварительная проверка мест ────────────────────────────────────────
    const modulesResp = await this.getSelectionModules(selectionId);
    const module = modulesResp.data.find((m) => m.id === moduleId);

    if (!module) {
      throw new Error(
        `Модуль ${moduleId} не найден в кампании ${selectionId}.`,
      );
    }

    if (module.enrolledCount >= module.capacity) {
      throw new Error(
        `Нет свободных мест: модуль "${module.name}" ` +
        `(${module.enrolledCount}/${module.capacity}).`,
      );
    }

    // ── Отправляем заявку ─────────────────────────────────────────────────────
    const body: ApplyModuleBody = { moduleId, priority };
    const res = await this.client.post<ApplyModuleResponse>(
      `/choice-app/api/v2/selections/${selectionId}/apply`,
      body,
    );
    this.assertOk(res.status, 'applyForModule');
    return res.data;
  }

  /**
   * Отменить запись на модуль.
   */
  async cancelModule(
    selectionId: string,
    moduleId: string,
  ): Promise<void> {
    const body: CancelModuleBody = { moduleId };
    const res = await this.client.delete(
      `/choice-app/api/v2/selections/${selectionId}/cancel`,
      { data: body },
    );
    this.assertOk(res.status, 'cancelModule');
  }

  // ─── Вспомогательные методы ─────────────────────────────────────────────────

  private assertOk(status: number, method: string): void {
    if (status === 401) {
      throw new Error(`[${method}] Токен истёк или невалиден (401). Перелогиньтесь.`);
    }
    if (status === 403) {
      throw new Error(`[${method}] Доступ запрещён (403).`);
    }
    if (status === 404) {
      throw new Error(`[${method}] Ресурс не найден (404).`);
    }
    if (status >= 400) {
      throw new Error(`[${method}] Ошибка API: HTTP ${status}.`);
    }
  }
}
