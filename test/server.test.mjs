// Сквозные тесты: запускаем настоящий сервер отдельным процессом, говорим с ним по
// stdio, как MCP-клиент, а вместо YouGile подставляем локальный HTTP-сервер
// через YOUGILE_BASE_URL. Сеть и настоящий ключ не нужны.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../yougile-mcp.mjs', import.meta.url));

// ── Поддельный YouGile ──────────────────────────────────────────────────────────

const requests = [];
const routes = {
  'GET /projects': () => ({ content: [{ id: 'p1', title: 'Проект' }] }),
  'GET /boards': () => ({ content: [{ id: 'b1', title: 'Доска', projectId: 'p1' }] }),
  'GET /columns': () => ({
    content: [
      { id: 'c1', title: 'Сделать', boardId: 'b1', color: 1 },
      { id: 'c2', title: 'Готово', boardId: 'b1', color: 2 },
    ],
  }),
  'GET /task-list': () => ({
    content: [
      {
        id: 't1',
        idTaskCommon: 'ID-1',
        title: 'Задача',
        columnId: 'c1',
        completed: false,
        assigned: ['u1'],
        deadline: { deadline: Date.parse('2026-10-01T12:00:00+03:00') },
        stickers: { s1: 'st1' },
        extra: 'не должно попасть в ответ',
      },
    ],
  }),
  'POST /tasks': () => ({ id: 'new' }),
  'PUT /tasks/t1': () => ({ id: 't1' }),
  'GET /tasks/t1/chat-subscribers': () => ['u1', 'u2'],
  'PUT /tasks/t1/chat-subscribers': () => ({ id: 't1' }),
  'GET /chats/t1/messages': () => ({ content: [{ id: 1, fromUserId: 'u1', text: 'привет', label: '' }] }),
  'GET /string-stickers': () => ({
    content: [
      {
        id: 's1',
        name: 'Приоритет',
        icon: 'prio',
        states: [
          { id: 'st1', name: 'Высокий', color: '#FF0000' },
          { id: 'st0', name: 'Старое', color: '#000', deleted: true },
        ],
      },
    ],
  }),
  'GET /sprint-stickers': () => ({
    content: [{ id: 'sp', name: 'Спринты', states: [{ id: 'sp1', name: 'Спринт 1', begin: 1790000000, end: 1791000000 }, { id: 'sp2', name: 'Бэклог' }] }],
  }),
  'POST /string-stickers': () => ({ id: 's2' }),
  'GET /string-stickers/s2': () => ({ id: 's2', name: 'Статус', states: [{ id: 'n1', name: 'Новый', color: '#00FF00' }] }),
  'POST /sprint-stickers': () => ({ id: 'sp2' }),
  'GET /sprint-stickers/sp2': () => ({ id: 'sp2', name: 'Спринты', states: [] }),
  'GET /string-stickers/s1': () => ({ id: 's1', name: 'Важность', states: [{ id: 'st1', name: 'Высокий', color: '#FF0000' }] }),
  'PUT /string-stickers/s1': () => ({ id: 's1' }),
  'POST /string-stickers/s1/states': () => ({ id: 'st9' }),
  'PUT /string-stickers/s1/states/st1': () => ({ id: 'st1' }),
  'GET /boards/b1': () => ({ id: 'b1', title: 'Доска', stickers: { deadline: true, custom: { s1: true } } }),
  'PUT /boards/b1': () => ({ id: 'b1' }),
  'GET /users/me': () => ({ id: 'u1', realName: 'Иван', email: 'i@example.com', isAdmin: true, status: 'online' }),
  'POST /projects': () => ({ id: 'p2' }),
  'POST /boards': () => ({ id: 'b2' }),
  'POST /columns': () => ({ id: 'c3' }),
  'PUT /columns/c1': () => ({ id: 'c1' }),
  'PUT /projects/p1': () => ({ id: 'p1' }),
  'POST /chats/t1/messages': () => ({ id: 1 }),
  'GET /users': () => ({ content: [{ id: 'u1', realName: 'Иван', email: 'i@example.com', isAdmin: true }] }),
};

let yougile;
let baseUrl;

