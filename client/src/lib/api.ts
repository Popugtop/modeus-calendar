export interface RegisterResult {
  message: string;
  token: string;
  url: string;
}

export async function register(fio: string): Promise<RegisterResult> {
  const res = await fetch('/api/calendar/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fio }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Ошибка сервера (${res.status})`);
  }

  return res.json() as Promise<RegisterResult>;
}
