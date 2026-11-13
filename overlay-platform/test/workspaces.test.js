import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createAccounts } from '../src/server/auth/accounts.js';
import { safeNextPath } from '../src/server/auth/http.js';
import { isLinkToken, newLinkToken, sha256Hex } from '../src/server/auth/tokens.js';
import { openDatabase } from '../src/server/db/database.js';
import {
  DAY, FAST, GOOD_PASSWORD, LATEST_MIGRATION, MINUTE, PLATFORM_STAGE, PROJECT_DIR, SCHEMA_VERSION,
  createVisitor, openSocket, registerUser, startServer,
} from './helpers.js';

/* Этап 4: площадки и роли. Проверяется настоящий сервер с настоящей базой:
   создание площадки, приглашение и удаление модераторов и — главное — права:
   что может владелец, что модератор, а что не может никто посторонний. */

const HOUR = 60 * MINUTE;
const PUBLIC_ID = /^[0-9a-hjkmnp-tv-z]{12}$/; // номер площадки или приглашения
const INVITE_TOKEN = /^[0-9a-hjkmnp-tv-z]{26}$/;
const LIVE_TICKET = /^[0-9a-hjkmnp-tv-z]{26}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const call = (visitor, method, url, body) => {
  if (method === 'GET') return visitor.get(url);
  if (method === 'PATCH') return visitor.patch(url, body);
  return visitor.post(url, body);
};

let workspaceCounter = 0;

async function createWorkspace(visitor, name = `Площадка ${(workspaceCounter += 1)}`) {
  const res = await visitor.post('/api/workspaces', { name });
  assert.equal(res.status, 201, `площадка «${name}» не создана: ${res.text}`);
  return res.data.workspace;
}

async function createInvite(owner, workspaceId, label) {
  const res = await owner.post(`/api/workspaces/${workspaceId}/invites`, label === undefined ? {} : { label });
  assert.equal(res.status, 201, `приглашение не создано: ${res.text}`);
  return res.data; // { invite, token }
}

async function acceptInvite(visitor, token) {
  const res = await visitor.post(`/api/invites/${token}/accept`);
  assert.equal(res.status, 200, `приглашение не принято: ${res.text}`);
  return res.data;
}

// Новый человек, который сразу становится модератором площадки
async function addModerator(baseUrl, owner, workspaceId, overrides = {}) {
  const person = await registerUser(baseUrl, overrides);
  const { token } = await createInvite(owner, workspaceId);
  await acceptInvite(person.visitor, token);
  return person;
}

const detail = async (visitor, workspaceId) => (await visitor.get(`/api/workspaces/${workspaceId}`)).data;
const userId = (db, username) => db.prepare('SELECT id FROM users WHERE username_key = ?').get(username.toLowerCase()).id;

/* ========================================================================== */