before(async () => {
  yougile = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace(/^\/api-v2/, '');
      requests.push({
        method: req.method,
        path,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const route = routes[`${req.method} ${path}`];
      res.writeHead(route ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(route ? route() : { error: 'not found' }));
    });
  });
  await new Promise((r) => yougile.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${yougile.address().port}/api-v2/`;
});

after(() => new Promise((r) => yougile.close(r)));

// ── Клиент MCP ──────────────────────────────────────────────────────────────────

function startServer(env = { YOUGILE_API_KEY: 'test-key' }) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, YOUGILE_BASE_URL: baseUrl, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buffer = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve) => pending.set(id, resolve));
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    async call(name, args) {
      const { result } = await this.request('tools/call', { name, arguments: args });
      const text = result.content[0].text;
      return result.isError ? { error: text } : JSON.parse(text);
    },
    stop() {
      child.stdin.end();
      return new Promise((r) => child.on('exit', r));
    },
  };
}

async function withServer(fn, env) {
  const s = startServer(env);
  try {
    await fn(s);
  } finally {
    await s.stop();
  }
}

const lastRequest = () => requests[requests.length - 1];

// ── Протокол ────────────────────────────────────────────────────────────────────

test('initialize повторяет версию протокола клиента и называет сервер', () =>
  withServer(async (s) => {
    const { result } = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.equal(result.serverInfo.name, 'yougile');
    assert.ok(result.capabilities.tools);
  }));

test('на уведомления сервер не отвечает, на ping отвечает пустым объектом', () =>
  withServer(async (s) => {
    s.notify('notifications/initialized');
    const res = await s.request('ping');
    assert.equal(res.id, 1);
    assert.deepEqual(res.result, {});
  }));

test('неизвестный метод и неизвестный инструмент — ошибки JSON-RPC', () =>
  withServer(async (s) => {
    assert.equal((await s.request('resources/list')).error.code, -32601);
    assert.equal((await s.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  }));

// ── Список инструментов ─────────────────────────────────────────────────────────

test('tools/list: у каждого инструмента схема и annotations', () =>
  withServer(async (s) => {
    const { tools } = (await s.request('tools/list')).result;
    assert.equal(tools.length, 15);

    const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(readOnly, [
      'yougile_comments',
      'yougile_map',
      'yougile_me',
      'yougile_stickers',
      'yougile_task',
      'yougile_task_subscribers',
      'yougile_tasks',
      'yougile_users',
    ]);

    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.equal(typeof t.annotations.title, 'string', t.name);
      assert.equal(t.annotations.openWorldHint, true, t.name);
      if (!t.annotations.readOnlyHint) assert.equal(typeof t.annotations.destructiveHint, 'boolean', t.name);
    }

    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    assert.equal(byName.yougile_update_task.destructiveHint, true);
    assert.equal(byName.yougile_create_task.destructiveHint, false);
    assert.equal(byName.yougile_create_task.idempotentHint, false);
    assert.equal(byName.yougile_comment.idempotentHint, false);
    assert.equal(byName.yougile_update_structure.destructiveHint, true);
    assert.equal(byName.yougile_create_structure.destructiveHint, false);
    assert.equal(byName.yougile_create_sticker.destructiveHint, false);
    assert.equal(byName.yougile_update_sticker.destructiveHint, true);
  }));

// ── Инструменты ─────────────────────────────────────────────────────────────────

test('yougile_map собирает дерево проект → доска → колонки', () =>
  withServer(async (s) => {
    const map = await s.call('yougile_map', {});
    assert.deepEqual(map, [
      {
        id: 'p1',
        title: 'Проект',
        boards: [
          {
            id: 'b1',
            title: 'Доска',
            columns: [
              { id: 'c1', title: 'Сделать', color: 1 },
              { id: 'c2', title: 'Готово', color: 2 },
            ],
          },
        ],
      },
    ]);
    assert.equal(lastRequest().auth, 'Bearer test-key');
  }));

test('yougile_tasks передаёт фильтры и сокращает задачу до главного', () =>
  withServer(async (s) => {
    const tasks = await s.call('yougile_tasks', { columnId: 'c1', title: 'Зад', stickerId: 's1', stickerStateId: 'st1' });
    assert.equal(lastRequest().path, '/task-list');
    assert.deepEqual(lastRequest().query, {
      columnId: 'c1',
      title: 'Зад',
      stickerId: 's1',
      stickerStateId: 'st1',
      limit: '50',
    });
    assert.deepEqual(tasks, [
      {
        id: 't1',
        code: 'ID-1',
        title: 'Задача',
        columnId: 'c1',
        completed: false,
        assigned: ['u1'],
        deadline: '2026-10-01',
        stickers: { s1: 'st1' },
      },
    ]);
  }));

test('yougile_create_task переводит срок YYYY-MM-DD в миллисекунды (полдень по Москве)', () =>
  withServer(async (s) => {
    await s.call('yougile_create_task', { title: 'Новая', columnId: 'c1', deadlineIso: '2026-10-01' });
    const req = lastRequest();
    assert.equal(req.method, 'POST');
    assert.deepEqual(req.body, {
      title: 'Новая',
      columnId: 'c1',
      deadline: { deadline: Date.parse('2026-10-01T09:00:00Z') },
    });
  }));

test('yougile_create_task с неразборчивой датой возвращает ошибку, а не падает', () =>
  withServer(async (s) => {
    const r = await s.call('yougile_create_task', { title: 'x', columnId: 'c1', deadlineIso: 'завтра' });
    assert.match(r.error, /Не разобрал дату/);
  }));

test('yougile_update_task шлёт только переданные поля', () =>
  withServer(async (s) => {
    await s.call('yougile_update_task', { id: 't1', columnId: 'c2', completed: true });
    const req = lastRequest();
    assert.equal(req.method, 'PUT');
    assert.equal(req.path, '/tasks/t1');
    assert.deepEqual(req.body, { columnId: 'c2', completed: true });
  }));

test('yougile_update_task без полей — ошибка без запроса к API', () =>
  withServer(async (s) => {
    const before = requests.length;
    const r = await s.call('yougile_update_task', { id: 't1' });
    assert.match(r.error, /Нечего менять/);
    assert.equal(requests.length, before);
  }));

test('yougile_comment экранирует HTML и переносит строки', () =>
  withServer(async (s) => {
    await s.call('yougile_comment', { taskId: 't1', text: 'a < b & c\nвторая' });
    assert.deepEqual(lastRequest().body, {
      text: 'a < b & c\nвторая',
      textHtml: 'a &lt; b &amp; c<br>вторая',
      label: '',
    });
  }));

test('yougile_users отдаёт realName как имя', () =>
  withServer(async (s) => {
    const users = await s.call('yougile_users', {});
    assert.deepEqual(users, [{ id: 'u1', name: 'Иван', email: 'i@example.com', isAdmin: true }]);
  }));

test('yougile_stickers: обычные стикеры и спринты, удалённые состояния скрыты', () =>
  withServer(async (s) => {
    const stickers = await s.call('yougile_stickers', { boardId: 'b1' });
    assert.deepEqual(lastRequest().query, { boardId: 'b1', limit: '1000' });
    assert.deepEqual(stickers, [
      { id: 's1', kind: 'string', name: 'Приоритет', states: [{ id: 'st1', name: 'Высокий', color: '#FF0000' }] },
      {
        id: 'sp',
        kind: 'sprint',
        name: 'Спринты',
        states: [
          { id: 'sp1', name: 'Спринт 1', begin: '2026-09-21', end: '2026-10-03' },
          { id: 'sp2', name: 'Бэклог' },
        ],
      },
    ]);
  }));

test('yougile_create_sticker создаёт стикер с состояниями и включает его на доске, не трогая остальные', () =>
  withServer(async (s) => {
    const before = requests.length;
    const created = await s.call('yougile_create_sticker', {
      kind: 'string',
      name: 'Статус',
      icon: 'flag',
      states: [{ name: 'Новый', color: '#00FF00' }],
      boardId: 'b1',
    });
    const sent = requests.slice(before).map((r) => `${r.method} ${r.path} ${JSON.stringify(r.body ?? null)}`);
    assert.deepEqual(sent, [
      'POST /string-stickers {"name":"Статус","icon":"flag","states":[{"name":"Новый","color":"#00FF00"}]}',
      'GET /boards/b1 null',
      'PUT /boards/b1 {"stickers":{"deadline":true,"custom":{"s1":true,"s2":true}}}',
      'GET /string-stickers/s2 null',
    ]);
    assert.deepEqual(created, {
      id: 's2',
      kind: 'string',
      name: 'Статус',
      states: [{ id: 'n1', name: 'Новый', color: '#00FF00' }],
    });
  }));

test('yougile_create_sticker: спринт — даты в секундах, с начала первого дня до конца последнего по Москве', () =>
  withServer(async (s) => {
    await s.call('yougile_create_sticker', {
      kind: 'sprint',
      name: 'Спринты',
      states: [{ name: 'Спринт 1', beginIso: '2026-10-01', endIso: '2026-10-14' }, { name: 'Бэклог' }],
    });
    const post = requests.findLast((r) => r.method === 'POST');
    assert.deepEqual(post.body, {
      name: 'Спринты',
      states: [
        { name: 'Спринт 1', begin: Date.parse('2026-09-30T21:00:00Z') / 1000, end: Date.parse('2026-10-14T20:59:59Z') / 1000 },
        { name: 'Бэклог' },
      ],
    });
  }));

test('yougile_create_sticker не путает поля обычного стикера и спринта', () =>
  withServer(async (s) => {
    const before = requests.length;
    const err = async (args) => (await s.call('yougile_create_sticker', args)).error;
    assert.match(await err({ kind: 'sprint', name: 'x', icon: 'flag' }), /Иконка бывает только/);
    assert.match(await err({ kind: 'sprint', name: 'x', states: [{ name: 'a', color: '#fff' }] }), /Цвет бывает только/);
    assert.match(await err({ kind: 'string', name: 'x', states: [{ name: 'a', beginIso: '2026-10-01' }] }), /Даты бывают только/);
    assert.match(await err({ kind: 'label', name: 'x' }), /Неизвестный вид стикера/);
    assert.equal(requests.length, before);
  }));

test('yougile_update_sticker: переименование, новое состояние и правка старого — по порядку', () =>
  withServer(async (s) => {
    const before = requests.length;
    await s.call('yougile_update_sticker', {
      kind: 'string',
      id: 's1',
      name: 'Важность',
      addStates: [{ name: 'Средний', color: '#FFFF00' }],
      updateStates: [{ id: 'st1', color: '#AA0000' }],
    });
    const sent = requests.slice(before).map((r) => `${r.method} ${r.path} ${JSON.stringify(r.body ?? null)}`);
    assert.deepEqual(sent, [
      'PUT /string-stickers/s1 {"name":"Важность"}',
      'POST /string-stickers/s1/states {"name":"Средний","color":"#FFFF00"}',
      'PUT /string-stickers/s1/states/st1 {"color":"#AA0000"}',
      'GET /string-stickers/s1 null',
    ]);
  }));

test('yougile_update_sticker проверяет всё до первого запроса', () =>
  withServer(async (s) => {
    const before = requests.length;
    const r = await s.call('yougile_update_sticker', {
      kind: 'string',
      id: 's1',
      name: 'Новое',
      updateStates: [{ id: 'st1' }],
    });
    assert.match(r.error, /не передано ни одного поля/);
    assert.match((await s.call('yougile_update_sticker', { kind: 'string', id: 's1' })).error, /Нечего менять/);
    assert.equal(requests.length, before);

    await s.call('yougile_update_sticker', { kind: 'string', id: 's1', updateStates: [{ id: 'st1', deleted: true }] });
    assert.deepEqual(requests.findLast((r) => r.method === 'PUT').body, { deleted: true });
  }));

test('yougile_create_task передаёт стикеры, чеклисты, учёт времени, срок с началом и ключ идемпотентности', () =>
  withServer(async (s) => {
    const checklists = [{ title: 'Шаги', items: [{ title: 'раз', isCompleted: false }] }];
    await s.call('yougile_create_task', {
      title: 'Новая',
      columnId: 'c1',
      stickers: { s1: 'st1' },
      checklists,
      subtasks: ['t9'],
      color: 'task-red',
      timeTracking: { plan: 5 },
      startDateIso: '2026-09-25',
      deadlineIso: '2026-10-01T18:30:00+03:00',
      deadlineWithTime: true,
      idempotencyKey: 'k1',
    });
    assert.deepEqual(lastRequest().body, {
      title: 'Новая',
      columnId: 'c1',
      stickers: { s1: 'st1' },
      checklists,
      subtasks: ['t9'],
      color: 'task-red',
      timeTracking: { plan: 5 },
      deadline: {
        deadline: Date.parse('2026-10-01T15:30:00Z'),
        startDate: Date.parse('2026-09-25T09:00:00Z'),
        withTime: true,
      },
      idempotencyKey: 'k1',
    });
  }));

test('yougile_update_task снимает срок и таймер флагами remove*', () =>
  withServer(async (s) => {
    await s.call('yougile_update_task', { id: 't1', removeDeadline: true, removeTimer: true });
    assert.deepEqual(lastRequest().body, { deadline: { deleted: true }, timer: { deleted: true } });

    const r = await s.call('yougile_update_task', { id: 't1', deadlineIso: '2026-10-01', removeDeadline: true });
    assert.match(r.error, /выберите что-то одно/);
  }));

test('yougile_update_task меняет участников чата отдельным запросом', () =>
  withServer(async (s) => {
    const before = requests.length;
    await s.call('yougile_update_task', { id: 't1', completed: true, chatSubscribers: ['u1'] });
    const sent = requests.slice(before).map((r) => `${r.method} ${r.path} ${JSON.stringify(r.body)}`);
    assert.deepEqual(sent, [
      'PUT /tasks/t1 {"completed":true}',
      'PUT /tasks/t1/chat-subscribers {"content":["u1"]}',
    ]);

    const only = requests.length;
    await s.call('yougile_update_task', { id: 't1', chatSubscribers: [] });
    assert.deepEqual(
      requests.slice(only).map((r) => r.path),
      ['/tasks/t1/chat-subscribers'],
    );
  }));

test('yougile_task_subscribers читает участников чата', () =>
  withServer(async (s) => {
    assert.deepEqual(await s.call('yougile_task_subscribers', { taskId: 't1' }), ['u1', 'u2']);
  }));

test('yougile_comments передаёт фильтры, голая дата since — начало дня по Москве', () =>
  withServer(async (s) => {
    await s.call('yougile_comments', { taskId: 't1', fromUserId: 'u1', sinceIso: '2026-09-20', includeSystem: true });
    assert.deepEqual(lastRequest().query, {
      fromUserId: 'u1',
      since: String(Date.parse('2026-09-19T21:00:00Z')),
      includeSystem: 'true',
      limit: '50',
    });
  }));

test('yougile_me возвращает владельца ключа', () =>
  withServer(async (s) => {
    assert.deepEqual(await s.call('yougile_me', {}), { id: 'u1', name: 'Иван', email: 'i@example.com', isAdmin: true });
  }));

test('yougile_create_structure: родитель подставляется в нужное поле', () =>
  withServer(async (s) => {
    await s.call('yougile_create_structure', { kind: 'board', title: 'Доска 2', parentId: 'p1' });
    assert.deepEqual(lastRequest(), {
      method: 'POST',
      path: '/boards',
      query: {},
      auth: 'Bearer test-key',
      body: { title: 'Доска 2', projectId: 'p1' },
    });

    await s.call('yougile_create_structure', { kind: 'column', title: 'Тест', parentId: 'b1', color: 3, idempotencyKey: 'k' });
    assert.deepEqual(lastRequest().body, { title: 'Тест', boardId: 'b1', color: 3, idempotencyKey: 'k' });

    await s.call('yougile_create_structure', { kind: 'project', title: 'П', users: { u1: 'admin' } });
    assert.deepEqual(lastRequest().body, { title: 'П', users: { u1: 'admin' } });
  }));

test('yougile_create_structure проверяет вид и поля до запроса', () =>
  withServer(async (s) => {
    const before = requests.length;
    assert.match((await s.call('yougile_create_structure', { kind: 'column', title: 'x' })).error, /нужен parentId/);
    assert.match(
      (await s.call('yougile_create_structure', { kind: 'project', title: 'x', parentId: 'p' })).error,
      /У проекта нет родителя/,
    );
    assert.match(
      (await s.call('yougile_create_structure', { kind: 'board', title: 'x', parentId: 'p1', color: 2 })).error,
      /только у вида column/,
    );
    assert.equal(requests.length, before);
  }));

test('yougile_update_structure переименовывает и удаляет', () =>
  withServer(async (s) => {
    await s.call('yougile_update_structure', { kind: 'column', id: 'c1', title: 'Новое', color: 5 });
    assert.deepEqual(lastRequest().body, { title: 'Новое', color: 5 });
    assert.equal(lastRequest().path, '/columns/c1');

    await s.call('yougile_update_structure', { kind: 'project', id: 'p1', deleted: true });
    assert.deepEqual(lastRequest().body, { deleted: true });

    assert.match((await s.call('yougile_update_structure', { kind: 'board', id: 'b1' })).error, /Нечего менять/);
  }));

test('ошибка API YouGile приходит клиенту как isError с кодом ответа', () =>
  withServer(async (s) => {
    const r = await s.call('yougile_task', { id: 'missing' });
    assert.match(r.error, /YouGile 404/);
  }));

test('без ключа инструмент отвечает понятной ошибкой', () =>
  withServer(
    async (s) => {
      const r = await s.call('yougile_users', {});
      assert.match(r.error, /Нет ключа/);
    },
    {},
  ));
