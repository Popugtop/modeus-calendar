// ─── Schedule ────────────────────────────────────────────────────────────────

export interface ScheduleRequestBody {
  size: number;
  timeMin: string; // ISO-8601, e.g. "2024-09-01T00:00:00+05:00"
  timeMax: string;
  attendeePersonId: string[]; // UUID массив студентов
}

export interface ScheduleEvent {
  id: string;
  name: string;
  nameShort?: string;
  startDateLocal: string;
  endDateLocal: string;
  holdingStatus?: string;
  format?: string;
  locationId?: string;
  locationName?: string;
}

export interface ScheduleResponse {
  total: number;
  data: {
    events: Record<string, ScheduleEvent>;
  };
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