describe('Этап 4 — площадки', () => {
  let ctx;
  before(async () => { ctx = await startServer(); });
  after(async () => { await ctx.stop(); });

  it('площадку создаёт вошедший человек и становится её единственным владельцем', async () => {
    const guest = createVisitor(ctx.baseUrl);
    assert.equal((await guest.post('/api/workspaces', { name: 'Гостевая' })).status, 401);

    const { visitor, username } = await registerUser(ctx.baseUrl, { displayName: 'Стример' });
    const empty = (await visitor.get('/api/workspaces')).data;
    assert.deepEqual(empty, { ok: true, workspaces: [], owned: 0, ownedLimit: 10 });

    const created = await visitor.post('/api/workspaces', { name: 'Ночной эфир' });
    assert.equal(created.status, 201);
    const { workspace } = created.data;
    assert.match(workspace.id, PUBLIC_ID);
    assert.match(workspace.createdAt, ISO_DATE);
    assert.deepEqual(workspace, {
      id: workspace.id, name: 'Ночной эфир', role: 'owner', ownerName: 'Стример', createdAt: workspace.createdAt,
    });

    const list = (await visitor.get('/api/workspaces')).data;
    assert.equal(list.owned, 1);
    assert.deepEqual(list.workspaces, [
      { id: workspace.id, name: 'Ночной эфир', role: 'owner', moderators: 0, createdAt: workspace.createdAt },
    ]);

    const full = await detail(visitor, workspace.id);
    assert.deepEqual(full.workspace, workspace);
    assert.deepEqual(full.members, [{ role: 'owner', displayName: 'Стример', isYou: true, username }]);
    assert.deepEqual(full.invites, []);
    assert.deepEqual(full.limits, { moderators: 50, pendingInvites: 20 });

    // В базе владелец записан в самой площадке; в списке модераторов его нет
    const row = ctx.db.prepare('SELECT * FROM workspaces WHERE public_id = ?').get(workspace.id);
    assert.equal(row.owner_id, userId(ctx.db, username));
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?').get(row.id).n, 0);
  });

  it('номера площадок случайные: по своему номеру нельзя угадать чужой или узнать, сколько площадок на сервере', async () => {
    const { visitor } = await registerUser(ctx.baseUrl);
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push((await createWorkspace(visitor)).id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.ok(isLinkToken(id, 12));
    assert.notDeepEqual(ids, [...ids].sort(), 'номера не должны идти по порядку создания');

    // Порядковые номера строк базы не попадают ни в один ответ
    const invite = await createInvite(visitor, ids[0], 'подпись');
    const answers = [
      (await visitor.get('/api/workspaces')).data,
      await detail(visitor, ids[0]),
      invite,
    ];
    const rowIds = ctx.db.prepare('SELECT id FROM workspaces WHERE public_id = ?').get(ids[0]);
    assert.equal(typeof rowIds.id, 'number');
    (function walk(value, trail) {
      if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${trail}[${i}]`));
      if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => walk(v, `${trail}.${k}`));
      if (/(^|\.)id$/i.test(trail)) assert.match(String(value), PUBLIC_ID, `${trail}: наружу ушёл не случайный номер`);
      return undefined;
    })(answers, 'ответ');
  });

  it('название: обязательно, до 40 знаков, приводится к аккуратному виду и хранится как текст', async () => {
    const { visitor } = await registerUser(ctx.baseUrl);

    for (const name of ['', '   ', '\u200b\u200b', undefined, null, 42, true, ['Массив'], { a: 1 }]) {
      const res = await visitor.post('/api/workspaces', { name });
      assert.equal(res.status, 400, `название ${JSON.stringify(name)} должно быть отклонено`);
      assert.deepEqual(res.data, { ok: false, error: 'workspace_name_required', field: 'name' });
    }

    const tooLong = await visitor.post('/api/workspaces', { name: 'я'.repeat(41) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.data.error, 'workspace_name_too_long');

    // 40 знаков — можно; смайлик считается одним знаком, как его видит человек
    assert.equal((await createWorkspace(visitor, `${'я'.repeat(39)}🎬`)).name, `${'я'.repeat(39)}🎬`);

    const tidy = await createWorkspace(visitor, '  Мой \u200b\u202e  стрим\r\n ');
    assert.equal(tidy.name, 'Мой стрим');

    // Разметка в названии остаётся обычным текстом: сервер её не исполняет и не «чистит» молча
    const markup = '<img src=x onerror=alert(1)>';
    assert.equal((await createWorkspace(visitor, markup)).name, markup);
    assert.equal((await visitor.get('/api/workspaces')).data.workspaces.at(-1).name, markup);
  });

  it('у одного владельца названия не повторяются; у разных людей — могут', async () => {
    const first = await registerUser(ctx.baseUrl);
    const second = await registerUser(ctx.baseUrl);
    const mine = await createWorkspace(first.visitor, 'Канал Ё');

    for (const name of ['Канал Ё', 'канал ё', '  КАНАЛ   Ё ']) {
      const twin = await first.visitor.post('/api/workspaces', { name });
      assert.equal(twin.status, 409, `«${name}» — то же название`);
      assert.deepEqual(twin.data, { ok: false, error: 'workspace_name_taken', field: 'name' });
    }
    await createWorkspace(second.visitor, 'Канал Ё');

    // Переименование в собственное же название (например, с другим регистром) — не «повтор»
    const same = await first.visitor.patch(`/api/workspaces/${mine.id}`, { name: 'КАНАЛ Ё' });
    assert.equal(same.status, 200);
    assert.equal(same.data.workspace.name, 'КАНАЛ Ё');

    const other = await createWorkspace(first.visitor, 'Второй канал');
    const clash = await first.visitor.patch(`/api/workspaces/${other.id}`, { name: 'канал ё' });
    assert.equal(clash.status, 409);
    assert.equal(clash.data.error, 'workspace_name_taken');
  });

  it('переименование меняет название для всех участников и ничего больше', async () => {
    const owner = await registerUser(ctx.baseUrl);
    const workspace = await createWorkspace(owner.visitor, 'Старое название');
    const moderator = await addModerator(ctx.baseUrl, owner.visitor, workspace.id);

    for (const name of ['', '   ', 7, 'я'.repeat(41)]) {
      assert.equal((await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name })).status, 400);
    }

    const renamed = await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: ' Новое   название ' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.data.workspace, { ...workspace, name: 'Новое название' });

    const seenByModerator = await detail(moderator.visitor, workspace.id);
    assert.equal(seenByModerator.workspace.name, 'Новое название');
    assert.equal(seenByModerator.workspace.role, 'moderator');
    assert.equal(seenByModerator.members.length, 2, 'команда не изменилась');
  });

  it('удаление требует набрать название площадки и убирает её вместе с командой и приглашениями', async () => {
    const owner = await registerUser(ctx.baseUrl);
    const workspace = await createWorkspace(owner.visitor, 'На удаление');
    const keep = await createWorkspace(owner.visitor, 'Остаётся');
    const moderator = await addModerator(ctx.baseUrl, owner.visitor, workspace.id);
    const pending = await createInvite(owner.visitor, workspace.id);
    const rowId = ctx.db.prepare('SELECT id FROM workspaces WHERE public_id = ?').get(workspace.id).id;

    for (const confirmName of [undefined, '', 'Остаётся', 'На удаление!', 42, { name: 'На удаление' }]) {
      const res = await owner.visitor.post(`/api/workspaces/${workspace.id}/delete`, { confirmName });
      assert.equal(res.status, 400, `подтверждение ${JSON.stringify(confirmName)} не должно подходить`);
      assert.deepEqual(res.data, { ok: false, error: 'confirm_name_mismatch', field: 'confirmName' });
    }
    assert.equal((await detail(owner.visitor, workspace.id)).ok, true, 'площадка ещё на месте');

    // Регистр и лишние пробелы при наборе не важны: намерение понятно
    const gone = await owner.visitor.post(`/api/workspaces/${workspace.id}/delete`, { confirmName: '  на   удаление ' });
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.data, { ok: true, deleted: { id: workspace.id, name: 'На удаление' } });

    for (const visitor of [owner.visitor, moderator.visitor]) {
      const res = await visitor.get(`/api/workspaces/${workspace.id}`);
      assert.equal(res.status, 404);
      assert.equal(res.data.error, 'workspace_not_found');
    }
    assert.deepEqual((await moderator.visitor.get('/api/workspaces')).data.workspaces, []);
    assert.deepEqual((await owner.visitor.get('/api/workspaces')).data.workspaces.map((w) => w.id), [keep.id]);
    assert.equal((await owner.visitor.get(`/api/invites/${pending.token}`)).status, 404, 'приглашение удалённой площадки не действует');

    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?').get(rowId).n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM workspace_invites WHERE workspace_id = ?').get(rowId).n, 0);
    // Аккаунты участников удаление площадки не затрагивает
    assert.equal(await moderator.visitor.isSignedIn(), true);
  });

  it('в списке — свои площадки и те, где человек модератор; чужих нет', async () => {
    const streamer = await registerUser(ctx.baseUrl, { displayName: 'Стример А' });
    const other = await registerUser(ctx.baseUrl, { displayName: 'Стример Б' });
    const own = await createWorkspace(streamer.visitor, 'Своя');
    const foreign = await createWorkspace(other.visitor, 'Чужая, но я модератор');
    await createWorkspace(other.visitor, 'Совсем чужая');
    const { token } = await createInvite(other.visitor, foreign.id);
    await acceptInvite(streamer.visitor, token);

    const list = (await streamer.visitor.get('/api/workspaces')).data;
    assert.equal(list.owned, 1, 'в счёт своих идут только те, которыми человек владеет');
    assert.equal(list.workspaces.length, 2);
    assert.deepEqual(list.workspaces[0], { id: own.id, name: 'Своя', role: 'owner', moderators: 0, createdAt: own.createdAt });
    const moderated = list.workspaces[1];
    assert.match(moderated.joinedAt, ISO_DATE);
    assert.deepEqual(moderated, {
      id: foreign.id, name: 'Чужая, но я модератор', role: 'moderator', ownerName: 'Стример Б',
      moderators: 1, createdAt: foreign.createdAt, joinedAt: moderated.joinedAt,
    });
  });
});

/* ========================================================================== */

describe('Этап 4 — права: владелец, модератор, посторонний', () => {
  let ctx;
  let owner;
  let moderator;
  let stranger;
  let workspace;
  let pending;
  let snapshot;

  const NAME = 'Площадка с правами';

  // Все действия над площадкой. Порядок важен только для модератора: «выйти» идёт последним.
  const actions = (id, inviteId) => [
    ['GET', `/api/workspaces/${id}`],
    ['PATCH', `/api/workspaces/${id}`, { name: 'Захвачено' }],
    ['POST', `/api/workspaces/${id}/delete`, { confirmName: NAME }],
    ['POST', `/api/workspaces/${id}/members/remove`, { username: moderator.username }],
    ['POST', `/api/workspaces/${id}/invites`, { label: 'чужое' }],
    ['POST', `/api/workspaces/${id}/invites/${inviteId}/revoke`, {}],
    ['POST', `/api/workspaces/${id}/overlay/renew`, {}], // этап 6: новая ссылка оверлея
    ['POST', `/api/workspaces/${id}/live`, {}],
    ['POST', `/api/workspaces/${id}/leave`, {}],
  ];

  // Состояние площадки целиком (вместе со ссылкой оверлея): после чужих попыток оно должно остаться прежним
  const state = () => JSON.stringify({
    workspaces: ctx.db.prepare('SELECT * FROM workspaces ORDER BY id').all(),
    members: ctx.db.prepare('SELECT * FROM workspace_members ORDER BY workspace_id, user_id').all(),
    invites: ctx.db.prepare('SELECT * FROM workspace_invites ORDER BY id').all(),
  });

  before(async () => {
    ctx = await startServer();
    owner = await registerUser(ctx.baseUrl, { displayName: 'Владелец' });
    stranger = await registerUser(ctx.baseUrl, { displayName: 'Посторонний' });
    workspace = await createWorkspace(owner.visitor, NAME);
    moderator = await addModerator(ctx.baseUrl, owner.visitor, workspace.id, { displayName: 'Модератор' });
    pending = await createInvite(owner.visitor, workspace.id, 'для второго модератора');
    snapshot = state();
  });
  after(async () => { await ctx.stop(); });

  it('гость получает отказ на любой запрос к площадкам, и ничего не меняется', async () => {
    const guest = createVisitor(ctx.baseUrl);
    const requests = [['GET', '/api/workspaces'], ['POST', '/api/workspaces', { name: 'Гость' }], ...actions(workspace.id, pending.invite.id)];
    for (const [method, url, body] of requests) {
      const res = await call(guest, method, url, body);
      assert.equal(res.status, 401, `${method} ${url} без входа`);
      assert.deepEqual(res.data, { ok: false, error: 'unauthorized' });
    }
    assert.equal(state(), snapshot);
  });

  it('посторонний получает «не найдено» — точно такое же, как для площадки, которой нет', async () => {
    const missingId = newLinkToken(12);
    const real = actions(workspace.id, pending.invite.id);
    const missing = actions(missingId, pending.invite.id);

    for (let i = 0; i < real.length; i += 1) {
      const [method, url, body] = real[i];
      const res = await call(stranger.visitor, method, url, body);
      assert.equal(res.status, 404, `${method} ${url} от постороннего`);
      assert.deepEqual(res.data, { ok: false, error: 'workspace_not_found' });

      // По ответу нельзя понять, существует ли площадка: посторонний не узнаёт даже этого
      const ghost = await call(stranger.visitor, missing[i][0], missing[i][1], missing[i][2]);
      assert.equal(ghost.status, res.status);
      assert.equal(ghost.text, res.text);
    }
    assert.equal(state(), snapshot, 'чужие попытки ничего не изменили');
    assert.deepEqual((await stranger.visitor.get('/api/workspaces')).data.workspaces, []);
  });

  it('модератор видит площадку и команду, но управлять ею не может', async () => {
    const seen = await moderator.visitor.get(`/api/workspaces/${workspace.id}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.data.workspace.role, 'moderator');
    assert.equal(seen.data.workspace.name, NAME);
    assert.equal(seen.data.workspace.ownerName, 'Владелец');
    // Приглашения и пределы — дело владельца: модератору они не приходят вовсе
    assert.equal('invites' in seen.data, false);
    assert.equal('limits' in seen.data, false);
    // Ссылка оверлея — тоже
    assert.equal('overlay' in seen.data, false);

    const ownerOnly = actions(workspace.id, pending.invite.id)
      .filter(([method, url]) => method !== 'GET' && !url.endsWith('/leave') && !url.endsWith('/live'));
    assert.equal(ownerOnly.length, 6);
    for (const [method, url, body] of ownerOnly) {
      const res = await call(moderator.visitor, method, url, body);
      assert.equal(res.status, 403, `${method} ${url} от модератора`);
      assert.deepEqual(res.data, { ok: false, error: 'owner_only' });
    }
    assert.equal(state(), snapshot, 'попытки модератора ничего не изменили');
  });

  it('имена для входа видит только владелец; модераторам друг о друге известно лишь отображаемое имя', async () => {
    const second = await addModerator(ctx.baseUrl, owner.visitor, workspace.id, { displayName: 'Второй модератор' });
    try {
      const forOwner = (await detail(owner.visitor, workspace.id)).members;
      assert.deepEqual(forOwner.map((m) => [m.role, m.displayName, m.username, m.isYou]), [
        ['owner', 'Владелец', owner.username, true],
        ['moderator', 'Модератор', moderator.username, false],
        ['moderator', 'Второй модератор', second.username, false],
      ]);

      const body = await moderator.visitor.get(`/api/workspaces/${workspace.id}`);
      assert.deepEqual(body.data.members.map((m) => [m.role, m.displayName, m.isYou]), [
        ['owner', 'Владелец', false],
        ['moderator', 'Модератор', true],
        ['moderator', 'Второй модератор', false],
      ]);
      for (const member of body.data.members) assert.equal('username' in member, false);
      for (const name of [owner.username, second.username, moderator.username]) {
        assert.doesNotMatch(body.text, new RegExp(name), 'в ответе модератору нет ни одного имени для входа');
      }
      for (const member of body.data.members.slice(1)) assert.match(member.joinedAt, ISO_DATE);
    } finally {
      await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: second.username });
      snapshot = state();
    }
  });

  it('владелец видит, кто и по какой ссылке вошёл в команду; модераторам это не сообщается', async () => {
    const vasya = await registerUser(ctx.baseUrl, { displayName: 'Вася' });
    const { token } = await createInvite(owner.visitor, workspace.id, 'для Васи');
    await acceptInvite(vasya.visitor, token);
    try {
      const forOwner = (await detail(owner.visitor, workspace.id)).members.at(-1);
      assert.match(forOwner.joinedAt, ISO_DATE);
      assert.deepEqual(forOwner, {
        role: 'moderator', displayName: 'Вася', isYou: false, joinedAt: forOwner.joinedAt,
        username: vasya.username, inviteLabel: 'для Васи',
      });

      const forModerator = await moderator.visitor.get(`/api/workspaces/${workspace.id}`);
      assert.deepEqual(forModerator.data.members.at(-1), {
        role: 'moderator', displayName: 'Вася', isYou: false, joinedAt: forOwner.joinedAt,
      });
      assert.doesNotMatch(forModerator.text, /для Васи|inviteLabel|username/);
    } finally {
      await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: vasya.username });
      snapshot = state();
    }
  });

  it('кто просит — определяет только сеанс входа: подставить в запрос чужое имя или роль нельзя', async () => {
    const ownerId = userId(ctx.db, owner.username);
    const forged = { name: 'Захвачено', userId: ownerId, ownerId, owner_id: ownerId, role: 'owner', username: owner.username };

    const rename = await moderator.visitor.patch(`/api/workspaces/${workspace.id}`, forged);
    assert.equal(rename.status, 403);
    assert.equal((await stranger.visitor.patch(`/api/workspaces/${workspace.id}`, forged)).status, 404);
    assert.equal(state(), snapshot);

    // Созданная с такими полями площадка достаётся тому, кто вошёл, а не тому, чьё имя подставлено
    const created = await stranger.visitor.post('/api/workspaces', { ...forged, name: 'Площадка постороннего' });
    assert.equal(created.status, 201);
    const row = ctx.db.prepare('SELECT owner_id FROM workspaces WHERE public_id = ?').get(created.data.workspace.id);
    assert.equal(row.owner_id, userId(ctx.db, stranger.username));
    assert.deepEqual((await owner.visitor.get('/api/workspaces')).data.workspaces.map((w) => w.id), [workspace.id]);

    await stranger.visitor.post(`/api/workspaces/${created.data.workspace.id}/delete`, { confirmName: 'Площадка постороннего' });
    snapshot = state();
  });

  it('владелец не может «выйти» из своей площадки: площадки без владельца не бывает', async () => {
    const res = await owner.visitor.post(`/api/workspaces/${workspace.id}/leave`);
    assert.equal(res.status, 409);
    assert.deepEqual(res.data, { ok: false, error: 'owner_cannot_leave' });
    assert.equal(state(), snapshot);

    // Убрать из команды самого себя владелец тоже не может: он не модератор
    const self = await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: owner.username });
    assert.equal(self.status, 404);
    assert.equal(self.data.error, 'member_not_found');
    assert.equal(state(), snapshot);
  });

  it('убранный модератор теряет доступ сразу, а его аккаунт и другие площадки остаются', async () => {
    const temp = await addModerator(ctx.baseUrl, owner.visitor, workspace.id, { displayName: 'Временный' });
    const elsewhere = await createWorkspace(temp.visitor, 'Своя площадка временного');
    assert.equal((await temp.visitor.get(`/api/workspaces/${workspace.id}`)).status, 200);

    for (const username of [undefined, '', 'no_such_user', stranger.username, 42, { a: 1 }, ['x']]) {
      const res = await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username });
      assert.equal(res.status, 404, `нельзя убрать того, кого в команде нет: ${JSON.stringify(username)}`);
      assert.equal(res.data.error, 'member_not_found');
    }

    // Имя для входа сравнивается без учёта регистра — как и при входе
    const removed = await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: temp.username.toUpperCase() });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data, { ok: true, removed: true });

    const after = await temp.visitor.get(`/api/workspaces/${workspace.id}`);
    assert.equal(after.status, 404);
    assert.equal(after.data.error, 'workspace_not_found');
    assert.deepEqual((await temp.visitor.get('/api/workspaces')).data.workspaces.map((w) => w.id), [elsewhere.id]);
    assert.equal(await temp.visitor.isSignedIn(), true);
    assert.equal((await detail(owner.visitor, workspace.id)).members.some((m) => m.username === temp.username), false);

    // Повторное удаление — уже «не найден», а не сбой
    assert.equal((await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: temp.username })).status, 404);
    await temp.visitor.post(`/api/workspaces/${elsewhere.id}/delete`, { confirmName: elsewhere.name });
    snapshot = state();
  });

  it('модератор может выйти из площадки сам — и после этого он для неё посторонний', async () => {
    const leaving = await addModerator(ctx.baseUrl, owner.visitor, workspace.id, { displayName: 'Уходящий' });
    const left = await leaving.visitor.post(`/api/workspaces/${workspace.id}/leave`);
    assert.equal(left.status, 200);
    assert.deepEqual(left.data, { ok: true, left: { id: workspace.id, name: NAME } });

    for (const [method, url, body] of actions(workspace.id, pending.invite.id)) {
      assert.equal((await call(leaving.visitor, method, url, body)).status, 404, `${method} ${url} после выхода`);
    }
    assert.equal(state(), snapshot, 'после выхода всё как до его прихода');
  });

  it('при удалении аккаунта исчезают его площадки и его участие в чужих', async () => {
    const leaver = await registerUser(ctx.baseUrl, { displayName: 'Удаляемый' });
    const own = await createWorkspace(leaver.visitor, 'Площадка удаляемого');
    const guestOfOwn = await addModerator(ctx.baseUrl, leaver.visitor, own.id);
    const { token } = await createInvite(owner.visitor, workspace.id);
    await acceptInvite(leaver.visitor, token);
    assert.equal((await detail(owner.visitor, workspace.id)).members.length, 3);

    // Удаления аккаунта в интерфейсе пока нет; так выглядит удаление на уровне базы
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(userId(ctx.db, leaver.username));

    assert.equal((await guestOfOwn.visitor.get(`/api/workspaces/${own.id}`)).status, 404);
    assert.deepEqual((await guestOfOwn.visitor.get('/api/workspaces')).data.workspaces, []);
    assert.equal((await detail(owner.visitor, workspace.id)).members.length, 2);
    assert.equal(state(), snapshot, 'от удалённого аккаунта не осталось ни площадок, ни участия, ни приглашений');
  });
});

