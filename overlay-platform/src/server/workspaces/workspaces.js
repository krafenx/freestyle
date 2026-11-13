import { createRateLimiter } from '../auth/rate-limit.js';
import { isLinkToken, newLinkToken, sha256Hex } from '../auth/tokens.js';
import { inTransaction } from '../db/database.js';
import { AppError, isUniqueViolation } from '../errors.js';
import { cleanLine, lengthOf } from '../text.js';

/* Площадки, модераторы и приглашения. Здесь только правила: кто что может
   и что при этом меняется в базе. Адреса и ответы сервера — в http.js.

   Роли:
     владелец  — создал площадку; он один. Переименовывает и удаляет площадку,
                 приглашает и убирает модераторов;
     модератор — вошёл по приглашению. Видит площадку и её команду, может сам
                 выйти из неё. Со сценой работает наравне с владельцем.

   Права проверяются здесь, при каждом действии: страница лишь прячет кнопки,
   которые человеку недоступны. Посторонний получает на любой запрос один и тот
   же ответ «площадка не найдена» — существует она или нет. */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const PUBLIC_ID_LENGTH = 12; // номер площадки или приглашения в адресе: 60 бит, не секрет
export const INVITE_TOKEN_LENGTH = 26; // ссылка-приглашение: 130 бит, секрет

const NAME_MAX = 40;
const LABEL_MAX = 40;

export const DEFAULT_WORKSPACE_LIMITS = Object.freeze({
  ownedWorkspaces: 10, // площадок у одного владельца
  moderatorsPerWorkspace: 50,
  pendingInvitesPerWorkspace: 20, // неиспользованных приглашений одновременно
  inviteTtlMs: 7 * DAY, // сколько действует неиспользованное приглашение
  // Защита от скриптов: человек столько за час не создаёт
  workspaceCreationsPerUser: { limit: 20, windowMs: HOUR },
  inviteCreationsPerUser: { limit: 60, windowMs: HOUR },
});

const iso = (ms) => new Date(ms).toISOString();
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const hashInviteToken = (token) => sha256Hex(`invite:${token}`);

