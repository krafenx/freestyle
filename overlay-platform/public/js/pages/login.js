import { initAtmosphere } from '../core/atmosphere.js';
import {
  bindPasswordToggles, clearErrors, clearErrorsOnInput, hidePasswords, setFieldError, showServerError, withBusy,
} from '../core/forms.js';
import { describeError, enterOrExplain, keepNextInLinks, send } from '../core/session.js';

initAtmosphere();
keepNextInLinks();
bindPasswordToggles();

const $ = (id) => document.getElementById(id);

const form = $('login-form');
const username = $('login-username');
const password = $('login-password');
const errorBox = $('login-error');
const submit = $('login-submit');

clearErrorsOnInput(form, errorBox);
username.focus();

form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors(form, errorBox);

  if (!username.value.trim()) {
    setFieldError(username, 'Введите имя пользователя.');
    username.focus();
    return;
  }
  if (!password.value) {
    setFieldError(password, 'Введите пароль.');
    password.focus();
    return;
  }

  hidePasswords(form);
  withBusy(submit, 'Входим…', async () => {
    const res = await send('/api/auth/login', { username: username.value.trim(), password: password.value });
    if (!res.ok) {
      showServerError({ res, message: describeError(res), formErrorBox: errorBox });
      if (res.data?.error === 'invalid_credentials') {
        password.select();
        password.focus();
      }
      return;
    }
    await enterOrExplain($('embed-hint'));
  });
});
