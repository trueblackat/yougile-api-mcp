#!/usr/bin/env node
//
// MCP-сервер к API YouGile: доска, задачи и комментарии для ИИ-ассистента.
//
// Зачем свой, а не готовый: у YouGile нет официального MCP, а community-серверы —
// проекты на 10–20 звёзд, часть без файла лицензии (значит, повторно использовать
// их код нельзя). API при этом обычный REST, так что свой сервер честнее и короче.
//
// Что подтверждено на 16.09.2026 (официальная справка YouGile):
//   • «Использование API для любой вашей компании полностью бесплатно и не требует
//     какого-либо тарифа или покупки дополнительных пользователей»;
//   • не более 50 запросов в минуту на компанию — ограничитель ниже это соблюдает;
//   • не более 30 ключей на аккаунт, ключ бессрочный;
//   • ключ наследует права сотрудника, который его выпустил.
//
// ПЕРВЫЙ ЗАПУСК
//
//   1) Зарегистрировать компанию на https://ru.yougile.com.
//   2) Получить ключ, пароль при этом никуда не печатается и не сохраняется:
//
//        node yougile-mcp.mjs --login
//
//   3) Проверить ключ:
//
//        YOUGILE_API_KEY=... node yougile-mcp.mjs --check
//
//   4) Подключить в Claude Code:
//
//        claude mcp add yougile --env YOUGILE_API_KEY=<ключ> \
//          -- node /абсолютный/путь/yougile-mcp.mjs
//
// Переменные окружения:
//   YOUGILE_API_KEY   ключ (обязательно для работы сервера)
//   YOUGILE_BASE_URL  адрес API, по умолчанию https://yougile.com/api-v2
//
// Инструменты: карта проектов/досок/колонок, список и карточка задачи, создание,
// обновление (включая перенос между колонками и закрытие), чтение и отправка
// комментариев, список сотрудников.
//
// ВАЖНО про stdout: по нему идёт протокол MCP. Любая диагностика — только в stderr.

import readline from 'node:readline';

const BASE = (process.env.YOUGILE_BASE_URL || 'https://yougile.com/api-v2').replace(/\/+$/, '');
const VERSION = '0.1.0';

// ── Ограничитель частоты: 50 запросов в минуту на компанию ───────────────────────
// Держим запас (45), чтобы параллельный вебхук или второй клиент не выбили нас в 429.
const RATE_LIMIT = 45;
const recent = [];

async function throttle() {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    if (recent.length < RATE_LIMIT) {
      recent.push(now);
      return;
    }
    await sleep(60_000 - (now - recent[0]) + 50);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Клиент API ──────────────────────────────────────────────────────────────────

async function api(method, path, { query, body, key = process.env.YOUGILE_API_KEY, auth = true } = {}) {
  if (auth && !key) throw new Error('Нет ключа: задайте YOUGILE_API_KEY (получить — флаг --login)');

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth) headers.Authorization = `Bearer ${key}`;

  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429 && attempt < 3) {
      const retry = Number(res.headers.get('retry-after')) || 5;
      await sleep(retry * 1000);
      continue;
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error(`YouGile ${res.status} ${res.statusText} на ${method} ${path}: ${detail}`);
    }
    return data;
  }
}

// Списочные ответы приходят как { content: [...], paging: {...} } — разворачиваем.
const items = (r) => (Array.isArray(r) ? r : (r && r.content) || []);

// ── Инструменты ─────────────────────────────────────────────────────────────────

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });

