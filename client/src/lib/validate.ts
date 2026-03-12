const CYRILLIC_WORD = /^[А-ЯЁ][а-яё]+(-[А-ЯЁ][а-яё]+)?$/u;

export function validateFio(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Введите ФИО';

  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return 'Укажите полностью: Фамилия Имя Отчество';
  if (parts.length > 3) return 'Введите только три слова: Фамилия Имя Отчество';

  for (const part of parts) {
    if (!CYRILLIC_WORD.test(part)) {
      return 'Каждое слово — с заглавной буквы, только кириллица';
    }
  }
  return null;
}
