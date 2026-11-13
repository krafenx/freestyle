import express from 'express';
import { fields } from '../auth/http.js';

/* Площадки со стороны адресов: /api/workspaces/* и /api/invites/*.
   Здесь нет ни одной проверки прав — только передача «кто просит» и «что просит»
   в workspaces.js, где права проверяются при каждом действии. Так проверку
   невозможно забыть, добавляя новый адрес. */
export function createWorkspacesHttp({ workspaces, realtime, auth }) {
  // Кто просит — всегда из сеанса входа, а не из присланных данных
  const from = (req) => ({ userId: req.auth.userId, workspaceId: req.params.id });

  /* ---------- /api/workspaces (только для вошедших) ---------- */
  const workspacesRouter = express.Router();
  workspacesRouter.use(auth.session, auth.requireAuth);

  workspacesRouter.get('/', (req, res) => {
    res.json({ ok: true, ...workspaces.list(from(req)) });
  });

  workspacesRouter.post('/', (req, res) => {
    res.status(201).json({ ok: true, ...workspaces.create({ ...from(req), name: fields(req).name }) });
  });

  workspacesRouter.get('/:id', (req, res) => {
    res.json({ ok: true, ...workspaces.get(from(req)) });
  });

  workspacesRouter.patch('/:id', (req, res) => {
    res.json({ ok: true, ...workspaces.rename({ ...from(req), name: fields(req).name }) });
  });

  workspacesRouter.post('/:id/delete', (req, res) => {
    res.json({ ok: true, ...workspaces.remove({ ...from(req), confirmName: fields(req).confirmName }) });
  });

  workspacesRouter.post('/:id/leave', (req, res) => {
    res.json({ ok: true, ...workspaces.leave(from(req)) });
  });

  workspacesRouter.post('/:id/members/remove', (req, res) => {
    res.json({ ok: true, ...workspaces.removeMember({ ...from(req), username: fields(req).username }) });
  });

  workspacesRouter.post('/:id/invites', (req, res) => {
    res.status(201).json({ ok: true, ...workspaces.createInvite({ ...from(req), label: fields(req).label }) });
  });

  workspacesRouter.post('/:id/invites/:inviteId/revoke', (req, res) => {
    res.json({ ok: true, ...workspaces.revokeInvite({ ...from(req), inviteId: req.params.inviteId }) });
  });

  /* Одноразовый пропуск в живой канал площадки (см. ws/hub.js). Выдаётся только
     участнику и привязан к его входу: закрыли вход — пропуск и канал не действуют. */
  workspacesRouter.post('/:id/live', (req, res) => {
    workspaces.requireMember(from(req));
    const pass = realtime.issueTicket({ ...from(req), sessionId: req.auth.sessionId });
    res.json({ ok: true, ...pass });
  });

  workspacesRouter.use(auth.reply);

  /* ---------- /api/invites ----------
     Посмотреть приглашение может и гость, принять — только вошедший. */
  const invitesRouter = express.Router();
  invitesRouter.use(auth.session);

  invitesRouter.get('/:token', (req, res) => {
    const invite = workspaces.describeInvite({ token: req.params.token, userId: req.auth?.userId ?? null });
    res.json({ ok: true, invite });
  });

  invitesRouter.post('/:token/accept', auth.requireAuth, (req, res) => {
    res.json({ ok: true, ...workspaces.acceptInvite({ token: req.params.token, userId: req.auth.userId }) });
  });

  invitesRouter.use(auth.reply);

  return { workspacesRouter, invitesRouter };
}
