// ─── Schedule ────────────────────────────────────────────────────────────────

export interface ScheduleRequestBody {
  size: number;
  timeMin: string; // ISO-8601 UTC, e.g. "2026-03-08T19:00:00Z"
  timeMax: string;
  attendeePersonId: string[];
}

export interface ScheduleEvent {
  id: string;
  name: string;
  nameShort?: string;
  typeId?: string;        // "LECT" | "SEMI" | "LAB" | "CUR_CHECK" | ...
  start: string;
  end: string;
  startsAtLocal: string;  // "2026-03-10T21:00:00" — без зоны
  endsAtLocal: string;
  holdingStatus?: { id: string; name: string } | null;
  _links?: Record<string, { href: string }>;
  [key: string]: unknown;
}

export interface ScheduleResponse {
  _embedded: { events: ScheduleEvent[] };
}

// ─── Person search ───────────────────────────────────────────────────────────

export interface PersonSearchBody {
  fullName: string;
  sort: string;
  size: number;
  page: number;
}

export interface Person {
  id: string;
  fullName: string;
  lastName: string;
  firstName: string;
  middleName?: string | null;
}

export interface StudentInfo {
  id: string;
  personId: string;
  specialtyName?: string;
  specialtyProfile?: string;
  flowCode?: string;
}

export interface PersonSearchResponse {
  _embedded: {
    persons: Person[];
    students: StudentInfo[];
  };
}

// Детали события — загружаются отдельными запросами
export interface EventLocation {
  customLocation?: string;        // онлайн / произвольный зал
  _embedded?: {
    rooms?: Array<{
      id: string;
      name: string;
      building?: { id: string; name: string };
    }>;
  };
}

export interface EventAttendee {
  id: string;
  roleId: string;         // "STUDENT" | "TEACH"
  fullName: string;
  lastName: string;
  firstName: string;
  middleName?: string | null;
}

// ─── Event details ────────────────────────────────────────────────────────────

export interface EventDetails {
  id: string;
  name: string;
  startDateLocal: string;
  endDateLocal: string;
  typeId?: string;
  typeName?: string;
  courseUnitId?: string;
  courseUnitName?: string;
  locationId?: string;
  locationName?: string;
  teams?: EventTeam[];
}

export interface EventTeam {
  id: string;
  name: string;
}

// ─── Persons ─────────────────────────────────────────────────────────────────

export interface Person {
  id: string;
  fullName: string;
  email?: string;
  role?: string; // "STUDENT" | "TEACHER" | ...
}

export interface PersonsResponse {
  total: number;
  data: {
    persons: Record<string, Person>;
  };
}

// ─── Performance / Grades ─────────────────────────────────────────────────────

export interface GradeResult {
  moduleId: string;
  moduleName: string;
  gradeValue?: string | number;
  gradeDate?: string;
  passed?: boolean;
}

export interface PerformanceResponse {
  data: GradeResult[];
}

// ─── Choice-app: Selections ───────────────────────────────────────────────────

export interface Selection {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
  status?: string;
}

export interface SelectionsResponse {
  data: Selection[];
}

// ─── Choice-app: Modules ──────────────────────────────────────────────────────

export interface Module {
  id: string;
  name: string;
  description?: string;
  capacity: number;        // максимальное число мест
  enrolledCount: number;   // текущее число записанных
  credits?: number;
  selected?: boolean;      // уже выбран текущим студентом
}

export interface ModulesResponse {
  data: Module[];
}

// ─── Choice-app: Apply / Cancel ───────────────────────────────────────────────

export interface ApplyModuleBody {
  moduleId: string;
  priority: number;
}

export interface CancelModuleBody {
  moduleId: string;
}

export interface ApplyModuleResponse {
  success: boolean;
  message?: string;
}
