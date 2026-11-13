/* ==========================================================================
   Свой блок виджета: страница для рамки-«песочницы».

   Свой блок — единственное место платформы, куда человек пишет разметку сам.
   Сцену видят и другие: OBS стримера, модераторы. Поэтому блок может только
   одно — нарисовать себя. Он не должен ни выполнять код, ни обращаться к чужим
   сайтам: любое такое обращение выдало бы автору блока сетевой адрес компьютера,
   на котором открыта сцена.

   Защита — в три слоя, каждый закрывает своё:

   1. Рамка создаётся с пустой пометкой sandbox (см. sources/widget.js). Скрипты
      в ней не выполняются вовсе, формы не отправляются, окна не открываются,
      а для браузера её содержимое — посторонний сайт без имени: ни cookie,
      ни доступа к странице редактора.
   2. Содержимое рамки наследует политику загрузки той страницы, где показана
      сцена (Content-Security-Policy в app.js): картинки, стили, шрифты и видео —
      только с нашего сервера, с чужих адресов не загружается ничего.
   3. Из разметки заранее убирается то, что политика загрузки не покрывает:
      «подсказки» браузеру заранее соединиться с сайтом (<link>), переадресация
      (<meta>), смена базового адреса (<base>), ссылки. Этим занят этот файл.

   Почему скрипты запрещены совсем, а не «разрешены, но без сети»: надёжно отнять
   сеть у работающего скрипта браузеры не позволяют — прямое соединение (WebRTC)
   и те же подсказки <link> он создаёт в обход политики загрузки.
   ========================================================================== */

/* Элементы, которые убираются вместе с содержимым. Кроме опасных здесь и те, что без
   скриптов бессмысленны (template, noscript) или по-разному читаются браузером
   при повторном разборе (xmp, plaintext, noembed, noframes). */
const FORBIDDEN = new Set([
  'script', 'link', 'meta', 'base', 'template', 'slot',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe',
  'noscript', 'noembed', 'noframes', 'plaintext', 'xmp', 'listing',
]);

// Признаки, которые убираются у любого элемента
const FORBIDDEN_ATTRIBUTES = new Set(['srcdoc', 'autofocus', 'ping', 'formaction', 'action', 'manifest']);
// Ссылки на сцене ни к чему: нажимать на них некому, а адрес из ссылки браузер может начать искать заранее
const LINK_HOLDERS = new Set(['a', 'area']);
const LINK_ATTRIBUTES = new Set(['href', 'xlink:href']);

const ROUNDS = 4;
const EMPTY_PAGE = '<!DOCTYPE html><html><head></head><body></body></html>';

/* Оформление по умолчанию. Шрифты платформы доступны по именам (Alice, Manrope…),
   фон прозрачный, прокрутки нет. Цветовая схема та же, что у рамки на сцене
   (.kf-frame в scene.css): при разных схемах браузер залил бы фон рамки сплошным цветом. */
const PRELUDE = [
  '@import url("/styles/fonts.css");',
  ':root{color-scheme:dark}',
  'html,body{margin:0;padding:0;background:transparent;overflow:hidden}',
].join('');

// Убирает из документа запрещённое. Возвращает, сколько всего убрано
function scrub(doc) {
  let removed = 0;
  const doomed = [];
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      doomed.push(node); // комментарии сцене не нужны
      continue;
    }
    const tag = node.localName.toLowerCase();
    if (FORBIDDEN.has(tag)) {
      doomed.push(node);
      continue;
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || FORBIDDEN_ATTRIBUTES.has(name) || (LINK_HOLDERS.has(tag) && LINK_ATTRIBUTES.has(name))) {
        node.removeAttributeNode(attribute);
        removed += 1;
      }
    }
  }
  for (const node of doomed) {
    if (!node.isConnected) continue; // уже убран вместе с родителем
    node.remove();
    removed += 1;
  }
  return removed;
}

/* Код блока → готовая страница для рамки.

   Разметка разбирается тем же разборщиком, каким её потом прочитает рамка, чистится
   и записывается обратно строкой. Затем строка разбирается ещё раз: бывает разметка,
   которая после записи и повторного чтения складывается иначе, и запрещённый элемент
   «появляется» только на втором проходе. В рамку попадает лишь та строка, в которой
   при повторном чтении не нашлось ничего запрещённого; если за несколько проходов
   такой не получилось, блок остаётся пустым. */
export function buildBlockPage(code) {
  const parser = new DOMParser();
  let html = String(code ?? '');
  for (let round = 0; round < ROUNDS; round += 1) {
    const doc = parser.parseFromString(html, 'text/html');
    const removed = scrub(doc);
    if (round === 0) {
      const style = doc.createElement('style');
      style.textContent = PRELUDE;
      doc.head.prepend(style);
    } else if (removed === 0) {
      return html; // эта строка прочитана начисто — её и увидит рамка
    }
    html = `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
  }
  return EMPTY_PAGE;
}
