import { el, placeholder } from '../dom.js';
import { fitField, radiusField } from './picture.js';

/* Источник «Видео»: ролики MP4 и WebM, в том числе WebM с прозрачным фоном. */

const SPEEDS = [50, 75, 100, 125, 150, 200].map((value) => ({
  value,
  label: `${String(value / 100).replace('.', ',')}×`,
}));

export default {
  type: 'video',
  title: 'Видео',
  about: 'Ролик MP4 или WebM по кругу. WebM может быть с прозрачным фоном.',
  icon: 'M6 4l13 8-13 8V4z',
  size: { width: 640, height: 360 },
  media: { kinds: ['video'], formats: 'MP4 или WebM' },
  keepAspect: true,

  groups: [{ id: 'play', title: 'Воспроизведение' }, { id: 'look', title: 'Вид' }],
  fields: {
    loop: { kind: 'bool', default: true, label: 'Повторять по кругу', group: 'play' },
    muted: {
      kind: 'bool', default: true, label: 'Без звука', group: 'play',
      hint: 'В редакторе видео всегда беззвучно. Звук слышен только в эфире.',
    },
    volume: { kind: 'int', min: 0, max: 100, default: 60, label: 'Громкость', unit: '%', control: 'range', group: 'play', when: (s) => !s.muted },
    speed: { kind: 'choice', options: SPEEDS, default: 100, label: 'Скорость', control: 'pills', group: 'play' },
    fit: fitField('look'),
    radius: radiusField('look'),
  },

  render(node, source, ctx) {
    const s = source.settings;
    if (!node.parts) {
      const frame = el('div', 'kf-media');
      node.body.append(frame);
      node.parts = { frame, video: null, url: null, failed: false, visible: null };
      node.dispose = () => stop(node.parts);
    }
    const parts = node.parts;

    const note = () => {
      const text = !parts.url ? 'Файл не выбран' : parts.failed ? 'Браузер не может показать это видео' : '';
      placeholder(node.body, ctx.mode === 'editor' ? text : '');
    };

    const url = source.file ? ctx.mediaUrl(source.file) : null;
    if (url !== parts.url) {
      stop(parts);
      parts.url = url;
      parts.failed = false;
      parts.visible = null;
      if (url) {
        const video = el('video', 'kf-media-item');
        video.muted = true; // без звука браузер разрешает запуск без нажатия; звук включается ниже
        video.playsInline = true;
        video.preload = 'auto';
        video.disablePictureInPicture = true;
        video.tabIndex = -1;
        video.addEventListener('error', () => {
          if (parts.video !== video) return;
          parts.failed = true;
          stop(parts);
          note();
        });
        video.src = url;
        parts.frame.append(video);
        parts.video = video;
      }
    }

    const { video } = parts;
    if (video) {
      video.loop = s.loop;
      video.defaultPlaybackRate = s.speed / 100;
      video.playbackRate = s.speed / 100;
      video.volume = s.volume / 100;
      video.muted = ctx.mode === 'editor' || s.muted;
      video.style.objectFit = s.fit;

      // Скрытый ролик не играет (и не звучит); показанный заново начинается с начала
      if (parts.visible !== source.visible) {
        parts.visible = source.visible;
        if (source.visible) {
          try {
            video.currentTime = 0;
          } catch {
            // ролик ещё не загрузился — начнётся с начала сам
          }
          play(video);
        } else {
          video.pause();
        }
      }
    }
    parts.frame.style.borderRadius = `${s.radius}px`;
    note();
  },
};

function play(video) {
  const started = video.play();
  if (!started) return;
  started.catch(() => {
    // Обычный браузер не даёт запустить ролик со звуком без нажатия — играем без звука.
    // В OBS такого запрета нет
    if (video.muted) return;
    video.muted = true;
    video.play().catch(() => {});
  });
}

function stop(parts) {
  const { video } = parts;
  if (!video) return;
  parts.video = null;
  video.pause();
  video.removeAttribute('src');
  video.load(); // отпускает уже загруженное
  video.remove();
}
