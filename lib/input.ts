import { CabinetError, type NewDocument } from "./cabinet.ts";

export const fileLimit = 12 * 1024 * 1024;
export const multipartLimit = fileLimit + 64 * 1024;

export function textField(value: unknown, label: string, limit: number) {
  if (typeof value !== "string") throw new CabinetError("Заполните поле «" + label + "».");
  const text = value.trim();
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new CabinetError("Проверьте поле «" + label + "» (до " + limit + " символов).");
  }
  return text;
}

export function emailField(value: unknown) {
  const email = textField(value, "Почта", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new CabinetError("Введите адрес электронной почты.");
  return email;
}

export function passwordField(value: unknown, registering: boolean) {
  if (typeof value !== "string" || value.length > 128 || value.length < (registering ? 10 : 1)) {
    throw new CabinetError(registering ? "Пароль должен содержать от 10 до 128 символов." : "Проверьте пароль.");
  }
  return value;
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  let source: URL;
  try { source = new URL(origin ?? ""); } catch { throw new CabinetError("Откройте форму в кабинете.", 403); }
  const target = new URL(request.url);
  const host = request.headers.get("host") ?? target.host;
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const protocol = forwardedProtocol ? forwardedProtocol + ":" : target.protocol;
  if (source.host !== host || source.protocol !== protocol || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new CabinetError("Откройте форму в кабинете.", 403);
  }
}

export async function readLimited(request: Request, limit: number): Promise<ArrayBuffer> {
  const tooLarge = () => new CabinetError("Размер загружаемых данных превышает допустимый.", 413);
  if (Number(request.headers.get("content-length")) > limit) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new CabinetError("Получен пустой запрос.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function fileType(bytes: Uint8Array) {
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (Buffer.from(bytes.subarray(0, 8)).toString("hex") === "89504e470d0a1a0a") return "image/png";
  throw new CabinetError("Поддерживаются файлы PDF, JPEG и PNG.", 415);
}

export async function parseUpload(form: FormData): Promise<NewDocument> {
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new CabinetError("Выберите непустой файл.");
  if (file.size > fileLimit) throw new CabinetError("Максимальный размер файла — 12 МБ.", 413);
  const filename = textField(file.name, "Имя файла", 200);
  if (/[\\/]/u.test(filename)) throw new CabinetError("Проверьте имя файла.");
  const category = form.get("category");
  if (category !== "analysis" && category !== "examination") throw new CabinetError("Выберите тип документа.");
  const examDate = textField(form.get("examDate"), "Дата исследования", 10);
  const date = new Date(examDate + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(examDate) || examDate.startsWith("0000") ||
      !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== examDate) {
    throw new CabinetError("Укажите действительную дату исследования.");
  }
  const title = textField(form.get("title") || filename.replace(/\.[^./]+$/u, "").slice(0, 140) || filename, "Название", 140);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { filename, title, category, examDate, bytes, mime: fileType(bytes) };
}
