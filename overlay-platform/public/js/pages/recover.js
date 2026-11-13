import { initAtmosphere } from '../core/atmosphere.js';
import {
  bindPasswordToggles, clearErrors, clearErrorsOnInput, hidePasswords, presentRecoveryCode, setFieldError,
  showServerError, withBusy,
} from '../core/forms.js';
import { describeError, enterOrExplain, keepNextInLinks, send } from '../core/session.js';

initAtmosphere();
keepNextInLinks();
bindPasswordToggles();

const $ = (id) => document.getElementById(id);

const form = $('recover-form');
const username = $('recover-username');
const code = $('recover-code');
const password = $('recover-password');
const errorBox = $('recover-error');
const submit = $('recover-submit');

clearErrorsOnInput(form, errorBox);
username.focus();

function checkBeforeSend() {
  if (!username.value.trim()) {
    setFieldError(username, 'Введите имя пользователя.');
    username.focus();
    return false;
  }
  if (!code.value.trim()) {
    setFieldError(code, 'Введите код восстановления.');
    code.focus();
    return false;
  }
  if ([...password.value].length < 8) {
    setFieldError(password, 'Пароль слишком короткий: нужно не меньше 8 символов.');
    password.focus();
    return false;
  }
  return true;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(form, errorBox);
  if (!checkBeforeSend()) return;

  hidePasswords(form);
  withBusy(submit, 'Проверяем код…', async () => {
    const res = await send('/api/auth/recover', {
      username: username.value.trim(),
      recoveryCode: code.value,
      newPassword: password.value,
    });
    if (!res.ok) {
      showServerError({
        res,
        message: describeError(res),
        fieldMap: { newPassword: password },
        formErrorBox: errorBox,
      });
      return;
    }

    // Старый код использован и больше не действует — показываем новый
    password.value = '';
    code.value = '';
    $('recover-panel').hidden = true;
    $('code-panel').hidden = false;
    // Человек уже вошёл: кнопка «Вход» в шапке больше не нужна и только увела бы мимо кода
    document.querySelector('.topnav-right').hidden = true;
    presentRecoveryCode({
      code: res.data.recoveryCode,
      valueEl: $('code-value'),
      copyBtn: $('code-copy'),
      savedBox: $('code-saved'),
      continueBtn: $('code-continue'),
      onContinue: () => enterOrExplain($('embed-hint')),
    });
    $('code-title').focus();
  });
});