export function createWorkspaces({ db, now = Date.now, limits = {}, onChange = null, onRemoved = null } = {}) {
  const rules = { ...DEFAULT_WORKSPACE_LIMITS, ...limits };
  const limiter = createRateLimiter({ now });
  const transaction = (work) => inTransaction(db, work);

  const sql = {
    /* Площадка глазами конкретного человека. role: owner, moderator или пусто —
       пусто означает, что человек к площадке отношения не имеет. */
    access: db.prepare(`
      SELECT w.id, w.public_id, w.owner_id, w.name, w.created_at,
             u.display_name AS owner_name, u.username AS owner_username,
             CASE WHEN w.owner_id = ? THEN 'owner' WHEN m.user_id IS NOT NULL THEN 'moderator' END AS role
      FROM workspaces w
      JOIN users u ON u.id = w.owner_id
      LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
      WHERE w.public_id = ?
    `),
    owned: db.prepare(`
      SELECT w.public_id, w.name, w.created_at,
             (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS moderators
      FROM workspaces w
      WHERE w.owner_id = ?
      ORDER BY w.created_at, w.id
    `),
    moderated: db.prepare(`
      SELECT w.public_id, w.name, w.created_at, u.display_name AS owner_name, m.created_at AS joined_at,
             (SELECT COUNT(*) FROM workspace_members m2 WHERE m2.workspace_id = w.id) AS moderators
      FROM workspace_members m
      JOIN workspaces w ON w.id = m.workspace_id
      JOIN users u ON u.id = w.owner_id
      WHERE m.user_id = ?
      ORDER BY m.created_at, w.id
    `),
    ownedNames: db.prepare('SELECT id, name FROM workspaces WHERE owner_id = ?'),
    insertWorkspace: db.prepare(`
      INSERT INTO workspaces (public_id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    `),
    renameWorkspace: db.prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?'),
    deleteWorkspace: db.prepare('DELETE FROM workspaces WHERE id = ?'),

    // Вместе с модератором — подпись приглашения, по которому он вошёл
    members: db.prepare(`
      SELECT u.id, u.username, u.display_name, m.created_at, i.label AS invite_label
      FROM workspace_members m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN workspace_invites i ON i.workspace_id = m.workspace_id AND i.accepted_by = m.user_id
      WHERE m.workspace_id = ?
      ORDER BY m.created_at, u.id
    `),
    countMembers: db.prepare('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?'),
    isMember: db.prepare('SELECT 1 AS yes FROM workspace_members WHERE workspace_id = ? AND user_id = ?'),
    memberByUsername: db.prepare(`
      SELECT u.id
      FROM workspace_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND u.username_key = ?
    `),
    insertMember: db.prepare('INSERT INTO workspace_members (workspace_id, user_id, created_at) VALUES (?, ?, ?)'),
    deleteMember: db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?'),

    pendingInvites: db.prepare(`
      SELECT public_id, label, created_at, expires_at
      FROM workspace_invites
      WHERE workspace_id = ? AND accepted_by IS NULL AND expires_at > ?
      ORDER BY created_at DESC, id DESC
    `),
    countPendingInvites: db.prepare(`
      SELECT COUNT(*) AS n FROM workspace_invites
      WHERE workspace_id = ? AND accepted_by IS NULL AND expires_at > ?
    `),
    insertInvite: db.prepare(`
      INSERT INTO workspace_invites (public_id, workspace_id, token_hash, label, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    inviteInWorkspace: db.prepare(`
      SELECT id, public_id, label, created_at, expires_at, accepted_by
      FROM workspace_invites WHERE public_id = ? AND workspace_id = ?
    `),
    inviteByHash: db.prepare(`
      SELECT i.id, i.workspace_id, i.expires_at, i.accepted_by,
             w.public_id, w.name AS workspace_name, w.owner_id, u.display_name AS owner_name
      FROM workspace_invites i
      JOIN workspaces w ON w.id = i.workspace_id
      JOIN users u ON u.id = w.owner_id
      WHERE i.token_hash = ?
    `),
    acceptInvite: db.prepare('UPDATE workspace_invites SET accepted_by = ?, accepted_at = ? WHERE id = ? AND accepted_by IS NULL'),
    deleteInvite: db.prepare('DELETE FROM workspace_invites WHERE id = ?'),
    deleteAcceptedInvites: db.prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND accepted_by = ?'),
    deleteExpiredInvites: db.prepare('DELETE FROM workspace_invites WHERE accepted_by IS NULL AND expires_at <= ?'),
  };

  /* ---------- Права ---------- */

  function find(userId, workspaceId) {
    if (!Number.isInteger(userId) || !isLinkToken(workspaceId, PUBLIC_ID_LENGTH)) return null;
    const row = sql.access.get(userId, userId, workspaceId);
    return row?.role ? row : null;
  }

  function access(userId, workspaceId) {
    const row = find(userId, workspaceId);
    // Чужая площадка и несуществующая неотличимы: посторонний не узнаёт даже, что она есть
    if (!row) throw new AppError('workspace_not_found', 404);
    return row;
  }

  function ownerAccess(userId, workspaceId) {
    const row = access(userId, workspaceId);
    if (row.role !== 'owner') throw new AppError('owner_only', 403);
    return row;
  }

  // Кем человек приходится площадке прямо сейчас: owner, moderator или null
  function roleOf({ userId, workspaceId } = {}) {
    return find(userId, workspaceId)?.role ?? null;
  }

  // То же, но с отказом для постороннего
  function requireMember({ userId, workspaceId } = {}) {
    return access(userId, workspaceId).role;
  }

  /* Вход в площадку для остальных разделов сервера (сцена, файлы). Вопрос тот же —
     «кем этот человек приходится площадке» — и ответ для постороннего тот же.
     Так у сцены нет собственной проверки прав, которая могла бы разойтись с этой. */
  function enter({ userId, workspaceId } = {}) {
    const row = access(userId, workspaceId);
    return { rowId: row.id, publicId: row.public_id, name: row.name, role: row.role };
  }

  function assertNotTooOften(key, rule) {
    const waitMs = limiter.retryAfterMs(key, rule);
    if (waitMs > 0) {
      throw new AppError('too_many_requests', 429, { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }
  }

  /* Сообщить открытым страницам площадки, что на ней что-то изменилось.
     audience: team — всей команде, owner — только владельцу (приглашения видит он один).
     Само изменение уже сохранено: сбой при оповещении не должен превращать его в ошибку. */
  function announce(workspaceId, what, { audience = 'team', actorId = null } = {}) {
    if (!onChange) return;
    try {
      onChange({ workspaceId, what, audience, actorId });
    } catch (err) {
      console.error('[krafen-overlay] Не удалось оповестить страницы площадки:', err);
    }
  }

  /* ---------- Что уходит на страницу ---------- */

  function workspaceView(row) {
    return {
      id: row.public_id,
      name: row.name,
      role: row.role,
      ownerName: row.owner_name,
      createdAt: iso(row.created_at),
    };
  }

  function inviteView(row) {
    return { id: row.public_id, label: row.label, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) };
  }

  function requireName(name, ownerId, exceptId = null) {
    const title = cleanLine(name);
    if (!title) throw new AppError('workspace_name_required', 400, { field: 'name' });
    if (lengthOf(title) > NAME_MAX) throw new AppError('workspace_name_too_long', 400, { field: 'name' });
    // Две площадки с одним названием у одного владельца невозможно отличить в списке
    const twin = sql.ownedNames.all(ownerId).some((row) => row.id !== exceptId && sameName(row.name, title));
    if (twin) throw new AppError('workspace_name_taken', 409, { field: 'name' });
    return title;
  }

  /* ---------- Площадки ---------- */

  function list({ userId } = {}) {
    const owned = sql.owned.all(userId).map((row) => ({
      id: row.public_id,
      name: row.name,
      role: 'owner',
      moderators: row.moderators,
      createdAt: iso(row.created_at),
    }));
    const moderated = sql.moderated.all(userId).map((row) => ({
      id: row.public_id,
      name: row.name,
      role: 'moderator',
      ownerName: row.owner_name,
      moderators: row.moderators,
      createdAt: iso(row.created_at),
      joinedAt: iso(row.joined_at),
    }));
    return { workspaces: [...owned, ...moderated], owned: owned.length, ownedLimit: rules.ownedWorkspaces };
  }

  function create({ userId, name } = {}) {
    const key = `workspace-create:${userId}`;
    assertNotTooOften(key, rules.workspaceCreationsPerUser);

    if (sql.ownedNames.all(userId).length >= rules.ownedWorkspaces) {
      throw new AppError('workspaces_limit', 409, { limit: rules.ownedWorkspaces });
    }
    const title = requireName(name, userId);

    const time = now();
    let publicId;
    for (let attempt = 1; ; attempt += 1) {
      publicId = newLinkToken(PUBLIC_ID_LENGTH);
      try {
        sql.insertWorkspace.run(publicId, userId, title, time, time);
        break;
      } catch (err) {
        // Случайный номер совпал с уже занятым — берём другой
        if (!isUniqueViolation(err) || attempt >= 5) throw err;
      }
    }
    limiter.hit(key, rules.workspaceCreationsPerUser);
    return { workspace: workspaceView(access(userId, publicId)) };
  }

  function get({ userId, workspaceId } = {}) {
    const row = access(userId, workspaceId);
    const isOwner = row.role === 'owner';

    /* Имя для входа и подпись приглашения видит только владелец: по ним он понимает,
       кто именно вошёл в команду и по какой ссылке. Модераторам друг о друге
       достаточно отображаемого имени. */
    const members = [
      {
        role: 'owner',
        displayName: row.owner_name,
        isYou: isOwner,
        ...(isOwner ? { username: row.owner_username } : {}),
      },
      ...sql.members.all(row.id).map((member) => ({
        role: 'moderator',
        displayName: member.display_name,
        isYou: member.id === userId,
        joinedAt: iso(member.created_at),
        ...(isOwner ? { username: member.username, inviteLabel: member.invite_label || '' } : {}),
      })),
    ];

    const result = { workspace: workspaceView(row), members };
    if (isOwner) {
      result.invites = sql.pendingInvites.all(row.id, now()).map(inviteView);
      result.limits = {
        moderators: rules.moderatorsPerWorkspace,
        pendingInvites: rules.pendingInvitesPerWorkspace,
      };
    }
    return result;
  }

  function rename({ userId, workspaceId, name } = {}) {
    const row = ownerAccess(userId, workspaceId);
    const title = requireName(name, userId, row.id);
    sql.renameWorkspace.run(title, now(), row.id);
    announce(row.public_id, 'name', { actorId: userId });
    return { workspace: workspaceView(access(userId, workspaceId)) };
  }

  /* Удаление необратимо, поэтому требует набрать название площадки: случайный
     щелчок или ошибка в адресе запроса ничего не удалят. */
  function remove({ userId, workspaceId, confirmName } = {}) {
    const row = ownerAccess(userId, workspaceId);
    if (!sameName(cleanLine(confirmName), row.name)) {
      throw new AppError('confirm_name_mismatch', 400, { field: 'confirmName' });
    }
    sql.deleteWorkspace.run(row.id); // модераторы, приглашения, источники и записи о файлах уходят вместе с площадкой
    announce(row.public_id, 'deleted', { actorId: userId });
    // Сами файлы площадки лежат на диске — их убирает тот, кто ими ведает. Площадка уже
    // удалена: сбой при уборке не должен превращать удаление в ошибку
    try {
      onRemoved?.(row.public_id);
    } catch (err) {
      console.error('[krafen-overlay] Не удалось убрать файлы удалённой площадки:', err);
    }
    return { deleted: { id: row.public_id, name: row.name } };
  }

  /* ---------- Команда ---------- */

  function removeMember({ userId, workspaceId, username } = {}) {
    const row = ownerAccess(userId, workspaceId);
    const key = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const member = key ? sql.memberByUsername.get(row.id, key) : null;
    if (!member) throw new AppError('member_not_found', 404);
    dropMember(row.id, member.id);
    announce(row.public_id, 'team', { actorId: userId });
    return { removed: true };
  }

  function leave({ userId, workspaceId } = {}) {
    const row = access(userId, workspaceId);
    // Площадка без владельца невозможна: владелец её не покидает, а удаляет
    if (row.role === 'owner') throw new AppError('owner_cannot_leave', 409);
    dropMember(row.id, userId);
    announce(row.public_id, 'team', { actorId: userId });
    return { left: { id: row.public_id, name: row.name } };
  }

  function dropMember(workspaceRowId, memberUserId) {
    transaction(() => {
      sql.deleteMember.run(workspaceRowId, memberUserId);
      // Ссылка, по которой человек вошёл, больше ни на что не указывает
      sql.deleteAcceptedInvites.run(workspaceRowId, memberUserId);
    });
  }

  /* ---------- Приглашения ----------
     Ссылка одноразовая: по ней входит один человек. Пока ею не воспользовались,
     владелец может её отозвать. В базе лежит только отпечаток ссылки, поэтому
     показать её повторно нельзя — только создать новую. */

  function createInvite({ userId, workspaceId, label } = {}) {
    const row = ownerAccess(userId, workspaceId);
    const key = `invite-create:${userId}`;
    assertNotTooOften(key, rules.inviteCreationsPerUser);

    const note = cleanLine(label);
    if (lengthOf(note) > LABEL_MAX) throw new AppError('invite_label_too_long', 400, { field: 'label' });

    const time = now();
    if (sql.countMembers.get(row.id).n >= rules.moderatorsPerWorkspace) {
      throw new AppError('members_limit', 409, { limit: rules.moderatorsPerWorkspace });
    }
    if (sql.countPendingInvites.get(row.id, time).n >= rules.pendingInvitesPerWorkspace) {
      throw new AppError('invites_limit', 409, { limit: rules.pendingInvitesPerWorkspace });
    }

    const token = newLinkToken(INVITE_TOKEN_LENGTH);
    const publicId = newLinkToken(PUBLIC_ID_LENGTH);
    sql.insertInvite.run(publicId, row.id, hashInviteToken(token), note, time, time + rules.inviteTtlMs);
    limiter.hit(key, rules.inviteCreationsPerUser);
    announce(row.public_id, 'invites', { audience: 'owner', actorId: userId });
    return { invite: inviteView(sql.inviteInWorkspace.get(publicId, row.id)), token };
  }

  function revokeInvite({ userId, workspaceId, inviteId } = {}) {
    const row = ownerAccess(userId, workspaceId);
    const invite = isLinkToken(inviteId, PUBLIC_ID_LENGTH) ? sql.inviteInWorkspace.get(inviteId, row.id) : null;
    if (!invite) throw new AppError('invite_not_found', 404);
    // Отзывать поздно: человек уже вошёл. Убрать его можно в списке команды.
    if (invite.accepted_by !== null) throw new AppError('invite_already_used', 409);
    sql.deleteInvite.run(invite.id);
    announce(row.public_id, 'invites', { audience: 'owner', actorId: userId });
    return { revoked: true };
  }

  const invalidInvite = () => new AppError('invite_invalid', 404);

  function findInvite(token) {
    if (!isLinkToken(token, INVITE_TOKEN_LENGTH)) return null;
    return sql.inviteByHash.get(hashInviteToken(token)) || null;
  }

  // Кем приходится площадке тот, кто открыл ссылку
  function relationOf(invite, userId) {
    if (!Number.isInteger(userId)) return 'guest';
    if (invite.owner_id === userId) return 'owner';
    return sql.isMember.get(invite.workspace_id, userId) ? 'member' : 'invitee';
  }

  /* Что показать человеку, открывшему ссылку-приглашение. Посмотреть может и гость:
     он должен понимать, куда его зовут, до того как создавать аккаунт. Отозванная,
     просроченная и использованная кем-то другим ссылка выглядят одинаково. */
  function describeInvite({ token, userId = null } = {}) {
    const invite = findInvite(token);
    if (!invite) throw invalidInvite();
    const viewer = relationOf(invite, userId);

    if (invite.accepted_by !== null) {
      // Тому, кто сам вошёл по этой ссылке и остаётся модератором, показываем дорогу в площадку
      if (invite.accepted_by === userId && viewer === 'member') {
        return { state: 'joined', workspace: { id: invite.public_id, name: invite.workspace_name } };
      }
      throw invalidInvite();
    }
    if (invite.expires_at <= now()) throw invalidInvite();

    const known = viewer === 'owner' || viewer === 'member';
    return {
      state: 'pending',
      viewer,
      workspace: { name: invite.workspace_name, ...(known ? { id: invite.public_id } : {}) },
      ownerName: invite.owner_name,
      expiresAt: iso(invite.expires_at),
    };
  }

  function acceptInvite({ token, userId } = {}) {
    const result = transaction(() => {
      const invite = findInvite(token);
      if (!invite) throw invalidInvite();
      const workspace = { id: invite.public_id, name: invite.workspace_name };
      const viewer = relationOf(invite, userId);

      if (invite.accepted_by !== null) {
        // Повторное нажатие «Принять» тем же человеком — не ошибка
        if (invite.accepted_by === userId && viewer === 'member') return { workspace, alreadyMember: true };
        throw invalidInvite();
      }
      const time = now();
      if (invite.expires_at <= time) throw invalidInvite();

      if (viewer === 'owner') throw new AppError('invite_own_workspace', 409);
      // Уже модератор — ссылка остаётся неиспользованной, её можно передать другому
      if (viewer === 'member') return { workspace, alreadyMember: true };

      if (sql.countMembers.get(invite.workspace_id).n >= rules.moderatorsPerWorkspace) {
        throw new AppError('members_limit', 409, { limit: rules.moderatorsPerWorkspace });
      }
      // Ссылка одноразовая: из двух одновременных нажатий сработает одно
      if (Number(sql.acceptInvite.run(userId, time, invite.id).changes) !== 1) throw invalidInvite();
      sql.insertMember.run(invite.workspace_id, userId, time);
      return { workspace, alreadyMember: false };
    });
    if (!result.alreadyMember) announce(result.workspace.id, 'team', { actorId: userId });
    return result;
  }

  // Раз в час: просроченные приглашения и устаревшие счётчики
  function cleanup() {
    limiter.sweep();
    return Number(sql.deleteExpiredInvites.run(now()).changes);
  }

  return {
    list,
    create,
    get,
    roleOf,
    requireMember,
    enter,
    rename,
    remove,
    removeMember,
    leave,
    createInvite,
    revokeInvite,
    describeInvite,
    acceptInvite,
    cleanup,
  };
}