const TOOLS = [
  {
    name: 'yougile_map',
    description:
      'Карта доски: проекты, их доски и колонки с идентификаторами. Вызывать первым — остальные инструменты работают по этим ID.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const projects = items(await api('GET', '/projects', { query: { limit: 200 } }));
      const boards = items(await api('GET', '/boards', { query: { limit: 200 } }));
      const columns = items(await api('GET', '/columns', { query: { limit: 500 } }));

      const byBoard = new Map();
      for (const c of columns) {
        if (!byBoard.has(c.boardId)) byBoard.set(c.boardId, []);
        byBoard.get(c.boardId).push({ id: c.id, title: c.title, color: c.color });
      }

      return projects.map((p) => ({
        id: p.id,
        title: p.title,
        boards: boards
          .filter((b) => b.projectId === p.id)
          .map((b) => ({ id: b.id, title: b.title, columns: byBoard.get(b.id) || [] })),
      }));
    },
  },

  {
    name: 'yougile_tasks',
    description:
      'Список задач. Фильтры: колонка, исполнитель, подстрока заголовка. Фильтра по проекту в API нет — фильтруйте по колонке.',
    inputSchema: {
      type: 'object',
      properties: {
        columnId: str('ID колонки'),
        assignedTo: str('ID сотрудника-исполнителя'),
        title: str('подстрока заголовка'),
        includeDeleted: bool('показывать удалённые, по умолчанию нет'),
        limit: num('сколько вернуть, по умолчанию 50'),
        offset: num('сдвиг для постраничного чтения'),
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api('GET', '/tasks', {
        query: {
          columnId: a.columnId,
          assignedTo: a.assignedTo,
          title: a.title,
          includeDeleted: a.includeDeleted,
          limit: a.limit ?? 50,
          offset: a.offset,
        },
      });
      return items(r).map(brief);
    },
  },

  {
    name: 'yougile_task',
    description: 'Одна задача целиком. Принимает и UUID, и код вида ABC-123.',
    inputSchema: {
      type: 'object',
      properties: { id: str('UUID или код задачи') },
      required: ['id'],
      additionalProperties: false,
    },
    run: (a) => api('GET', `/tasks/${encodeURIComponent(a.id)}`),
  },

  {
    name: 'yougile_create_task',
    description: 'Создать задачу в колонке. Описание — HTML, не markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('заголовок'),
        columnId: str('ID колонки'),
        description: str('описание в HTML'),
        assigned: { type: 'array', items: { type: 'string' }, description: 'ID исполнителей' },
        deadlineIso: str('срок в формате YYYY-MM-DD или ISO-дата'),
      },
      required: ['title', 'columnId'],
      additionalProperties: false,
    },
    async run(a) {
      const body = { title: a.title, columnId: a.columnId };
      if (a.description) body.description = a.description;
      if (a.assigned?.length) body.assigned = a.assigned;
      if (a.deadlineIso) body.deadline = { deadline: toMs(a.deadlineIso) };
      return api('POST', '/tasks', { body });
    },
  },

  {
    name: 'yougile_update_task',
    description:
      'Изменить задачу: перенести в другую колонку (columnId), закрыть (completed), переименовать, сменить описание, исполнителей, срок, удалить (deleted).',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('UUID задачи'),
        columnId: str('перенести в эту колонку'),
        title: str('новый заголовок'),
        description: str('новое описание в HTML'),
        completed: bool('отметить выполненной'),
        archived: bool('в архив'),
        deleted: bool('удалить'),
        assigned: { type: 'array', items: { type: 'string' }, description: 'ID исполнителей' },
        deadlineIso: str('новый срок, YYYY-MM-DD или ISO'),
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(a) {
      const body = {};
      for (const f of ['columnId', 'title', 'description', 'completed', 'archived', 'deleted']) {
        if (a[f] !== undefined) body[f] = a[f];
      }
      if (a.assigned) body.assigned = a.assigned;
      if (a.deadlineIso) body.deadline = { deadline: toMs(a.deadlineIso) };
      if (!Object.keys(body).length) throw new Error('Нечего менять: не передано ни одного поля');
      return api('PUT', `/tasks/${encodeURIComponent(a.id)}`, { body });
    },
  },

  {
    name: 'yougile_comments',
    description: 'Комментарии задачи (её чат), новые сверху.',
    inputSchema: {
      type: 'object',
      properties: { taskId: str('UUID задачи'), limit: num('сколько вернуть, по умолчанию 50') },
      required: ['taskId'],
      additionalProperties: false,
    },
    async run(a) {
      const r = await api('GET', `/chats/${encodeURIComponent(a.taskId)}/messages`, {
        query: { limit: a.limit ?? 50 },
      });
      return items(r).map((m) => ({
        id: m.id,
        from: m.fromUserId,
        at: m.timestamp ? new Date(m.timestamp).toISOString() : undefined,
        text: m.text,
        label: m.label,
      }));
    },
  },

  {
    name: 'yougile_comment',
    description: 'Написать комментарий в задачу. Текст обычный, разметка не нужна.',
    inputSchema: {
      type: 'object',
      properties: { taskId: str('UUID задачи'), text: str('текст комментария') },
      required: ['taskId', 'text'],
      additionalProperties: false,
    },
    run: (a) =>
      api('POST', `/chats/${encodeURIComponent(a.taskId)}/messages`, {
        body: { text: a.text, textHtml: escapeHtml(a.text), label: '' },
      }),
  },

  {
    name: 'yougile_users',
    description: 'Сотрудники компании: ID, имя, почта. Нужны, чтобы назначать задачи.',
    inputSchema: {
      type: 'object',
      properties: { email: str('фильтр по почте') },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api('GET', '/users', { query: { email: a.email, limit: 200 } });
      return items(r).map((u) => ({ id: u.id, name: u.realName || u.name, email: u.email, isAdmin: u.isAdmin }));
    },
  },
];