/* ========================================================================== */

describe('Этап 4 — приглашения', () => {
  let ctx;
  let clock;
  before(async () => {
    clock = Date.now();
    ctx = await startServer({ now: () => clock });
  });
  after(async () => { await ctx.stop(); });

  it('ссылку создаёт владелец; в базе остаётся только её отпечаток, повторно она не показывается', async () => {
    const owner = await registerUser(ctx.baseUrl);
    const workspace = await createWorkspace(owner.visitor);

    const created = await owner.visitor.post(`/api/workspaces/${workspace.id}/invites`, { label: '  для \u200b Васи  ' });
    assert.equal(created.status, 201);
    const { invite, token } = created.data;
    assert.match(token, INVITE_TOKEN);
    assert.match(invite.id, PUBLIC_ID);
    assert.equal(invite.label, 'для Васи');
    assert.equal(Date.parse(invite.expiresAt) - Date.parse(invite.createdAt), 7 * DAY, 'приглашение действует семь дней');

    const row = ctx.db.prepare('SELECT * FROM workspace_invites WHERE public_id = ?').get(invite.id);
    assert.equal(row.token_hash, sha256Hex(`invite:${token}`));
    assert.equal(row.accepted_by, null);
    const everything = JSON.stringify(ctx.db.prepare('SELECT * FROM workspace_invites').all());
    assert.doesNotMatch(everything, new RegExp(token), 'сама ссылка в базе не хранится');

    // В списке владельца — подпись и сроки, но не ссылка
    const listed = await owner.visitor.get(`/api/workspaces/${workspace.id}`);
    assert.deepEqual(listed.data.invites, [invite]);
    assert.doesNotMatch(listed.text, new RegExp(token));

    // Подпись необязательна, но ограничена по длине
    assert.equal((await createInvite(owner.visitor, workspace.id)).invite.label, '');
    assert.equal((await createInvite(owner.visitor, workspace.id, 42)).invite.label, '', 'не текст — значит, без подписи');
    const long = await owner.visitor.post(`/api/workspaces/${workspace.id}/invites`, { label: 'я'.repeat(41) });
    assert.equal(long.status, 400);
    assert.deepEqual(long.data, { ok: false, error: 'invite_label_too_long', field: 'label' });

    // Каждая ссылка своя
    const tokens = new Set();
    for (let i = 0; i < 5; i += 1) tokens.add((await createInvite(owner.visitor, workspace.id)).token);
    assert.equal(tokens.size, 5);
  });

  it('гость видит, куда его зовут, но принять приглашение можно только после входа', async () => {
    const owner = await registerUser(ctx.baseUrl, { displayName: 'Хозяйка эфира' });
    const workspace = await createWorkspace(owner.visitor, 'Утренний эфир');
    const { token, invite } = await createInvite(owner.visitor, workspace.id);

    const guest = createVisitor(ctx.baseUrl);
    const seen = await guest.get(`/api/invites/${token}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get('cache-control'), 'no-store');
    assert.deepEqual(seen.data, {
      ok: true,
      invite: {
        state: 'pending',
        viewer: 'guest',
        workspace: { name: 'Утренний эфир' },
        ownerName: 'Хозяйка эфира',
        expiresAt: invite.expiresAt,
      },
    });
    // Гостю не сообщается ничего, кроме названия и имени владельца: ни адреса площадки, ни имени для входа
    assert.doesNotMatch(seen.text, new RegExp(`${workspace.id}|${owner.username}`));

    const denied = await guest.post(`/api/invites/${token}/accept`);
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.data, { ok: false, error: 'unauthorized' });
    assert.equal((await detail(owner.visitor, workspace.id)).members.length, 1);

    // Вошедший, но ещё не участник — видит то же и может принять
    const invitee = await registerUser(ctx.baseUrl);
    const forInvitee = (await invitee.visitor.get(`/api/invites/${token}`)).data.invite;
    assert.equal(forInvitee.viewer, 'invitee');
    assert.deepEqual(forInvitee.workspace, { name: 'Утренний эфир' });
  });

  it('принятое приглашение делает человека модератором и больше ни для кого не действует', async () => {
    const owner = await registerUser(ctx.baseUrl);
    const workspace = await createWorkspace(owner.visitor, 'Одноразовая ссылка');
    const { token, invite } = await createInvite(owner.visitor, workspace.id);
    const first = await registerUser(ctx.baseUrl, { displayName: 'Первый' });
    const second = await registerUser(ctx.baseUrl, { displayName: 'Второй' });

    const accepted = await first.visitor.post(`/api/invites/${token}/accept`);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.data, { ok: true, workspace: { id: workspace.id, name: 'Одноразовая ссылка' }, alreadyMember: false });

    const team = await detail(owner.visitor, workspace.id);
    assert.deepEqual(team.members.map((m) => [m.role, m.username]), [['owner', owner.username], ['moderator', first.username]]);
    assert.deepEqual(team.invites, [], 'использованное приглашение уходит из списка ожидающих');
    assert.equal((await detail(first.visitor, workspace.id)).workspace.role, 'moderator');

    // Второй человек по той же ссылке войти не может — ни посмотреть, ни принять
    for (const res of [await second.visitor.get(`/api/invites/${token}`), await second.visitor.post(`/api/invites/${token}/accept`)]) {
      assert.equal(res.status, 404);
      assert.deepEqual(res.data, { ok: false, error: 'invite_invalid' });
    }
    assert.equal((await createVisitor(ctx.baseUrl).get(`/api/invites/${token}`)).status, 404);
    assert.equal((await second.visitor.get(`/api/workspaces/${workspace.id}`)).status, 404);

    // Сам вошедший, открыв старую ссылку, попадает в площадку; повторное «принять» — не ошибка
    assert.deepEqual((await first.visitor.get(`/api/invites/${token}`)).data.invite, {
      state: 'joined', workspace: { id: workspace.id, name: 'Одноразовая ссылка' },
    });
    assert.deepEqual((await first.visitor.post(`/api/invites/${token}/accept`)).data, {
      ok: true, workspace: { id: workspace.id, name: 'Одноразовая ссылка' }, alreadyMember: true,
    });
    assert.equal((await detail(owner.visitor, workspace.id)).members.length, 2);

    // Отозвать использованную ссылку нельзя: человек уже в команде, его убирают там
    const late = await owner.visitor.post(`/api/workspaces/${workspace.id}/invites/${invite.id}/revoke`);
    assert.equal(late.status, 409);
    assert.deepEqual(late.data, { ok: false, error: 'invite_already_used' });
    assert.equal((await detail(first.visitor, workspace.id)).ok, true);

    // Убранный модератор по своей старой ссылке вернуться не может
    await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: first.username });
    assert.equal((await first.visitor.get(`/api/invites/${token}`)).status, 404);
    assert.equal((await first.visitor.post(`/api/invites/${token}/accept`)).status, 404);
    assert.equal((await first.visitor.get(`/api/workspaces/${workspace.id}`)).status, 404);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM workspace_invites WHERE public_id = ?').get(invite.id).n, 0);
  });

  it('отозванное приглашение перестаёт действовать сразу', async () => {
    const owner = await registerUser(ctx.baseUrl);
    const workspace = await createWorkspace(owner.visitor);
    const keep = await createInvite(owner.visitor, workspace.id, 'остаётся');
    const drop = await createInvite(owner.visitor, workspace.id, 'отзываем');
    const invitee = await registerUser(ctx.baseUrl);
    assert.equal((await invitee.visitor.get(`/api/invites/${drop.token}`)).status, 200);

    const revoked = await owner.visitor.post(`/api/workspaces/${workspace.id}/invites/${drop.invite.id}/revoke`);
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.data, { ok: true, revoked: true });

    for (const res of [await invitee.visitor.get(`/api/invites/${drop.token}`), await invitee.visitor.post(`/api/invites/${drop.token}/accept`)]) {
      assert.equal(res.status, 404);
      assert.equal(res.data.error, 'invite_invalid');
    }
    assert.deepEqual((await detail(owner.visitor, workspace.id)).invites.map((i) => i.label), ['остаётся']);
    assert.equal((await detail(owner.visitor, workspace.id)).members.length, 1);

    // Повторный отзыв и отзыв несуществующего — «не найдено», а не сбой
    const rowId = ctx.db.prepare('SELECT id FROM workspace_invites WHERE public_id = ?').get(keep.invite.id).id;
    for (const id of [drop.invite.id, rowId, 0, -1, 'abc', keep.invite.id.toUpperCase(), `${keep.invite.id}0`, '1;DROP TABLE users', ' ']) {
      const res = await owner.visitor.post(`/api/workspaces/${workspace.id}/invites/${encodeURIComponent(id)}/revoke`);
      assert.equal(res.status, 404, `отзыв приглашения «${id}»`);
      assert.equal(res.data.error, 'invite_not_found');
    }
    // Оставшаяся ссылка работает
    assert.equal((await acceptInvite(invitee.visitor, keep.token)).alreadyMember, false);
  });

  it('приглашение другой площадки нельзя отозвать через свою', async () => {
    const alice = await registerUser(ctx.baseUrl);
    const bob = await registerUser(ctx.baseUrl);
    const aliceSpace = await createWorkspace(alice.visitor);
    const bobSpace = await createWorkspace(bob.visitor);
    const bobInvite = await createInvite(bob.visitor, bobSpace.id);

    // Номер приглашения настоящий, но принадлежит чужой площадке
    const res = await alice.visitor.post(`/api/workspaces/${aliceSpace.id}/invites/${bobInvite.invite.id}/revoke`);
    assert.equal(res.status, 404);
    assert.equal(res.data.error, 'invite_not_found');
    assert.equal((await alice.visitor.post(`/api/workspaces/${bobSpace.id}/invites/${bobInvite.invite.id}/revoke`)).status, 404);
    assert.equal((await createVisitor(ctx.baseUrl).get(`/api/invites/${bobInvite.token}`)).status, 200, 'приглашение Боба цело');
  });

  it('неиспользованное приглашение действует семь дней', async () => {
    const owner = await registerUser(ctx.baseUrl);
    const workspace = await createWorkspace(owner.visitor);
    const { token } = await createInvite(owner.visitor, workspace.id);
    const invitee = await registerUser(ctx.baseUrl);
    const startedAt = clock;

    try {
      clock = startedAt + 7 * DAY - MINUTE;
      assert.equal((await invitee.visitor.get(`/api/invites/${token}`)).status, 200, 'за минуту до срока ещё действует');

      clock = startedAt + 7 * DAY;
      for (const res of [await invitee.visitor.get(`/api/invites/${token}`), await invitee.visitor.post(`/api/invites/${token}/accept`)]) {
        assert.equal(res.status, 404);
        assert.equal(res.data.error, 'invite_invalid');
      }
      assert.deepEqual((await detail(owner.visitor, workspace.id)).invites, [], 'просроченное не показывается владельцу');
      assert.equal((await detail(owner.visitor, workspace.id)).members.length, 1);

      // Уборка раз в час стирает просроченные приглашения, а принятые и действующие не трогает
      const fresh = await createInvite(owner.visitor, workspace.id);
      const used = await createInvite(owner.visitor, workspace.id);
      await acceptInvite(invitee.visitor, used.token);
      const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM workspace_invites').get().n;
      const removed = ctx.server.workspaces.cleanup();
      assert.ok(removed >= 1);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM workspace_invites').get().n, before - removed);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM workspace_invites WHERE token_hash = ?').get(sha256Hex(`invite:${token}`)).n, 0);
      assert.equal((await invitee.visitor.get(`/api/invites/${fresh.token}`)).status, 200);
      assert.equal((await invitee.visitor.get(`/api/invites/${used.token}`)).data.invite.state, 'joined');
    } finally {
      clock = startedAt;
    }
  });

  it('свою площадку по приглашению не «принять», а модератор не тратит вторую ссылку', async () => {
    const owner = await registerUser(ctx.baseUrl);
    const workspace = await createWorkspace(owner.visitor, 'Своя и чужая ссылка');
    const first = await createInvite(owner.visitor, workspace.id);
    const second = await createInvite(owner.visitor, workspace.id);

    // Владелец открыл собственную ссылку
    const own = (await owner.visitor.get(`/api/invites/${first.token}`)).data.invite;
    assert.equal(own.viewer, 'owner');
    assert.deepEqual(own.workspace, { name: 'Своя и чужая ссылка', id: workspace.id });
    const selfAccept = await owner.visitor.post(`/api/invites/${first.token}/accept`);
    assert.equal(selfAccept.status, 409);
    assert.deepEqual(selfAccept.data, { ok: false, error: 'invite_own_workspace' });

    // Модератор, уже вошедший по первой ссылке, открывает вторую: она остаётся целой
    const moderator = await registerUser(ctx.baseUrl);
    await acceptInvite(moderator.visitor, first.token);
    const again = (await moderator.visitor.get(`/api/invites/${second.token}`)).data.invite;
    assert.equal(again.viewer, 'member');
    assert.equal(again.workspace.id, workspace.id);
    assert.deepEqual(await acceptInvite(moderator.visitor, second.token), {
      ok: true, workspace: { id: workspace.id, name: 'Своя и чужая ссылка' }, alreadyMember: true,
    });
    assert.deepEqual((await detail(owner.visitor, workspace.id)).invites.map((i) => i.id), [second.invite.id]);

    const other = await registerUser(ctx.baseUrl);
    assert.equal((await acceptInvite(other.visitor, second.token)).alreadyMember, false, 'вторая ссылка досталась другому человеку');
    assert.equal((await detail(owner.visitor, workspace.id)).members.length, 3);
  });

  it('по одной ссылке входит один человек, даже если двое нажали одновременно', async () => {
    const owner = await registerUser(ctx.baseUrl);
    const workspace = await createWorkspace(owner.visitor);
    const { token } = await createInvite(owner.visitor, workspace.id);
    const people = await Promise.all([1, 2, 3, 4].map(() => registerUser(ctx.baseUrl)));

    const results = await Promise.all(people.map((p) => p.visitor.post(`/api/invites/${token}/accept`)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 404, 404, 404]);
    assert.equal((await detail(owner.visitor, workspace.id)).members.length, 2);
  });

  it('испорченная ссылка — это «приглашение недействительно», а не сбой', async () => {
    const visitor = (await registerUser(ctx.baseUrl)).visitor;
    const good = newLinkToken(26);
    const broken = [
      good, // правильный вид, но такого приглашения нет
      good.slice(0, 25), `${good}0`, good.toUpperCase(), `${good.slice(0, 25)}i`, `${good.slice(0, 25)}_`,
      'x', '%00', '..%2F..%2Fapi%2Fhealth', encodeURIComponent("' OR 1=1 --"), encodeURIComponent('приглашение'), 'a'.repeat(5000),
    ];
    for (const token of broken) {
      for (const res of [await visitor.get(`/api/invites/${token}`), await visitor.post(`/api/invites/${token}/accept`)]) {
        assert.equal(res.status, 404, `ссылка «${token.slice(0, 40)}»`);
        assert.deepEqual(res.data, { ok: false, error: 'invite_invalid' });
      }
    }
    assert.equal((await visitor.get('/api/health')).data.ok, true);
  });
});

/* ========================================================================== */

describe('Этап 4 — живой канал площадки', () => {
  let ctx;
  let clock;
  let owner;
  let moderator;
  let stranger;
  let workspace;

  const wsUrl = (workspaceId, ticket) =>
    `${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=workspace:${workspaceId}${ticket ? `&ticket=${ticket}` : ''}`;

  async function liveTicket(visitor, workspaceId = workspace.id) {
    const res = await visitor.post(`/api/workspaces/${workspaceId}/live`);
    assert.equal(res.status, 200, `пропуск не выдан: ${res.text}`);
    return res.data.ticket;
  }

  async function joinLive(visitor, workspaceId = workspace.id) {
    const socket = await openSocket(wsUrl(workspaceId, await liveTicket(visitor, workspaceId)));
    const hello = await socket.next();
    assert.equal(hello.type, 'hello');
    assert.equal(hello.channel, `workspace:${workspaceId}`);
    return socket;
  }

  // Отказ всегда выглядит одинаково: одно сообщение без объяснений и закрытие соединения
  async function expectDenied(url, options) {
    const socket = await openSocket(url, options);
    assert.deepEqual(await socket.next(), { type: 'denied' });
    assert.equal((await socket.closed).code, 4403);
  }

  const connected = async () => (await createVisitor(ctx.baseUrl).get('/api/health')).data.realtime.connectedClients;

  before(async () => {
    clock = Date.now();
    ctx = await startServer({ now: () => clock });
    owner = await registerUser(ctx.baseUrl, { displayName: 'Владелец' });
    stranger = await registerUser(ctx.baseUrl, { displayName: 'Посторонний' });
    workspace = await createWorkspace(owner.visitor, 'Живая площадка');
    moderator = await addModerator(ctx.baseUrl, owner.visitor, workspace.id, { displayName: 'Модератор' });
  });
  after(async () => { await ctx.stop(); });

  it('пропуск в канал получает только участник площадки, и только запросом с нашего сайта', async () => {
    for (const visitor of [owner.visitor, moderator.visitor]) {
      const res = await visitor.post(`/api/workspaces/${workspace.id}/live`);
      assert.equal(res.status, 200);
      assert.match(res.data.ticket, LIVE_TICKET);
      assert.deepEqual(res.data, { ok: true, ticket: res.data.ticket, expiresInSeconds: 30 });
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }

    const guest = await createVisitor(ctx.baseUrl).post(`/api/workspaces/${workspace.id}/live`);
    assert.equal(guest.status, 401);
    const outsider = await stranger.visitor.post(`/api/workspaces/${workspace.id}/live`);
    assert.equal(outsider.status, 404);
    assert.deepEqual(outsider.data, { ok: false, error: 'workspace_not_found' });

    // Чужой сайт не может получить пропуск от имени вошедшего владельца
    for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://evil.example' }]) {
      const res = await owner.visitor.post(`/api/workspaces/${workspace.id}/live`, {}, { headers });
      assert.equal(res.status, 403);
      assert.deepEqual(res.data, { ok: false, error: 'cross_site_request' });
    }
    // Пропуск выдаётся только командой (POST): простой переход по ссылке его не создаёт
    assert.equal((await owner.visitor.get(`/api/workspaces/${workspace.id}/live`)).status, 404);
  });

  it('с пропуском участник входит в канал площадки; пропуск одноразовый', async () => {
    const before = await connected();
    const ticket = await liveTicket(owner.visitor);
    const socket = await openSocket(wsUrl(workspace.id, ticket));
    const hello = await socket.next();
    assert.equal(hello.type, 'hello');
    assert.equal(hello.channel, `workspace:${workspace.id}`);
    assert.equal(await connected(), before + 1);

    // Замер задержки работает и в канале площадки
    socket.ws.send(JSON.stringify({ type: 'ping', clientTs: 5 }));
    assert.equal((await socket.next()).type, 'pong');

    // Тот же пропуск второй раз не действует — даже пока первое соединение открыто
    await expectDenied(wsUrl(workspace.id, ticket));
    assert.equal(await connected(), before + 1, 'соединение, получившее отказ, не считается подключённым');

    await socket.close();
  });

  it('без пропуска в канал площадки не попасть — даже с действующим входом в cookie', async () => {
    const cookie = [...owner.visitor.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    assert.match(cookie, /ks_session=/);
    const before = await connected();

    await expectDenied(wsUrl(workspace.id), { headers: { Cookie: cookie } });
    await expectDenied(wsUrl(workspace.id, ''), { headers: { Cookie: cookie } });
    for (const ticket of ['x', 'undefined', '0'.repeat(26), 'Z'.repeat(26), '%00', `${'a'.repeat(26)}&ticket=${'b'.repeat(26)}`]) {
      await expectDenied(wsUrl(workspace.id, ticket), { headers: { Cookie: cookie } });
    }
    // Канал несуществующей площадки и канал с испорченным именем — тот же отказ
    await expectDenied(wsUrl(newLinkToken(12), await liveTicket(owner.visitor)));
    await expectDenied(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=workspace:`);
    await expectDenied(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=workspace:${workspace.id}:extra&ticket=${await liveTicket(owner.visitor)}`);
    assert.equal(await connected(), before);
  });

  it('пропуск действует только для своей площадки и только полминуты', async () => {
    const other = await createWorkspace(owner.visitor, 'Другая площадка владельца');
    const forOther = await liveTicket(owner.visitor, other.id);
    // Пропуск от одной площадки не открывает канал другой — и при этом сгорает
    await expectDenied(wsUrl(workspace.id, forOther));
    await expectDenied(wsUrl(other.id, forOther));

    const startedAt = clock;
    try {
      const late = await liveTicket(owner.visitor);
      const inTime = await liveTicket(owner.visitor);
      clock = startedAt + 29_000;
      const socket = await openSocket(wsUrl(workspace.id, inTime));
      assert.equal((await socket.next()).type, 'hello');
      await socket.close();
      clock = startedAt + 30_000;
      await expectDenied(wsUrl(workspace.id, late));
    } finally {
      clock = startedAt;
    }
  });

  it('у одного входа одновременно действует не больше четырёх пропусков', async () => {
    const tickets = [];
    for (let i = 0; i < 6; i += 1) tickets.push(await liveTicket(moderator.visitor));
    await expectDenied(wsUrl(workspace.id, tickets[0]));
    await expectDenied(wsUrl(workspace.id, tickets[1]));
    for (const ticket of tickets.slice(2)) {
      const socket = await openSocket(wsUrl(workspace.id, ticket));
      assert.equal((await socket.next()).type, 'hello');
      await socket.close();
    }
    // Чужие пропуска при этом не страдают: счёт у каждого входа свой
    const mine = await liveTicket(owner.visitor);
    for (let i = 0; i < 6; i += 1) await liveTicket(moderator.visitor);
    const socket = await openSocket(wsUrl(workspace.id, mine));
    assert.equal((await socket.next()).type, 'hello');
    await socket.close();
  });

  it('пропуск, выданный до потери прав, после неё не действует', async () => {
    const temp = await addModerator(ctx.baseUrl, owner.visitor, workspace.id);
    const ticket = await liveTicket(temp.visitor);
    await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: temp.username });
    await expectDenied(wsUrl(workspace.id, ticket));

    // То же — если человек вышел из аккаунта, не успев подключиться
    const left = await addModerator(ctx.baseUrl, owner.visitor, workspace.id);
    const stale = await liveTicket(left.visitor);
    await left.visitor.post('/api/auth/logout');
    await expectDenied(wsUrl(workspace.id, stale));
    await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: left.username });
  });

  it('изменения на площадке сразу приходят её открытым страницам; приглашения — только владельцу', async () => {
    const ownerSocket = await joinLive(owner.visitor);
    const ownerSecondTab = await joinLive(owner.visitor);
    const moderatorSocket = await joinLive(moderator.visitor);

    // Владелец создал приглашение: об этом узнают только его страницы
    const { token, invite } = await createInvite(owner.visitor, workspace.id, 'новичку');
    assert.deepEqual(await ownerSocket.next(), { type: 'workspace:changed', what: 'invites', mine: true });
    assert.deepEqual(await ownerSecondTab.next(), { type: 'workspace:changed', what: 'invites', mine: true });

    // Новый человек принял приглашение: команда изменилась для всех
    const newcomer = await registerUser(ctx.baseUrl);
    await acceptInvite(newcomer.visitor, token);
    assert.deepEqual(await ownerSocket.next(), { type: 'workspace:changed', what: 'team', mine: false });
    assert.deepEqual(await ownerSecondTab.next(), { type: 'workspace:changed', what: 'team', mine: false });
    // Модератору первым пришло именно это: о приглашении он не узнал
    assert.deepEqual(await moderatorSocket.next(), { type: 'workspace:changed', what: 'team', mine: false });

    // Сообщение не несёт данных: ни имён, ни ссылок, ни номеров
    assert.doesNotMatch(JSON.stringify(ownerSocket.inbox), new RegExp(`${token}|${invite.id}|${newcomer.username}`));

    // Переименование: тому, кто его сделал, приходит пометка «это вы»
    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка 2' });
    assert.deepEqual(await ownerSocket.next(), { type: 'workspace:changed', what: 'name', mine: true });
    assert.deepEqual(await moderatorSocket.next(), { type: 'workspace:changed', what: 'name', mine: false });
    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка' });
    await ownerSocket.next();
    await moderatorSocket.next();

    // Отзыв приглашения — снова только владельцу; отклонённые действия никому не сообщаются
    const second = await createInvite(owner.visitor, workspace.id);
    await ownerSocket.next();
    await moderator.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Захват' });
    await owner.visitor.post(`/api/workspaces/${workspace.id}/invites/${second.invite.id}/revoke`);
    assert.deepEqual(await ownerSocket.next(), { type: 'workspace:changed', what: 'invites', mine: true });

    await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: newcomer.username });
    assert.deepEqual(await ownerSocket.next(), { type: 'workspace:changed', what: 'team', mine: true });
    assert.deepEqual(await moderatorSocket.next(), { type: 'workspace:changed', what: 'team', mine: false });

    for (const socket of [ownerSocket, ownerSecondTab, moderatorSocket]) await socket.close();
  });

  it('события одной площадки не попадают на страницы другой', async () => {
    const other = await createWorkspace(stranger.visitor, 'Площадка постороннего');
    const strangerSocket = await joinLive(stranger.visitor, other.id);
    const ownerSocket = await joinLive(owner.visitor);

    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка!' });
    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка' });
    await stranger.visitor.patch(`/api/workspaces/${other.id}`, { name: 'Площадка постороннего 2' });

    // Постороннему пришло только событие его собственной площадки
    assert.deepEqual(await strangerSocket.next(), { type: 'workspace:changed', what: 'name', mine: true });
    assert.deepEqual(strangerSocket.inbox, []);
    assert.equal((await ownerSocket.next()).what, 'name');
    assert.equal((await ownerSocket.next()).what, 'name');
    assert.deepEqual(ownerSocket.inbox, []);

    await strangerSocket.close();
    await ownerSocket.close();
  });

  it('убранный модератор отключается от канала сразу и больше ничего не получает', async () => {
    const temp = await addModerator(ctx.baseUrl, owner.visitor, workspace.id);
    const ownerSocket = await joinLive(owner.visitor);
    const tempSocket = await joinLive(temp.visitor);
    const tempSecondTab = await joinLive(temp.visitor);
    const before = await connected();

    await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: temp.username });
    for (const socket of [tempSocket, tempSecondTab]) {
      assert.deepEqual(await socket.next(), { type: 'denied' });
      assert.equal((await socket.closed).code, 4403);
    }
    assert.deepEqual(await ownerSocket.next(), { type: 'workspace:changed', what: 'team', mine: true });
    assert.equal(await connected(), before - 2);

    // Вернуться в канал он не может: пропуск ему больше не выдают
    assert.equal((await temp.visitor.post(`/api/workspaces/${workspace.id}/live`)).status, 404);
    await ownerSocket.close();
  });

  it('модератор, вышедший из площадки сам, отключается так же', async () => {
    const temp = await addModerator(ctx.baseUrl, owner.visitor, workspace.id);
    const ownerSocket = await joinLive(owner.visitor);
    const tempSocket = await joinLive(temp.visitor);

    await temp.visitor.post(`/api/workspaces/${workspace.id}/leave`);
    assert.deepEqual(await tempSocket.next(), { type: 'denied' });
    assert.equal((await tempSocket.closed).code, 4403);
    assert.deepEqual(await ownerSocket.next(), { type: 'workspace:changed', what: 'team', mine: false });
    await ownerSocket.close();
  });

  it('когда вход закрывается, его страницы отключаются сразу — не дожидаясь событий площадки', async () => {
    const temp = await addModerator(ctx.baseUrl, owner.visitor, workspace.id);
    const login = async () => {
      const visitor = createVisitor(ctx.baseUrl);
      assert.equal((await visitor.post('/api/auth/login', { username: temp.username, password: temp.password })).status, 200);
      return visitor;
    };
    const expectDropped = async (socket) => {
      assert.deepEqual(await socket.next(), { type: 'denied' });
      assert.equal((await socket.closed).code, 4403);
    };
    const second = await login();

    const loggedOut = await joinLive(temp.visitor); // вход, который сейчас закроется
    const stillIn = await joinLive(second); // второй вход того же человека остаётся
    const ownerSocket = await joinLive(owner.visitor);
    const publicSocket = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=home`);
    assert.equal((await publicSocket.next()).type, 'hello');
    const before = await connected();

    // Обычный выход: на площадке ничего не происходило, а страница уже отключена
    await temp.visitor.post('/api/auth/logout');
    await expectDropped(loggedOut);
    assert.equal(await connected(), before - 1);
    // Остальные страницы никто не трогал: следующее событие приходит им как обычно
    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка — проверка выхода' });
    assert.deepEqual(await stillIn.next(), { type: 'workspace:changed', what: 'name', mine: false });
    assert.equal((await ownerSocket.next()).what, 'name');

    // Смена пароля закрывает остальные входы — и их страницы тоже. Вход, с которого меняли, остаётся
    const third = await login();
    const keeps = await joinLive(third);
    const newPassword = 'совсем другой пароль 77';
    assert.equal((await third.post('/api/account/password', { currentPassword: temp.password, newPassword })).status, 200);
    await expectDropped(stillIn);
    temp.password = newPassword;

    // «Выйти на всех устройствах» — отключаются все страницы человека, включая ту, с которой нажали
    const fourth = await login();
    const fourthSocket = await joinLive(fourth);
    assert.equal((await fourth.post('/api/auth/logout-all')).status, 200);
    await expectDropped(keeps);
    await expectDropped(fourthSocket);

    // Восстановление по коду закрывает все прежние входы
    const fifth = await login();
    const fifthSocket = await joinLive(fifth);
    const recovered = await createVisitor(ctx.baseUrl).post('/api/auth/recover', {
      username: temp.username, recoveryCode: temp.recoveryCode, newPassword: 'пароль после восстановления 5',
    });
    assert.equal(recovered.status, 200);
    await expectDropped(fifthSocket);
    temp.password = 'пароль после восстановления 5';

    // Повторный вход в том же браузере заменяет прежний вход: его страница отключается
    const sixth = await login();
    const sixthSocket = await joinLive(sixth);
    assert.equal((await sixth.post('/api/auth/login', { username: temp.username, password: temp.password })).status, 200);
    await expectDropped(sixthSocket);
    // …а с новым входом тот же браузер подключается заново
    const again = await joinLive(sixth);

    // За всё это время владелец и открытый канал не получили ничего лишнего и остались на связи
    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка' });
    assert.equal((await ownerSocket.next()).what, 'name');
    assert.deepEqual(ownerSocket.inbox, []);
    assert.equal((await again.next()).what, 'name');
    publicSocket.ws.send(JSON.stringify({ type: 'ping', clientTs: 1 }));
    assert.equal((await publicSocket.next()).type, 'pong');
    assert.deepEqual(publicSocket.inbox, []);

    await again.close();
    await publicSocket.close();
    await ownerSocket.close();
    await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: temp.username });
  });

  it('истёкший по времени вход отключается от канала при ближайшей уборке', async () => {
    const temp = await addModerator(ctx.baseUrl, owner.visitor, workspace.id);
    const socket = await joinLive(temp.visitor);
    const ownerSocket = await joinLive(owner.visitor);
    const before = await connected();

    // Страница месяц простояла открытой без единого обращения: срок её входа вышел
    const { db } = ctx;
    const expired = db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(clock - 1, userId(db, temp.username));
    assert.equal(Number(expired.changes), 1);

    // Даже до уборки такая страница ничего не получит: права проверяются перед каждой отправкой
    assert.equal((await temp.visitor.post(`/api/workspaces/${workspace.id}/live`)).status, 401);

    const second = await addModerator(ctx.baseUrl, owner.visitor, workspace.id);
    const secondSocket = await joinLive(second.visitor);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(clock - 1, userId(db, second.username));
    // Ежечасная уборка устаревших записей (здесь — вручную) отключает такие страницы
    assert.ok(ctx.server.accounts.cleanup() >= 1);
    assert.deepEqual(await secondSocket.next(), { type: 'denied' });
    assert.equal((await secondSocket.closed).code, 4403);
    assert.deepEqual(await socket.next(), { type: 'denied' });
    assert.equal((await socket.closed).code, 4403);
    assert.equal(await connected(), before - 1, 'владелец остался на связи');
    assert.deepEqual(ownerSocket.inbox.filter((msg) => msg.type === 'denied'), []);

    await ownerSocket.close();
    for (const person of [temp, second]) {
      await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: person.username });
    }
  });

  it('при удалении площадки отключаются все её страницы', async () => {
    const doomed = await createWorkspace(owner.visitor, 'Под снос');
    const mod = await addModerator(ctx.baseUrl, owner.visitor, doomed.id);
    const ownerSocket = await joinLive(owner.visitor, doomed.id);
    const modSocket = await joinLive(mod.visitor, doomed.id);
    const bystander = await joinLive(moderator.visitor); // страница другой площадки
    const before = await connected();

    await owner.visitor.post(`/api/workspaces/${doomed.id}/delete`, { confirmName: 'Под снос' });
    for (const socket of [ownerSocket, modSocket]) {
      assert.deepEqual(await socket.next(), { type: 'denied' });
      assert.equal((await socket.closed).code, 4403);
    }
    assert.equal(await connected(), before - 2);

    // Соседнюю площадку это не затронуло
    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка.' });
    assert.deepEqual(await bystander.next(), { type: 'workspace:changed', what: 'name', mine: false });
    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка' });
    await bystander.close();
  });

  it('открытые каналы работают как раньше — без входа и без пропуска', async () => {
    const socket = await openSocket(`${ctx.baseUrl.replace('http:', 'ws:')}/ws?channel=home`);
    const hello = await socket.next();
    assert.equal(hello.type, 'hello');
    assert.equal(hello.channel, 'home');
    // События площадок в открытые каналы не попадают
    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка?' });
    await owner.visitor.patch(`/api/workspaces/${workspace.id}`, { name: 'Живая площадка' });
    socket.ws.send(JSON.stringify({ type: 'ping', clientTs: 1 }));
    assert.equal((await socket.next()).type, 'pong');
    assert.deepEqual(socket.inbox, []);
    await socket.close();
  });
});

