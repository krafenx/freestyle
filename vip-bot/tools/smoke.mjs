#!/usr/bin/env node
// tools/smoke.mjs — дешёвая проверка перед `tgcloud push`.
//
// На платформе нет локального эмулятора `sdk`, поэтому единственный способ
// поймать опечатку в импортах (а на Serverless это ошибка деплоя, а не рантайма)
// — подсунуть заглушку `sdk` и импортировать весь граф модулей.
//
// Заглушки создаются в node_modules/ (он в .gitignore) и НЕ влияют на деплой:
// на платформе `sdk` — настоящий.
//
//   npm run smoke

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const nm = path.join(root, 'node_modules');

const SDK_DB = `
const col = (k, n, o) => {
  const c = { k, n, o };
  for (const m of ['primaryKey', 'notNull', 'unique', 'default', 'deprecated', 'generatedAlwaysAs', 'constraint']) c[m] = () => c;
  c.references = () => { throw new Error('references() не поддерживается платформой'); };
  return c;
};
export const db = {};
export const table = (name, cols, cb) => { const t = { name, __cols: cols }; if (cb) cb(t); return t; };
export const integer = (n, o) => col('integer', n, o), text = (n, o) => col('text', n, o),
  real = (n, o) => col('real', n, o), numeric = (n, o) => col('numeric', n, o),
  json = (n, o) => col('json', n, o), boolean = (n, o) => col('boolean', n, o), blob = (n, o) => col('blob', n, o);
export const index = (n) => ({ n, on: () => ({ where: () => ({}) }) });
export const uniqueIndex = (n) => ({ n, on: () => ({ where: () => ({}) }) });
export const primaryKey = () => ({}), unique = () => ({ on: () => ({}) }), check = () => ({});
export const sql = (s, ...v) => ({ s, v });
export const eq = () => ({}), ne = () => ({}), gt = () => ({}), gte = () => ({}), lt = () => ({}), lte = () => ({}),
  and = () => ({}), or = () => ({}), not = () => ({}), inArray = () => ({}), notInArray = () => ({}),
  between = () => ({}), notBetween = () => ({}), like = () => ({}), notLike = () => ({}),
  asc = () => ({}), desc = () => ({}), count = () => ({}), sum = () => ({}), avg = () => ({}), min = () => ({}), max = () => ({});
export default db;
`;

const write = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

write(path.join(nm, 'sdk/package.json'), JSON.stringify({
  name: 'sdk', type: 'module',
  exports: { '.': './index.js', './db': './db.js', './api': './api.js', './fetch': './fetch.js' },
}, null, 2));
write(path.join(nm, 'sdk/index.js'),
  "export const db = {}; export const api = {}; export const fetch = async () => {};\n" +
  'export class BotApiError extends Error {} export class EndpointError extends Error {}\n');
write(path.join(nm, 'sdk/db.js'), SDK_DB);
write(path.join(nm, 'sdk/api.js'), 'export const api = {};\n');
write(path.join(nm, 'sdk/fetch.js'), 'export const fetch = async () => {};\n');

// платформа резолвит модули по bare-имени: 'schema', 'lib/core', …
write(path.join(nm, 'schema/package.json'), JSON.stringify({ name: 'schema', type: 'module', exports: { '.': './index.js' } }));
write(path.join(nm, 'schema/index.js'), "export * from '../../tgcloud/schema.js';\n");

const libs = fs.readdirSync(path.join(root, 'tgcloud/lib')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
write(path.join(nm, 'lib/package.json'), JSON.stringify({
  name: 'lib', type: 'module',
  exports: Object.fromEntries(libs.map((m) => [`./${m}`, `./${m}.js`])),
}));
for (const m of libs) write(path.join(nm, `lib/${m}.js`), `export * from '../../tgcloud/lib/${m}.js';\n`);

const targets = [
  'tgcloud/schema.js',
  ...libs.map((m) => `tgcloud/lib/${m}.js`),
  ...fs.readdirSync(path.join(root, 'tgcloud/handlers')).map((f) => `tgcloud/handlers/${f}`),
  ...fs.readdirSync(path.join(root, 'tgcloud/endpoints')).map((f) => `tgcloud/endpoints/${f}`),
].filter((f) => f.endsWith('.js'));

let failed = 0;
for (const rel of targets) {
  try {
    await import(pathToFileURL(path.join(root, rel)).href);
    console.log('ok  ', rel);
  } catch (err) {
    failed++;
    console.error('FAIL', rel, '→', String(err.message).split('\n')[0]);
  }
}
console.log(failed ? `\n${failed} из ${targets.length} модулей не собираются` : `\nвсе ${targets.length} модулей импортируются`);
process.exit(failed ? 1 : 0);