function brief(t) {
  return {
    id: t.id,
    code: t.idTaskCommon || t.code,
    title: t.title,
    columnId: t.columnId,
    completed: t.completed,
    assigned: t.assigned,
    deadline: t.deadline?.deadline ? new Date(t.deadline.deadline).toISOString().slice(0, 10) : undefined,
  };
}

function toMs(value) {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T12:00:00+03:00`) : Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Не разобрал дату: ${value}`);
  return ms;
}

const escapeHtml = (s) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/\n/g, '<br>');

// ── Протокол MCP поверх stdio ───────────────────────────────────────────────────

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'yougile', version: VERSION },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(
        id,
        { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      );

    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `Неизвестный инструмент: ${params?.name}`);
      try {
        const result = await tool.run(params.arguments || {});
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return ok(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }

    default:
      if (isNotification) return;
      return fail(id, -32601, `Метод не поддерживается: ${method}`);
  }
}

function serve() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stderr.write(`не разобрал строку: ${line}\n`);
        continue;
      }
      handle(msg).catch((e) => {
        process.stderr.write(`сбой обработчика: ${e?.stack || e}\n`);
        if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, String(e?.message || e));
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// ── Режимы командной строки ─────────────────────────────────────────────────────

// Когда stdin не терминал (ввод из файла или по конвейеру), readline съедает
// сразу весь буфер и второй вопрос остаётся без ответа. Поэтому в неинтерактивном
// режиме просто читаем строки: первая — почта, вторая — пароль.
function readPipedLines() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data.split(/\r?\n/).map((l) => l.trim())));
    process.stdin.on('error', reject);
  });
}

// Один общий интерфейс ввода на весь диалог: два отдельных readline подряд
// теряют уже прочитанный буфер stdin, и второй вопрос остаётся без ответа.
async function withPrompts(fn) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const ask = (question, hidden = false) =>
    new Promise((resolve) => {
      rl._writeToOutput = hidden
        ? (s) => {
            if (s.includes(question)) rl.output.write(question);
          }
        : (s) => rl.output.write(s);
      rl.question(question, (answer) => {
        if (hidden) rl.output.write('\n');
        resolve(answer.trim());
      });
    });
  try {
    return await fn(ask);
  } finally {
    rl.close();
  }
}

async function login() {
  process.stderr.write('Выпуск ключа YouGile. Пароль не печатается и никуда не сохраняется.\n');

  let email;
  let password;
  if (process.stdin.isTTY) {
    ({ email, password } = await withPrompts(async (ask) => ({
      email: await ask('Почта: '),
      password: await ask('Пароль: ', true),
    })));
  } else {
    const [a, b] = await readPipedLines();
    email = a;
    password = b;
  }

  if (!email || !password) throw new Error('Нужны и почта, и пароль');

  const companies = items(await api('POST', '/auth/companies', { auth: false, body: { login: email, password } }));
  if (!companies.length) throw new Error('У аккаунта нет компаний');

  let company = companies[0];
  if (companies.length > 1) {
    companies.forEach((c, i) => process.stderr.write(`  ${i + 1}. ${c.name} (${c.id})\n`));
    const choice = await withPrompts((ask) => ask('Номер компании: '));
    company = companies[Number(choice) - 1] || companies[0];
  }

  const created = await api('POST', '/auth/keys', {
    auth: false,
    body: { login: email, password, companyId: company.id },
  });
  const key = created?.key || created?.content?.key;
  if (!key) throw new Error(`Ключ не пришёл, ответ API: ${JSON.stringify(created)}`);

  process.stderr.write(`\nКомпания: ${company.name} (${company.id})\nКлюч, бессрочный, лимит 30 на аккаунт:\n`);
  process.stdout.write(key + '\n');
}

async function check() {
  const me = items(await api('GET', '/users', { query: { limit: 3 } }));
  const projects = items(await api('GET', '/projects', { query: { limit: 3 } }));
  process.stderr.write(`Ключ рабочий. Сотрудников видно: ${me.length}, проектов: ${projects.length}\n`);
  for (const p of projects) process.stderr.write(`  проект: ${p.title} (${p.id})\n`);
}

const mode = process.argv[2];
const run =
  mode === '--login' ? login : mode === '--check' ? check : mode === undefined ? async () => serve() : null;

if (!run) {
  process.stderr.write('Флаги: --login (выпустить ключ), --check (проверить ключ), без флага — MCP-сервер\n');
  process.exit(2);
}

run().catch((e) => {
  process.stderr.write(String(e?.message || e) + '\n');
  process.exit(1);
});