/* ========================================================================== */

describe('Этап 4 — пределы', () => {
  const tight = {
    ownedWorkspaces: 3,
    moderatorsPerWorkspace: 2,
    pendingInvitesPerWorkspace: 3,
    workspaceCreationsPerUser: { limit: 100, windowMs: HOUR },
    inviteCreationsPerUser: { limit: 100, windowMs: HOUR },
  };

  it('у одного владельца ограниченное число площадок; чужие, где он модератор, в счёт не идут', async () => {
    const ctx = await startServer({ workspaceLimits: tight });
    try {
      const owner = await registerUser(ctx.baseUrl);
      const other = await registerUser(ctx.baseUrl);
      const foreign = await createWorkspace(other.visitor);
      await acceptInvite(owner.visitor, (await createInvite(other.visitor, foreign.id)).token);

      const mine = [];
      for (let i = 0; i < 3; i += 1) mine.push(await createWorkspace(owner.visitor));
      const list = (await owner.visitor.get('/api/workspaces')).data;
      assert.deepEqual([list.owned, list.ownedLimit, list.workspaces.length], [3, 3, 4]);

      const over = await owner.visitor.post('/api/workspaces', { name: 'Четвёртая' });
      assert.equal(over.status, 409);
      assert.deepEqual(over.data, { ok: false, error: 'workspaces_limit', limit: 3 });

      // Удалил одну — место освободилось
      await owner.visitor.post(`/api/workspaces/${mine[0].id}/delete`, { confirmName: mine[0].name });
      await createWorkspace(owner.visitor, 'Четвёртая');
    } finally {
      await ctx.stop();
    }
  });

  it('число модераторов и число неиспользованных приглашений ограничены', async () => {
    const ctx = await startServer({ workspaceLimits: tight });
    try {
      const owner = await registerUser(ctx.baseUrl);
      const workspace = await createWorkspace(owner.visitor);

      const invites = [];
      for (let i = 0; i < 3; i += 1) invites.push(await createInvite(owner.visitor, workspace.id));
      const tooMany = await owner.visitor.post(`/api/workspaces/${workspace.id}/invites`, {});
      assert.equal(tooMany.status, 409);
      assert.deepEqual(tooMany.data, { ok: false, error: 'invites_limit', limit: 3 });

      // Два модератора входят, третьему места нет — и его ссылка остаётся неиспользованной
      const people = [];
      for (let i = 0; i < 3; i += 1) people.push(await registerUser(ctx.baseUrl));
      await acceptInvite(people[0].visitor, invites[0].token);
      await acceptInvite(people[1].visitor, invites[1].token);
      const full = await people[2].visitor.post(`/api/invites/${invites[2].token}/accept`);
      assert.equal(full.status, 409);
      assert.deepEqual(full.data, { ok: false, error: 'members_limit', limit: 2 });
      assert.equal((await detail(owner.visitor, workspace.id)).invites.length, 1);

      // Пока команда полна, новые приглашения не создаются
      const pointless = await owner.visitor.post(`/api/workspaces/${workspace.id}/invites`, {});
      assert.equal(pointless.status, 409);
      assert.equal(pointless.data.error, 'members_limit');

      // Место освободилось — та же ссылка срабатывает
      await owner.visitor.post(`/api/workspaces/${workspace.id}/members/remove`, { username: people[0].username });
      assert.equal((await acceptInvite(people[2].visitor, invites[2].token)).alreadyMember, false);
    } finally {
      await ctx.stop();
    }
  });

  it('площадки и приглашения нельзя создавать без конца: после предела — пауза с указанием срока', async () => {
    let clock = Date.now();
    const ctx = await startServer({
      now: () => clock,
      workspaceLimits: {
        ownedWorkspaces: 100,
        pendingInvitesPerWorkspace: 100,
        workspaceCreationsPerUser: { limit: 3, windowMs: HOUR },
        inviteCreationsPerUser: { limit: 4, windowMs: HOUR },
      },
    });
    try {
      const owner = await registerUser(ctx.baseUrl);
      const other = await registerUser(ctx.baseUrl);

      // Отклонённые попытки (плохое название) в счёт не идут
      for (let i = 0; i < 5; i += 1) assert.equal((await owner.visitor.post('/api/workspaces', { name: '' })).status, 400);
      const made = [];
      for (let i = 0; i < 3; i += 1) made.push(await createWorkspace(owner.visitor));

      const blocked = await owner.visitor.post('/api/workspaces', { name: 'Лишняя' });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.data.error, 'too_many_requests');
      assert.ok(blocked.data.retryAfterSeconds > 0 && blocked.data.retryAfterSeconds <= 3600);
      assert.equal(blocked.headers.get('retry-after'), String(blocked.data.retryAfterSeconds));
      // Удаление не возвращает попытки: иначе создание и удаление можно было бы гонять по кругу
      await owner.visitor.post(`/api/workspaces/${made[0].id}/delete`, { confirmName: made[0].name });
      assert.equal((await owner.visitor.post('/api/workspaces', { name: 'Лишняя' })).status, 429);
      // Предел у каждого свой
      await createWorkspace(other.visitor);

      for (let i = 0; i < 4; i += 1) await createInvite(owner.visitor, made[1].id);
      const invBlocked = await owner.visitor.post(`/api/workspaces/${made[1].id}/invites`, {});
      assert.equal(invBlocked.status, 429);
      assert.equal(invBlocked.data.error, 'too_many_requests');
      // Предел общий на все площадки владельца
      assert.equal((await owner.visitor.post(`/api/workspaces/${made[2].id}/invites`, {})).status, 429);

      clock += HOUR + 1000;
      await createWorkspace(owner.visitor, 'Через час');
      await createInvite(owner.visitor, made[2].id);
    } finally {
      await ctx.stop();
    }
  });
});

