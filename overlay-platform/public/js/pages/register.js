import { initAtmosphere } from '../core/atmosphere.js';
import {
  bindPasswordToggles, clearErrors, clearErrorsOnInput, hidePasswords, presentRecoveryCode, setFieldError,
  showServerError, withBusy,
} from '../core/forms.js';
import { describeError, enterOrExplain, fetchSession, keepNextInLinks, send } from '../core/session.js';

initAtmosphere();
keepNextInLinks();
bindPasswordToggles();

const $ = (id) => document.getElementById(id);

const form = $('register-form');
const username = $('register-username');
const displayName = $('register-display');
const password = $('register-password');
const errorBox = $('register-error');
const submit = $('register-submit');

clearErrorsOnInput(form, errorBox);
username.focus();

// Регистрацию можно закрыть настройкой сервера — тогда вместо формы показываем объяснение
fetchSession().then((session) => {
  if (session.reachable && !session.registrationOpen) {
    form.hidden = true;
    $('register-closed').hidden = false;
  }
});

function checkBeforeSend() {
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username.value)) {
    setFieldError(username, 'Имя — от 3 до 24 символов: латинские буквы, цифры и знак подчёркивания.');
    username.focus();
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
  withBusy(submit, 'Создаём аккаунт…', async () => {
    const res = await send('/api/auth/register', {
      username: username.value,
      displayName: displayName.value,
      password: password.value,
    });
    if (!res.ok) {
      showServerError({
        res,
        message: describeError(res),
        fieldMap: { username, displayName, password },
        formErrorBox: errorBox,
      });
      return;
    }

    // Аккаунт создан: вместо формы показываем код восстановления
    password.value = '';
    $('register-panel').hidden = true;
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
