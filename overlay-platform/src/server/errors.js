/* Отказ с понятной причиной. Наружу уходит короткий код (например
   invalid_credentials или workspace_not_found), а текст для человека подбирает
   страница. Всё, что не является таким отказом, считается сбоем сервера:
   подробности остаются в журнале, наружу уходит только server_error. */
export class AppError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

// База сообщает так о нарушении уникальности: двое одновременно заняли одно и то же
export function isUniqueViolation(err) {
  return err?.errcode === 2067 || err?.errcode === 1555 || /UNIQUE constraint failed/i.test(String(err?.message));
}