/* ========================================================================== */

describe('Этап 4 — защита и страницы', () => {
  let ctx;
  let owner;
  let workspace;
  let invite;
  before(async () => {
    ctx = await startServer();
    owner = await registerUser(ctx.baseUrl);
    workspace = await createWorkspace(owner.visitor, 'Страницы');
    invite = await createInvite(owner.visitor, workspace.id);
  });
  after(async () => { await ctx.stop(); });

  it('команды с чужих сайтов отклоняются, даже когда человек вошёл', async () => {
    const commands = [
      ['POST', '/api/workspaces', { name: 'С чужого сайта' }],
      ['PATCH', `/api/workspaces/${workspace.id}`, { name: 'С чужого сайта' }],
      ['POST', `/api/workspaces/${workspace.id}/delete`, { confirmName: 'Страницы' }],
      ['POST', `/api/workspaces/${workspace.id}/invites`, {}],
      ['POST', `/api/workspaces/${workspace.id}/invites/${invite.invite.id}/revoke`, {}],
      ['POST', `/api/invites/${invite.token}/accept`, {}],
    ];
    const foreign = [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://evil.example' }];
    for (const [method, url, body] of commands) {
      for (const headers of foreign) {
        const res = method === 'PATCH'
          ? await owner.visitor.patch(url, body, { headers })
          : await owner.visitor.post(url, body, { headers });
        assert.equal(res.status, 403, `${method} ${url} с заголовками ${JSON.stringify(headers)}`);
        assert.deepEqual(res.data, { ok: false, error: 'cross_site_request' });
      }
      // Обычная форма с чужого сайта (не JSON) тоже не проходит
      const form = await owner.visitor.post(url, 'name=x', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      assert.ok(method === 'PATCH' || form.status === 415, `${url}: форма должна быть отклонена`);
    }
    const after = await detail(owner.visitor, workspace.id);
    assert.equal(after.workspace.name, 'Страницы');
    assert.equal(after.invites.length, 1);
    assert.equal((await owner.visitor.get('/api/workspaces')).data.workspaces.length, 1);
  });

  it('ответы о площадках и приглашениях браузер не запоминает', async () => {
    const guest = createVisitor(ctx.baseUrl);
    for (const res of [
      await owner.visitor.get('/api/workspaces'),
      await owner.visitor.get(`/api/workspaces/${workspace.id}`),
      await guest.get(`/api/invites/${invite.token}`),
      await guest.get(`/api/invites/${newLinkToken(26)}`),
      await guest.get('/api/workspaces'),
    ]) {
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  });

  it('мусор вместо данных не роняет сервер', async () => {
    const v = owner.visitor;
    const ids = [
      'x', '0', workspace.id.toUpperCase(), `${workspace.id}0`, workspace.id.slice(0, 11), '%00', '%2e%2e%2e', 'площадка',
      encodeURIComponent("' OR '1'='1"), 'a'.repeat(4000),
    ];
    for (const id of ids) {
      for (const res of [
        await v.get(`/api/workspaces/${id}`),
        await v.patch(`/api/workspaces/${id}`, { name: 'x' }),
        await v.post(`/api/workspaces/${id}/delete`, { confirmName: 'Страницы' }),
        await v.post(`/api/workspaces/${id}/invites`, {}),
      ]) {
        assert.equal(res.status, 404, `адрес площадки «${id.slice(0, 30)}»`);
        assert.equal(res.data.error, 'workspace_not_found');
      }
    }

    // Не JSON, не объект, слишком большое тело
    const raw = (body) => v.post('/api/workspaces', body, { headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual((await raw('{ это не json')).data, { ok: false, error: 'invalid_json' });
    assert.equal((await raw('"строка"')).status, 400);
    assert.equal((await raw('null')).status, 400);
    assert.equal((await raw('[]')).data.error, 'workspace_name_required');
    const huge = await raw(JSON.stringify({ name: 'я'.repeat(20000) }));
    assert.equal(huge.status, 413);
    assert.deepEqual(huge.data, { ok: false, error: 'payload_too_large' });

    // Некорректное кодирование адреса
    const bad = await v.get('/api/workspaces/%E0%A4%A');
    assert.equal(bad.status, 400);
    assert.doesNotMatch(bad.text, /node_modules|at\s+\S+\s+\(/);

    // Неизвестные адреса внутри раздела
    assert.equal((await v.get(`/api/workspaces/${workspace.id}/secrets`)).status, 404);
    assert.equal((await v.post(`/api/workspaces/${workspace.id}/members`, {})).status, 404);
    assert.equal((await v.get('/api/invites')).status, 404);

    assert.equal((await v.get('/api/health')).data.ok, true);
    assert.equal((await detail(v, workspace.id)).workspace.name, 'Страницы');
  });

  it('страница площадки закрыта для гостей: ведёт на вход и после него возвращает обратно', async () => {
    const guest = createVisitor(ctx.baseUrl);
    const address = `/app/w/${workspace.id}`;
    const res = await guest.get(address);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(address)}`);
    assert.equal(safeNextPath(address), address);

    const page = await owner.visitor.get(address);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    // Страница одинакова для всех — и для того, у кого доступа к этой площадке нет:
    // это просто файл, данных площадки в нём нет. Доступ решает запрос данных
    const outsider = await registerUser(ctx.baseUrl);
    const forOutsider = await outsider.visitor.get(address);
    assert.equal(forOutsider.status, 200);
    assert.equal(forOutsider.text, page.text);
    assert.equal(page.text, fs.readFileSync(path.join(PROJECT_DIR, 'public/workspace.html'), 'utf8'));
    assert.equal((await outsider.visitor.get(`/api/workspaces/${workspace.id}`)).status, 404);

    // Заведомо неверный адрес — обычное «не найдено», без похода на страницу входа
    for (const bad of ['/app/w/x', `/app/w/${workspace.id}0`, `/app/w/${workspace.id.toUpperCase()}`, '/app/w/', `/app/w/${workspace.id}/extra`]) {
      const lost = await guest.get(bad, { headers: { Accept: 'text/html' } });
      assert.equal(lost.status, 404, bad);
      assert.match(lost.text, /Страница не найдена/);
    }
    // Как файл страницу получить нельзя
    assert.equal((await owner.visitor.get('/workspace.html')).status, 404);
    assert.equal((await owner.visitor.get('/invite.html')).status, 404);
  });

  it('страница приглашения открыта гостю, не запоминается и не сообщает свой адрес другим страницам', async () => {
    const guest = createVisitor(ctx.baseUrl);
    const address = `/invite/${invite.token}`;
    const page = await guest.get(address);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.doesNotMatch(page.text, new RegExp(invite.token), 'самой ссылки в разметке страницы нет');
    // Остальные страницы сообщают другим сайтам только свой адрес сайта, как и раньше
    assert.equal((await guest.get('/')).headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

    // Испорченная ссылка открывает ту же страницу: там человеку объяснят, что делать
    assert.equal((await guest.get('/invite/oborvannaya-ssylka')).status, 200);
    assert.equal((await guest.get('/invite', { headers: { Accept: 'text/html' } })).status, 404);

    // Гость после входа или регистрации возвращается к приглашению
    assert.equal(safeNextPath(address), address);
    const signedIn = await owner.visitor.get(`/login?next=${encodeURIComponent(address)}`);
    assert.equal(signedIn.status, 302);
    assert.equal(signedIn.headers.get('location'), address);
  });
});

/* ========================================================================== */

describe('Этап 4 — страницы и тексты', () => {
  const publicDir = path.join(PROJECT_DIR, 'public');
  const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');

  it('каждый отказ сервера о площадках и приглашениях имеет понятный текст на странице', async () => {
    // Берём тот самый файл, который загружает браузер, и спрашиваем у него текст для каждого отказа
    const { describeError } = await import('../public/js/core/session.js');
    const code = fs.readFileSync(path.join(PROJECT_DIR, 'src/server/workspaces/workspaces.js'), 'utf8');
    const serverCodes = new Set([...code.matchAll(/new AppError\('([a-z_]+)'/g)].map((m) => m[1]));
    assert.ok(serverCodes.size >= 17, `найдено кодов: ${serverCodes.size}`);

    const fallback = describeError({ status: 400, data: { error: 'no_such_code' } });
    const texts = new Map();
    for (const errorCode of serverCodes) {
      // Сервер прикладывает к отказу число (предел или время ожидания) — оно должно попасть в текст
      const text = describeError({ status: 409, data: { error: errorCode, limit: 37, retryAfterSeconds: 37 } });
      assert.notEqual(text, fallback, `для отказа «${errorCode}» на странице нет своего текста`);
      assert.match(text, /^[А-ЯЁ].*[.!]$/, `«${errorCode}»: ${text}`);
      assert.doesNotMatch(text, /undefined|NaN|null|\[object|[a-z]_[a-z]/, `«${errorCode}»: ${text}`);
      texts.set(errorCode, text);
    }
    // Разные отказы объясняются разными словами
    assert.equal(new Set(texts.values()).size, texts.size);
    for (const errorCode of ['workspaces_limit', 'members_limit', 'invites_limit', 'too_many_requests']) {
      assert.match(texts.get(errorCode), /37/, `«${errorCode}»: в тексте нет числа, которое прислал сервер`);
    }
    // Число согласуется со словом
    const limit = (n) => describeError({ status: 409, data: { error: 'members_limit', limit: n } });
    assert.match(limit(1), /1 модератор /);
    assert.match(limit(3), /3 модератора /);
    assert.match(limit(50), /50 модераторов /);
    assert.match(limit(11), /11 модераторов /);
    assert.match(limit(21), /21 модератор /);
  });

  it('кнопка «Выйти» на странице площадки ведёт на главную, а не на страницу входа', async (t) => {
    /* Сервер, закрыв вход, тут же отключает страницу от живого канала. Страница не должна принять
       это за «вход закрыли с другого устройства»: человек вышел сам и ждёт главную страницу. */
    const session = await import('../public/js/core/session.js');
    const moves = [];
    const realFetch = globalThis.fetch;
    const answer = { status: 200 };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.window = { location: { pathname: '/app/w/abc', search: '', hash: '#x', replace: (to) => moves.push(to) } };
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: answer.status < 400 }), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    });
    try {
      // Обычное поведение: вход закрыт где-то ещё — страница уходит на вход и помнит, куда вернуться
      session.goToLogin();
      assert.deepEqual(moves, ['/login?next=%2Fapp%2Fw%2Fabc%23x']);

      // Человек нажал «Выйти»: пока запрос идёт и сразу после него страница на вход не уходит
      const pending = session.logout();
      session.goToLogin();
      assert.deepEqual(await pending, { ok: true });
      session.goToLogin();
      assert.equal(moves.length, 1, 'после собственного выхода страница не уходит на вход');

      // Если страница почему-то осталась открытой, через несколько секунд всё как обычно
      t.mock.timers.tick(5000);
      session.goToLogin();
      assert.equal(moves.length, 2);

      // Выход не удался (сервер не ответил как надо) — пометка снимается сразу
      answer.status = 500;
      assert.equal((await session.logout()).ok, false);
      session.goToLogin();
      assert.equal(moves.length, 3);

      // «Выйти везде», когда вход уже закрыт, — тоже выход
      answer.status = 401;
      assert.deepEqual(await session.logout({ everywhere: true }), { ok: true });
      session.goToLogin();
      assert.equal(moves.length, 3);
      t.mock.timers.tick(5000);
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis.window;
    }
  });

  it('шапка кабинета помещается на телефоне шириной 320 точек: надписи индикатора связи короткие', () => {
    const script = read('js/core/cabinet.js');
    const labels = [...script.matchAll(/set\('(?:live|amber|muted)', '([^']+)'/g)].map((found) => found[1]);
    assert.deepEqual(labels, ['на связи', 'нет связи', 'отключено', 'связь…']);
    // Длиннее девяти знаков надпись вместе с названием сайта и кнопкой меню в 320 точек не входит
    for (const label of labels) assert.ok([...label].length <= 9, `надпись «${label}» слишком длинная для узкой шапки`);
    // Замер задержки — отдельная часть надписи, и на самых узких экранах стили её скрывают
    assert.match(script, /className: 'badge-extra'/);
    assert.match(
      read('styles/layout.css'),
      /@media \(max-width: 359px\) \{\s*\.topnav \.status-badge \.badge-extra \{\s*display: none;\s*\}\s*\}/
    );
  });

  /* Кнопок над списком слоёв восемь, и на палец каждая не меньше 40 точек.
     В 320 точек восемь таких кнопок в один ряд не встают: ряд становился шире
     страницы, и редактор начинал прокручиваться вбок. Проверяем именно то,
     из-за чего это было, — что на телефоне ряд перестаёт быть одним рядом. */
  it('кнопки над слоями помещаются на телефоне шириной 320 точек: две строки по четыре', () => {
    const css = read('styles/editor.css');
    const editor = read('editor.html');
    const tools = editor.match(/<div class="layer-tools"[\s\S]*?<\/div>/);
    assert.ok(tools, 'панель кнопок над слоями не найдена');
    const buttons = [...tools[0].matchAll(/<button\b/g)].length;
    assert.equal(buttons, 8, 'кнопок стало больше — проверь, встанут ли они в две строки по четыре');

    // На телефоне панель — сетка из четырёх равных столбцов, кнопки тянутся на всю ячейку
    const phone = css.match(/@media \(max-width: 620px\) \{([\s\S]*?)\n\}/);
    assert.ok(phone, 'правил для телефона в стилях редактора нет');
    assert.match(phone[1], /\.layer-tools \{\s*display: grid;\s*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/, 'на телефоне кнопки должны идти по четыре в строку');
    assert.match(phone[1], /\.layer-tools > \.icon-btn\.tool \{\s*width: 100%;\s*\}/, 'кнопка должна занимать всю ячейку');
    // Распорки, которые раньше раздвигали кнопки по краям, в сетке лишние
    assert.match(phone[1], /\.layer-tools \.tool-gap \{\s*display: none;\s*\}/, 'распорки в сетке только мешают');
    // И на палец кнопка остаётся не меньше 40 точек: четыре в ряд это 4×40 + три промежутка = 178 из 276
    assert.match(css, /@media \(hover: none\) and \(pointer: coarse\)[\s\S]*?\.icon-btn\.tool \{\s*width: 40px;\s*height: 40px;\s*\}/, 'кнопки для пальца не должны уменьшаться');
  });

  it('запрос страницы не ждёт ответа бесконечно: зависшая связь превращается в «нет связи»', async () => {
    const { request } = await import('../public/js/core/session.js');
    // Сервер, который принимает запрос и молчит
    const pending = [];
    const silent = http.createServer((req, res) => { pending.push(res); });
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${silent.address().port}/api/anything`;
    try {
      const startedAt = Date.now();
      const res = await request(address, { timeoutMs: 150 });
      assert.deepEqual(res, { ok: false, status: 0, data: { error: 'network' } });
      const took = Date.now() - startedAt;
      assert.ok(took >= 140 && took < 3000, `ожидание длилось ${took} мс`);
    } finally {
      pending.forEach((res) => res.destroy());
      await new Promise((resolve) => silent.close(resolve));
    }
    // Обычный ответ ограничение не задевает
    const quick = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, method: req.method, type: req.headers['content-type'] || null }));
    });
    await new Promise((resolve) => quick.listen(0, '127.0.0.1', resolve));
    try {
      const ok = await request(`http://127.0.0.1:${quick.address().port}/`, { method: 'POST', body: { a: 1 }, timeoutMs: 5000 });
      assert.deepEqual(ok, { ok: true, status: 200, data: { ok: true, method: 'POST', type: 'application/json' } });
    } finally {
      await new Promise((resolve) => quick.close(resolve));
    }
    // Предел по умолчанию задан и разумен
    assert.match(read('js/core/api.js'), /const REQUEST_TIMEOUT_MS = 20_000;/);
  });

  it('проверка прав не размазана по адресам: каждый адрес площадок передаёт, кто просит, из сеанса входа', () => {
    const http = fs.readFileSync(path.join(PROJECT_DIR, 'src/server/workspaces/http.js'), 'utf8');
    const routes = [...http.matchAll(/workspacesRouter\.(get|post|patch|put|delete)\(\s*'([^']+)'([\s\S]*?)\n  \}\);/g)];
    assert.ok(routes.length >= 9, `найдено адресов: ${routes.length}`);
    for (const [, method, route, body] of routes) {
      assert.match(body, /from\(req\)/, `${method.toUpperCase()} ${route}: не передано, кто просит`);
    }
    // Кто просит — только из сеанса
    assert.match(http, /const from = \(req\) => \(\{ userId: req\.auth\.userId, workspaceId: req\.params\.id \}\);/);
    assert.doesNotMatch(http, /fields\(req\)\.(userId|ownerId|role)/);
    // Вход обязателен для всего раздела разом, а не для каждого адреса по отдельности
    assert.match(http, /workspacesRouter\.use\(auth\.session, auth\.requireAuth\);/);
  });

  it('оформление строк, которые страницы собирают сами, описано в стилях', () => {
    const css = fs.readdirSync(path.join(publicDir, 'styles'))
      .filter((name) => name.endsWith('.css'))
      .map((name) => read(`styles/${name}`))
      .join('\n');
    const defined = new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));

    let checked = 0;
    for (const script of ['js/pages/workspace.js', 'js/pages/shell.js', 'js/core/cabinet.js']) {
      const code = read(script);
      const plain = [
        ...[...code.matchAll(/\bel\('[\w-]+',\s*'([^']*)'/g)].map((m) => m[1]),
        ...[...code.matchAll(/\bel\('[\w-]+',\s*[\w.]+\s*\?\s*'([^']*)'\s*:\s*'([^']*)'/g)].flatMap((m) => [m[1], m[2]]),
        ...[...code.matchAll(/className\s*[:=]\s*'([^']*)'/g)].map((m) => m[1]),
      ];
      // `status-badge ${isOwner ? 'crimson' : 'muted'}` — постоянная часть и слова в кавычках внутри ${…}
      const templates = [
        ...[...code.matchAll(/\bel\('[\w-]+',\s*`([^`]*)`/g)].map((m) => m[1]),
        ...[...code.matchAll(/className\s*=\s*`([^`]*)`/g)].map((m) => m[1]),
      ];
      for (const template of templates) {
        plain.push(template.replace(/\$\{[^}]*\}/g, ' '));
        for (const inner of template.matchAll(/\$\{([^}]*)\}/g)) {
          plain.push(...[...inner[1].matchAll(/'([^']*)'/g)].map((m) => m[1]));
        }
      }
      for (const literal of plain) {
        for (const cls of literal.split(/\s+/).filter(Boolean)) {
          assert.ok(defined.has(cls), `${script}: класс «${cls}» не описан в стилях`);
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 25, `проверено классов: ${checked}`);
  });

  it('страницы площадки и приглашения показывают чужой текст только как текст', () => {
    for (const script of ['js/pages/workspace.js', 'js/pages/invite.js', 'js/pages/shell.js']) {
      const code = read(script);
      assert.doesNotMatch(code, /\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/, `${script}: сборка разметки из строк`);
      assert.match(code, /textContent/, `${script}: данные должны вставляться как текст`);
    }
  });
});

/* ========================================================================== */

describe('Этап 4 — обновление с прошлого этапа', () => {
  it('база этапа 3 достраивается при запуске: аккаунты и входы на месте, площадки работают', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krafen-upgrade-'));
    const dbPath = path.join(tmpDir, 'auth-test.db');
    try {
      // База в том виде, в каком её оставил этап 3: аккаунт и действующий вход
      const old = openDatabase(dbPath, { upToVersion: 2 });
      assert.equal(old.getHealth().schemaVersion, 2);
      const tables = () => old.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workspace%'").all();
      assert.deepEqual(tables(), []);
      const accounts = createAccounts({ db: old.raw, passwordCost: FAST });
      const registered = await accounts.register({ username: 'old_timer', displayName: 'Старожил', password: GOOD_PASSWORD, ip: '127.0.0.1' });
      old.close();

      const ctx = await startServer({ tmpDir });
      try {
        const health = (await createVisitor(ctx.baseUrl).get('/api/health')).data;
        // Сервер достроил базу до нынешнего состояния — через все обновления, которых в ней не было
        assert.equal(health.db.schemaVersion, SCHEMA_VERSION);
        assert.equal(health.db.latestMigration, LATEST_MIGRATION);
        assert.equal(health.stage, PLATFORM_STAGE);

        // Прежний вход действует: человек не заметил обновления
        const visitor = createVisitor(ctx.baseUrl);
        visitor.jar.set('ks_session', registered.token);
        const session = (await visitor.get('/api/auth/session')).data;
        assert.equal(session.authenticated, true);
        assert.equal(session.user.displayName, 'Старожил');

        // Прежний пароль тоже
        const fresh = createVisitor(ctx.baseUrl);
        assert.equal((await fresh.post('/api/auth/login', { username: 'old_timer', password: GOOD_PASSWORD })).status, 200);

        const workspace = await createWorkspace(visitor, 'Первая площадка старожила');
        assert.equal((await detail(visitor, workspace.id)).members[0].displayName, 'Старожил');
      } finally {
        await ctx.stop({ keepFiles: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
