/* ==========================================================================
   Что это за файл — по его содержимому, а не по имени.

   Выполняется и в браузере, и на сервере. Страница проверяет файл до отправки,
   чтобы сразу сказать человеку, что не так; решает всё равно сервер — той же
   самой функцией, по тем байтам, которые реально пришли.

   Принимаются только форматы, которые браузер показывает как картинку или видео
   и не может исполнить: PNG, JPEG, WebP, GIF, MP4, WebM. SVG сюда не входит
   намеренно: внутри него могут быть скрипты.
   ========================================================================== */

// Сколько первых байт файла нужно, чтобы узнать формат
export const HEAD_BYTES = 64;

export const ACCEPTED_FORMATS = Object.freeze(['PNG', 'JPEG', 'WebP', 'GIF', 'MP4', 'WebM']);

// Что подставить в окно выбора файла. Это лишь подсказка браузеру, а не проверка
export const ACCEPT_ATTRIBUTE = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm';

const ascii = (bytes, from, length) => {
  let text = '';
  for (let i = from; i < from + length && i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
};
const startsWith = (bytes, signature, at = 0) =>
  bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);
const u16le = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const u16be = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];
const u24le = (bytes, at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
const u32be = (bytes, at) => bytes[at] * 0x1000000 + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);

// Семейство MP4. Файл называет свою «марку» и список совместимых с ней.
// Видео принимается, если среди них есть обычный MP4, а главная марка — не из списка
// отказа: MOV, картинки HEIC и AVIF, звук без видео
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'mmp4']);
const REJECTED_MAJOR_BRANDS = new Set(['qt  ', 'heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B ', 'M4P ']);

function sniffWebp(bytes) {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return null;
}

/* bytes — начало файла (Uint8Array или Buffer), не меньше HEAD_BYTES, если файл сам не короче.
   Ответ: { kind, mime, format, width, height } или null, если формат не принимается.
   kind — как файл используется на сцене: image, gif или video. Размеры известны
   сразу не для всех форматов: у JPEG и видео здесь width и height равны null. */
export function sniffFile(bytes) {
  if (!bytes || typeof bytes.length !== 'number') return null;

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
    return { kind: 'image', mime: 'image/png', format: 'PNG', width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', mime: 'image/jpeg', format: 'JPEG', width: null, height: null };
  }

  const head6 = ascii(bytes, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    if (bytes.length < 10) return null;
    return { kind: 'gif', mime: 'image/gif', format: 'GIF', width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const size = sniffWebp(bytes);
    return size ? { kind: 'image', mime: 'image/webp', format: 'WebP', ...size } : null;
  }

  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const boxEnd = Math.min(bytes.length, Math.max(16, u32be(bytes, 0)));
    const brands = [ascii(bytes, 8, 4)];
    for (let at = 16; at + 4 <= boxEnd; at += 4) brands.push(ascii(bytes, at, 4));
    if (REJECTED_MAJOR_BRANDS.has(brands[0]) || !brands.some((brand) => MP4_BRANDS.has(brand))) return null;
    return { kind: 'video', mime: 'video/mp4', format: 'MP4', width: null, height: null };
  }

  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // Контейнер один и тот же у WebM и MKV; принимается только тот, что назвал себя webm
    const limit = Math.min(bytes.length, HEAD_BYTES) - 7;
    for (let at = 4; at <= limit; at += 1) {
      if (bytes[at] === 0x42 && bytes[at + 1] === 0x82 && bytes[at + 2] === 0x84 && ascii(bytes, at + 3, 4) === 'webm') {
        return { kind: 'video', mime: 'video/webm', format: 'WebM', width: null, height: null };
      }
    }
    return null;
  }

  return null;
}

/* Размеры JPEG записаны не в начале файла, а после служебных блоков произвольной
   длины. readAt(offset, length) должна вернуть (можно асинхронно) байты файла
   с этого места. Ответ: { width, height } или null. */
export async function readJpegSize(readAt) {
  let offset = 2;
  for (let step = 0; step < 1000; step += 1) {
    const head = await readAt(offset, 4);
    if (!head || head.length < 4 || head[0] !== 0xff) return null;
    const marker = head[1];
    if (marker === 0xff) {
      offset += 1; // заполнитель между блоками
    } else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // блоки без длины
    } else if (marker === 0xd9 || marker === 0xda) {
      return null; // начались сами данные картинки, а размеров так и не встретилось
    } else {
      const length = u16be(head, 2);
      if (length < 2) return null;
      const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrameHeader) {
        const frame = await readAt(offset + 4, 5);
        if (!frame || frame.length < 5) return null;
        return { width: u16be(frame, 3), height: u16be(frame, 1) };
      }
      offset += 2 + length;
    }
  }
  return null;
}
