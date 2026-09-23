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
// Инструменты: карта проектов/досок/колонок, стикеры (чтение, создание, правка),
// список и карточка задачи, создание и обновление задачи (перенос, закрытие,
// стикеры, чеклисты, подзадачи, учёт времени), участники чата, чтение и отправка
// комментариев, сотрудники, создание и изменение проектов, досок и колонок.
//
// Сознательно НЕ подключено: приглашение и удаление сотрудников, роли, отделы,
// настройки компании, ключи, вебхуки, CRM-справочники. Ключ и так даёт доступ ко всей
// компании, а такие действия ИИ-ассистенту лучше не доверять.
//
// ВАЖНО про stdout: по нему идёт протокол MCP. Любая диагностика — только в stderr.

import readline from 'node:readline';

const BASE = (process.env.YOUGILE_BASE_URL || 'https://yougile.com/api-v2').replace(/\/+$/, '');
const VERSION = '0.2.0';

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

// Подсказки клиенту (annotations из спецификации MCP): по ним он решает, спрашивать ли
// подтверждение перед вызовом. openWorldHint — все инструменты ходят во внешний API.
// У записи destructiveHint по умолчанию false: создание задачи и комментария ничего не
// перезаписывает, а вот обновление может затереть поля или удалить задачу.
const READ = (title) => ({ title, readOnlyHint: true, idempotentHint: true, openWorldHint: true });
const WRITE = (title, extra) => ({ title, readOnlyHint: false, destructiveHint: false, openWorldHint: true, ...extra });

// Поля задачи, общие для создания и изменения. Схемы и сборка тела запроса — рядом,
// чтобы новое поле нельзя было добавить в одно место и забыть в другом.
const TASK_COLORS = [
  'task-primary',
  'task-gray',
  'task-red',
  'task-pink',
  'task-yellow',
  'task-green',
  'task-turquoise',
  'task-blue',
  'task-violet',
];

const TASK_PROPS = {
  description: str('описание в HTML'),
  assigned: { type: 'array', items: { type: 'string' }, description: 'ID исполнителей' },
  deadlineIso: str('срок: YYYY-MM-DD или ISO-дата со временем'),
  startDateIso: str('дата начала задачи, YYYY-MM-DD или ISO'),
  deadlineWithTime: bool('показывать на стикере срока время, а не только дату'),
  subtasks: {
    type: 'array',
    items: { type: 'string' },
    description: 'ID подзадач. Список заменяется целиком: чтобы добавить одну, передайте прежние плюс новую',
  },
  checklists: {
    type: 'array',
    description:
      'чеклисты. Заменяются целиком: сначала прочитайте задачу (yougile_task), поправьте и передайте весь список',
    items: {
      type: 'object',
      properties: {
        title: str('название чеклиста'),
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: str('пункт'), isCompleted: bool('выполнен') },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'items'],
      additionalProperties: false,
    },
  },
  stickers: {
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'пользовательские стикеры: { ID стикера: ID состояния }. Для стикера-поля — сам текст или число строкой. ' +
      '"-" открепляет стикер, "empty" ставит пустой. ID берутся из yougile_stickers',
  },
  color: { type: 'string', enum: TASK_COLORS, description: 'цвет карточки' },
  timeTracking: {
    type: 'object',
    properties: { plan: num('запланировано, часов'), work: num('потрачено, часов') },
    additionalProperties: false,
    description: 'учёт времени',
  },
  timer: {
    type: 'object',
    properties: { seconds: num('на сколько секунд'), running: bool('запущен') },
    additionalProperties: false,
    description: 'таймер обратного отсчёта',
  },
  stopwatch: {
    type: 'object',
    properties: { running: bool('запущен') },
    required: ['running'],
    additionalProperties: false,
    description: 'секундомер: запустить или остановить',
  },
  deal: {
    type: 'object',
    properties: {
      dealAmount: num('сумма сделки'),
      contactPersonIds: { type: 'array', items: { type: 'string' }, description: 'ID контактных лиц' },
      organizationId: str('ID организации'),
      customFields: { type: 'object', description: 'пользовательские поля CRM: { ID поля: значение }' },
    },
    additionalProperties: false,
    description: 'данные сделки — только для задач в CRM-проектах',
  },
};

