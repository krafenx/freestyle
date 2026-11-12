/* ==========================================================================
   Помощники форм: ошибки у полей, показ пароля, состояние «отправляется»,
   копирование и показ кода восстановления.
   ========================================================================== */
import { toast } from './ui.js';

/* ---------- Ошибки ---------- */
export function setFieldError(input, message) {
  if (!input) return;
  const box = document.getElementById(`${input.id}-error`);
  input.classList.toggle('invalid', Boolean(message));
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  if (box) {
    box.textContent = message || '';
    box.hidden = !message;
  }
}

export function setFormError(box, message) {
  if (!box) return;
  box.textContent = message || '';
  box.hidden = !message;
}

export function clearErrors(form, formErrorBox) {
  form.querySelectorAll('.kf-input').forEach((input) => setFieldError(input, ''));
  setFormError(formErrorBox, '');
}

/* Ошибка у поля исчезает, как только человек начинает её исправлять */
export function clearErrorsOnInput(form, formErrorBox) {
  form.addEventListener('input', (e) => {
    if (e.target.classList?.contains('kf-input')) setFieldError(e.target, '');
    setFormError(formErrorBox, '');
  });
}

/* Показывает ошибку сервера: у конкретного поля, если сервер его назвал,
   иначе — общей плашкой под формой. Фокус переносится на проблемное поле. */
export function showServerError({ res, message, fieldMap = {}, formErrorBox }) {
  const input = fieldMap[res?.data?.field];
  if (input) {
    setFieldError(input, message);
    input.focus();
  } else {
    setFormError(formErrorBox, message);
  }
}

/* ---------- Кнопка «показать пароль» ---------- */
export function bindPasswordToggles(root = document) {
  root.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    const input = document.getElementById(btn.getAttribute('data-toggle-password'));
    if (!input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'скрыть' : 'показать';
      btn.setAttribute('aria-pressed', String(show));
    });
  });
}

// Перед отправкой пароль снова скрывается: менеджеры паролей ждут поле типа password
export function hidePasswords(form) {
  form.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    const input = document.getElementById(btn.getAttribute('data-toggle-password'));
    if (input && input.type !== 'password') btn.click();
  });
}

/* ---------- Отправка без двойных нажатий ---------- */
export async function withBusy(button, busyText, work) {
  if (!button || button.disabled) return undefined;
  const idleText = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = busyText;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = idleText;
  }
}

/* ---------- Копирование ----------
   Внутри встроенного окна браузер может запретить прямой доступ к буферу
   обмена — тогда используется запасной способ через выделение текста. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // пробуем запасной способ ниже
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/* ---------- Показ кода восстановления ----------
   Код виден один раз. Продолжить можно только отметив, что код сохранён. */
export function presentRecoveryCode({ code, valueEl, copyBtn, savedBox, continueBtn, onContinue }) {
  valueEl.textContent = code;
  if (savedBox) savedBox.checked = false;
  if (continueBtn) continueBtn.disabled = Boolean(savedBox);

  copyBtn?.addEventListener('click', async () => {
    if (await copyText(code)) {
      toast('Код скопирован', 'ok');
    } else {
      // Выделяем код, чтобы его можно было скопировать вручную
      const range = document.createRange();
      range.selectNodeContents(valueEl);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      toast('Не получилось скопировать — код выделен, скопируйте его вручную', 'error');
    }
  });

  savedBox?.addEventListener('change', () => {
    continueBtn.disabled = !savedBox.checked;
  });
  continueBtn?.addEventListener('click', () => onContinue?.());
}
