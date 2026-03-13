export interface PersonOption {
  id: string;
  fullName: string;
  specialtyName: string | null;
}

export interface RegisterResult {
  message: string;
  token: string;
  url: string;
}

export type RegisterResponse =
  | ({ status: 'success' } & RegisterResult)
  | { status: 'multiple'; persons: PersonOption[] };

export async function register(
  fio: string,
  inviteCode: string,
  personId?: string,
  personName?: string,
  telegramId?: string,
): Promise<RegisterResponse> {
  const res = await fetch('/api/calendar/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fio, inviteCode, personId, personName, telegramId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Ошибка сервера (${res.status})`);
  }

  const data = await res.json() as {
    status?: string;
    persons?: PersonOption[];
    message?: string;
    token?: string;
    url?: string;
  };

  if (data.status === 'multiple') {
    return { status: 'multiple', persons: data.persons! };
  }

  return { status: 'success', message: data.message!, token: data.token!, url: data.url! };
}