// Поля, которые уходят в API как есть.
const TASK_PASSTHROUGH = ['description', 'assigned', 'subtasks', 'checklists', 'stickers', 'color', 'timeTracking', 'timer', 'stopwatch', 'deal'];

function taskBody(a, body = {}) {
  for (const f of TASK_PASSTHROUGH) {
    if (a[f] !== undefined) body[f] = a[f];
  }
  const deadline = {};
  if (a.deadlineIso) deadline.deadline = toMs(a.deadlineIso);
  if (a.startDateIso) deadline.startDate = toMs(a.startDateIso);
  if (a.deadlineWithTime !== undefined) deadline.withTime = a.deadlineWithTime;
  if (Object.keys(deadline).length) body.deadline = deadline;
  return body;
}

// Проекты, доски и колонки устроены одинаково: у каждого заголовок и родитель.
const STRUCTURE = {
  project: { path: '/projects', parent: null },
  board: { path: '/boards', parent: 'projectId' },
  column: { path: '/columns', parent: 'boardId' },
};

const STRUCTURE_PROPS = {
  kind: { type: 'string', enum: Object.keys(STRUCTURE), description: 'что: проект, доска или колонка' },
  title: str('название'),
  parentId: str('для доски — ID проекта, для колонки — ID доски; у проекта родителя нет'),
  color: num('цвет колонки, число от 1 до 16'),
  users: {
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'только для проекта: { ID сотрудника: роль }. Роль — worker, admin, observer или ID своей роли; "-" убирает из проекта',
  },
  stickers: {
    type: 'object',
    description:
      'только для доски: какие стикеры на ней включены, например { "deadline": true, "timeTracking": true, "custom": { "<ID стикера>": true } }',
  },
};

function structureBody(a, body = {}) {
  const spec = STRUCTURE[a.kind];
  if (!spec) throw new Error(`Неизвестный вид: ${a.kind}. Бывает project, board, column`);
  if (a.title !== undefined) body.title = a.title;
  if (a.parentId !== undefined) {
    if (!spec.parent) throw new Error('У проекта нет родителя: parentId не нужен');
    body[spec.parent] = a.parentId;
  }
  const only = { color: 'column', users: 'project', stickers: 'board' };
  for (const [f, kind] of Object.entries(only)) {
    if (a[f] === undefined) continue;
    if (a.kind !== kind) throw new Error(`Поле ${f} бывает только у вида ${kind}`);
    body[f] = a[f];
  }
  return { spec, body };
}

// Стикеры бывают двух видов с разными адресами и разными полями состояний:
// у обычных — цвет, у спринтов — даты начала и конца в секундах.
const STICKER_ICONS = ['', 'star', 'heart', 'check', 'cloud', 'filter', 'alarm', 'bolt', 'bookmark', 'box', 'bulb', 'prio', 'code', 'ruble', 'dollar', 'euro', 'eye', 'flag', 'flame', 'history', 'info', 'key', 'anchor', 'message', 'movie', 'mnote', 'pencil', 'picture', 'pin', 'clockwise', 'clockwiseDot', 'rectangle', 'shield', 'stack', 'string', 'timeStop', 'design', 'user', 'plus', 'gear', 'sort', 'calendar'];

const STICKER_KIND = { type: 'string', enum: ['string', 'sprint'], description: 'string — обычный стикер с состояниями, sprint — спринты' };
const STICKER_ICON = { type: 'string', enum: STICKER_ICONS, description: 'иконка, только для обычного стикера' };
const STICKER_STATE = {
  type: 'object',
  properties: {
    name: str('название состояния'),
    color: str('цвет в формате #RRGGBB, только для обычного стикера'),
    beginIso: str('начало спринта, YYYY-MM-DD или ISO'),
    endIso: str('конец спринта, YYYY-MM-DD или ISO'),
  },
  required: ['name'],
  additionalProperties: false,
};

function stickerPath(kind) {
  if (kind === 'string') return '/string-stickers';
  if (kind === 'sprint') return '/sprint-stickers';
  throw new Error(`Неизвестный вид стикера: ${kind}. Бывает string и sprint`);
}

function stickerState(kind, st, { partial = false } = {}) {
  const out = {};
  if (st.name !== undefined) out.name = st.name;
  else if (!partial) throw new Error('У состояния стикера нужно название');
  if (kind === 'string') {
    if (st.beginIso || st.endIso) throw new Error('Даты бывают только у состояний спринта');
    if (st.color !== undefined) out.color = st.color;
  } else {
    if (st.color !== undefined) throw new Error('Цвет бывает только у состояний обычного стикера');
    // Голая дата: спринт идёт с начала первого дня до конца последнего, по Москве.
    if (st.beginIso) out.begin = Math.floor(toMs(st.beginIso, '00:00:00') / 1000);
    if (st.endIso) out.end = Math.floor(toMs(st.endIso, '23:59:59') / 1000);
  }
  return out;
}

function sticker(s, kind) {
  const states = (s.states || []).filter((st) => !st.deleted);
  return {
    id: s.id,
    kind,
    name: s.name,
    states:
      kind === 'string'
        ? states.map(({ id, name, color }) => ({ id, name, color }))
        : states.map((st) => ({
            id: st.id,
            name: st.name,
            begin: moscowDate((st.begin ?? st.start) * 1000),
            end: moscowDate(st.end * 1000),
          })),
  };
}

// Новый стикер сам на доске не появляется: его надо включить в настройках доски.
// Читаем текущие стикеры доски и добавляем свой, чтобы не выключить остальные.
async function attachSticker(boardId, stickerId) {
  const path = `/boards/${encodeURIComponent(boardId)}`;
  const board = await api('GET', path);
  const stickers = board?.stickers || {};
  await api('PUT', path, { body: { stickers: { ...stickers, custom: { ...stickers.custom, [stickerId]: true } } } });
}

const TOOLS = [
  {
    name: 'yougile_map',
    annotations: READ('Карта проектов, досок и колонок'),
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
    name: 'yougile_stickers',
    annotations: READ('Стикеры и их состояния'),
    description:
      'Пользовательские стикеры (приоритеты, статусы, метки, поля) и спринты — с ID состояний. ' +
      'Нужны, чтобы фильтровать задачи по стикеру и выставлять стикеры задаче.',
    inputSchema: {
      type: 'object',
      properties: { boardId: str('только стикеры этой доски'), name: str('имя стикера') },
      additionalProperties: false,
    },
    async run(a) {
      const query = { boardId: a.boardId, name: a.name, limit: 1000 };
      const strings = items(await api('GET', '/string-stickers', { query }));
      const sprints = items(await api('GET', '/sprint-stickers', { query }));
      return [...strings.map((s) => sticker(s, 'string')), ...sprints.map((s) => sticker(s, 'sprint'))];
    },
  },

  {
    name: 'yougile_create_sticker',
    annotations: WRITE('Создать стикер', { idempotentHint: false }),
    description:
      'Создать стикер с состояниями: обычный (приоритет, статус, метка) или спринты. ' +
      'С boardId сразу включает его на доске — иначе задачам этой доски его не выставить. Возвращает стикер с ID состояний.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: STICKER_KIND,
        name: str('имя стикера, например «Приоритет»'),
        icon: STICKER_ICON,
        states: { type: 'array', items: STICKER_STATE, description: 'состояния, например «Высокий», «Низкий»' },
        boardId: str('включить стикер на этой доске'),
      },
      required: ['kind', 'name'],
      additionalProperties: false,
    },
    async run(a) {
      const path = stickerPath(a.kind);
      const body = { name: a.name };
      if (a.icon !== undefined) {
        if (a.kind !== 'string') throw new Error('Иконка бывает только у обычного стикера');
        body.icon = a.icon;
      }
      if (a.states) body.states = a.states.map((st) => stickerState(a.kind, st));
      const { id } = await api('POST', path, { body });
      if (a.boardId) await attachSticker(a.boardId, id);
      return sticker(await api('GET', `${path}/${id}`), a.kind);
    },
  },

  {
    name: 'yougile_update_sticker',
    annotations: WRITE('Изменить стикер', { destructiveHint: true, idempotentHint: false }),
    description:
      'Изменить стикер: переименовать, сменить иконку, удалить (deleted); добавить состояния (addStates), ' +
      'переименовать, перекрасить, сдвинуть даты спринта или удалить существующие (updateStates).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: STICKER_KIND,
        id: str('ID стикера'),
        name: str('новое имя'),
        icon: STICKER_ICON,
        deleted: bool('удалить стикер'),
        addStates: { type: 'array', items: STICKER_STATE, description: 'новые состояния' },
        updateStates: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: str('ID состояния'), ...STICKER_STATE.properties, deleted: bool('удалить состояние') },
            required: ['id'],
            additionalProperties: false,
          },
          description: 'изменения существующих состояний',
        },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
    async run(a) {
      const path = `${stickerPath(a.kind)}/${encodeURIComponent(a.id)}`;
      const body = {};
      for (const f of ['name', 'icon', 'deleted']) {
        if (a[f] !== undefined) body[f] = a[f];
      }
      if (body.icon !== undefined && a.kind !== 'string') throw new Error('Иконка бывает только у обычного стикера');
      // Состояния проверяем заранее, чтобы не остаться с наполовину применёнными изменениями.
      const added = (a.addStates || []).map((st) => stickerState(a.kind, st));
      const updated = (a.updateStates || []).map(({ id, deleted, ...st }) => {
        const state = stickerState(a.kind, st, { partial: true });
        if (deleted !== undefined) state.deleted = deleted;
        if (!Object.keys(state).length) throw new Error(`Для состояния ${id} не передано ни одного поля`);
        return [id, state];
      });
      if (!Object.keys(body).length && !added.length && !updated.length) {
        throw new Error('Нечего менять: не передано ни одного поля');
      }

      if (Object.keys(body).length) await api('PUT', path, { body });
      for (const state of added) await api('POST', `${path}/states`, { body: state });
      for (const [id, state] of updated) await api('PUT', `${path}/states/${encodeURIComponent(id)}`, { body: state });
      return body.deleted ? { id: a.id, deleted: true } : sticker(await api('GET', path), a.kind);
    },
  },

  {
    name: 'yougile_tasks',
    annotations: READ('Список задач'),
    description:
      'Список задач. Фильтры: колонка, исполнитель, подстрока заголовка, стикер и его состояние. Фильтра по проекту в API нет — фильтруйте по колонке.',
    inputSchema: {
      type: 'object',
      properties: {
        columnId: str('ID колонки'),
        assignedTo: str('ID сотрудника-исполнителя'),
        title: str('подстрока заголовка'),
        stickerId: str('ID стикера (yougile_stickers)'),
        stickerStateId: str('ID состояния стикера'),
        includeDeleted: bool('показывать удалённые, по умолчанию нет'),
        limit: num('сколько вернуть, по умолчанию 50'),
        offset: num('сдвиг для постраничного чтения'),
      },
      additionalProperties: false,
    },
    async run(a) {
      // /tasks отдаёт то же в обратном порядке и помечен в документации как устаревший.
      const r = await api('GET', '/task-list', {
        query: {
          columnId: a.columnId,
          assignedTo: a.assignedTo,
          title: a.title,
          stickerId: a.stickerId,
          stickerStateId: a.stickerStateId,
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
    annotations: READ('Карточка задачи'),
    description: 'Одна задача целиком: стикеры, чеклисты, подзадачи, учёт времени. Принимает и UUID, и код вида ABC-123.',
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
    annotations: WRITE('Создать задачу', { idempotentHint: false }),
    description:
      'Создать задачу в колонке. Описание — HTML, не markdown. Подзадача — это обычная задача, ' +
      'чей ID добавлен в subtasks родителя. idempotencyKey защищает от дублей при повторе.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('заголовок'),
        columnId: str('ID колонки'),
        ...TASK_PROPS,
        idempotencyKey: str('любая уникальная строка; повторный вызов с тем же ключом вернёт уже созданную задачу'),
      },
      required: ['title', 'columnId'],
      additionalProperties: false,
    },
    async run(a) {
      const body = taskBody(a, { title: a.title, columnId: a.columnId });
      if (a.idempotencyKey) body.idempotencyKey = a.idempotencyKey;
      return api('POST', '/tasks', { body });
    },
  },

  {
    name: 'yougile_update_task',
    annotations: WRITE('Изменить задачу', { destructiveHint: true, idempotentHint: true }),
    description:
      'Изменить задачу: перенести в другую колонку (columnId), закрыть (completed), переименовать, сменить описание, ' +
      'исполнителей, срок, стикеры, чеклисты, подзадачи, учёт времени, участников чата, удалить (deleted). ' +
      'Передавайте только то, что меняется.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('UUID задачи'),
        columnId: str('перенести в эту колонку'),
        title: str('новый заголовок'),
        completed: bool('отметить выполненной'),
        archived: bool('в архив'),
        deleted: bool('удалить'),
        ...TASK_PROPS,
        removeDeadline: bool('снять срок'),
        removeTimeTracking: bool('снять учёт времени'),
        removeTimer: bool('снять таймер'),
        removeStopwatch: bool('снять секундомер'),
        chatSubscribers: {
          type: 'array',
          items: { type: 'string' },
          description: 'ID участников чата задачи. Список заменяется целиком',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(a) {
      const body = {};
      for (const f of ['columnId', 'title', 'completed', 'archived', 'deleted']) {
        if (a[f] !== undefined) body[f] = a[f];
      }
      taskBody(a, body);
      const removals = { removeDeadline: 'deadline', removeTimeTracking: 'timeTracking', removeTimer: 'timer', removeStopwatch: 'stopwatch' };
      for (const [flag, field] of Object.entries(removals)) {
        if (!a[flag]) continue;
        if (body[field]) throw new Error(`Одновременно ${field} и ${flag}: выберите что-то одно`);
        body[field] = { deleted: true };
      }

      const hasBody = Object.keys(body).length > 0;
      if (!hasBody && !a.chatSubscribers) throw new Error('Нечего менять: не передано ни одного поля');

      const id = encodeURIComponent(a.id);
      const result = hasBody ? await api('PUT', `/tasks/${id}`, { body }) : { id: a.id };
      if (a.chatSubscribers) {
        await api('PUT', `/tasks/${id}/chat-subscribers`, { body: { content: a.chatSubscribers } });
      }
      return result;
    },
  },

  {
    name: 'yougile_task_subscribers',
    annotations: READ('Участники чата задачи'),
    description: 'Кто подписан на чат задачи и получает уведомления о комментариях. Изменить — yougile_update_task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: str('UUID задачи') },
      required: ['taskId'],
      additionalProperties: false,
    },
    run: async (a) => items(await api('GET', `/tasks/${encodeURIComponent(a.taskId)}/chat-subscribers`)),
  },

  {
    name: 'yougile_comments',
    annotations: READ('Комментарии задачи'),
    description: 'Комментарии задачи (её чат), новые сверху. Можно отфильтровать по автору, тексту и времени.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: str('UUID задачи'),
        fromUserId: str('только от этого сотрудника'),
        text: str('подстрока текста'),
        sinceIso: str('только написанные позже этого момента, YYYY-MM-DD или ISO'),
        includeSystem: bool('включать системные сообщения (перенос, смена исполнителя и т. п.)'),
        limit: num('сколько вернуть, по умолчанию 50'),
        offset: num('сдвиг для постраничного чтения'),
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    async run(a) {
      const r = await api('GET', `/chats/${encodeURIComponent(a.taskId)}/messages`, {
        query: {
          fromUserId: a.fromUserId,
          text: a.text,
          since: a.sinceIso ? toMs(a.sinceIso, '00:00:00') : undefined,
          includeSystem: a.includeSystem,
          limit: a.limit ?? 50,
          offset: a.offset,
        },
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
    annotations: WRITE('Написать комментарий', { idempotentHint: false }),
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
    annotations: READ('Сотрудники компании'),
    description: 'Сотрудники компании: ID, имя, почта. Нужны, чтобы назначать задачи.',
    inputSchema: {
      type: 'object',
      properties: { email: str('фильтр по почте') },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api('GET', '/users', { query: { email: a.email, limit: 200 } });
      return items(r).map(user);
    },
  },

  {
    name: 'yougile_me',
    annotations: READ('Текущий пользователь'),
    description: 'Сотрудник, от чьего имени выпущен ключ. Удобно для «мои задачи» и чтобы не отвечать самому себе.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => user(await api('GET', '/users/me')),
  },

  {
    name: 'yougile_create_structure',
    annotations: WRITE('Создать проект, доску или колонку', { idempotentHint: false }),
    description:
      'Создать проект, доску в проекте или колонку на доске. Для доски parentId — ID проекта, для колонки — ID доски.',
    inputSchema: {
      type: 'object',
      properties: {
        ...STRUCTURE_PROPS,
        idempotencyKey: str('любая уникальная строка; повторный вызов с тем же ключом вернёт уже созданное'),
      },
      required: ['kind', 'title'],
      additionalProperties: false,
    },
    async run(a) {
      const { spec, body } = structureBody(a);
      if (spec.parent && !body[spec.parent]) throw new Error(`Для вида ${a.kind} нужен parentId`);
      if (a.idempotencyKey) body.idempotencyKey = a.idempotencyKey;
      return api('POST', spec.path, { body });
    },
  },

  {
    name: 'yougile_update_structure',
    annotations: WRITE('Изменить проект, доску или колонку', { destructiveHint: true, idempotentHint: true }),
    description:
      'Переименовать, перенести (доску в другой проект, колонку на другую доску), сменить цвет колонки, ' +
      'состав проекта, стикеры доски или удалить (deleted) проект, доску или колонку.',
    inputSchema: {
      type: 'object',
      properties: { ...STRUCTURE_PROPS, id: str('ID того, что меняем'), deleted: bool('удалить') },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
    async run(a) {
      const { spec, body } = structureBody(a);
      if (a.deleted !== undefined) body.deleted = a.deleted;
      if (!Object.keys(body).length) throw new Error('Нечего менять: не передано ни одного поля');
      return api('PUT', `${spec.path}/${encodeURIComponent(a.id)}`, { body });
    },
  },
];

const user = (u) => ({ id: u.id, name: u.realName || u.name, email: u.email, isAdmin: u.isAdmin });

function brief(t) {
  return {
    id: t.id,
    code: t.idTaskCommon || t.code,
    title: t.title,
    columnId: t.columnId,
    completed: t.completed,
    assigned: t.assigned,
    deadline: moscowDate(t.deadline?.deadline),
    stickers: t.stickers && Object.keys(t.stickers).length ? t.stickers : undefined,
  };
}

// Дата YYYY-MM-DD по Москве; NaN и пустое значение — undefined.
const moscowDate = (ms) => (ms ? new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }) : undefined);

// Голая дата — по Москве: для срока полдень (чтобы в любом поясе был тот же день),
// для фильтра «начиная с» — начало дня.
function toMs(value, time = '12:00:00') {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T${time}+03:00`) : Date.parse(value);
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
        { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })) },
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
