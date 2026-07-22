// Code Kanban web GUI — zero-build vanilla ESM. All board reads/mutations go
// through the in-process /api/board/* routes, which delegate 1:1 to board.js
// (the single writer). Domain refusals come back as 200 {ok:false,code,reason}
// and are surfaced here rather than worked around. See docs/protocol.md.

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = dv;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
};

const state = {
  meta: { states: [], transitions: [] },
  projects: [],
  current: null,
  tasks: [],
  epics: [],
};

// 2-char rollup-pill labels. s[0] collides (triage and todo both render "t"),
// so each state gets a distinct short label. Keys track STATES in src/paths.js.
const ROLLUP_LABEL = { triage: 'tr', backlog: 'bk', todo: 'td', 'in-progress': 'ip', done: 'dn' };

// ---- api ------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = { ok: false, code: 'BAD_RESPONSE', reason: `non-JSON ${res.status}` }; }
  if (!res.ok && data && data.error) {
    throw new ApiError(data.error, res.status);
  }
  return data;
}
class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

// Refusal codes worth surfacing verbatim to the human (board.js reasons are
// already human-readable, e.g. "illegal transition triage -> done").
function refusalReason(data) {
  if (data && data.ok === false) return data.reason || data.code || 'refused';
  return null;
}

// ---- status + overlays ----------------------------------------------------

const statusEl = $('#status');
let statusTimer;
function setStatus(msg, kind = '') {
  clearTimeout(statusTimer);
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
  if (kind === 'ok') statusTimer = setTimeout(() => setStatus(''), 2500);
}

function openOverlay(node) {
  const ov = $('#form-overlay');
  ov.replaceChildren(node);
  ov.classList.remove('hidden');
}
function closeOverlay() { $('#form-overlay').classList.add('hidden'); }
function showDetail(node) {
  const ov = $('#detail-overlay');
  $('#detail-body').replaceChildren(node);
  ov.classList.remove('hidden');
}
function closeDetail() { $('#detail-overlay').classList.add('hidden'); }

// ---- bootstrap ------------------------------------------------------------

async function init() {
  $('#detail-overlay .overlay-close').addEventListener('click', closeDetail);
  $('#form-overlay').addEventListener('click', (e) => { if (e.target.id === 'form-overlay') closeOverlay(); });
  $('#detail-overlay').addEventListener('click', (e) => { if (e.target.id === 'detail-overlay') closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDetail(); closeOverlay(); } });

  $('#new-task-btn').addEventListener('click', () => renderTaskForm());
  $('#new-epic-btn').addEventListener('click', () => renderEpicForm());
  $('#refresh-btn').addEventListener('click', () => loadBoard());
  $('#project-select').addEventListener('change', (e) => selectProject(e.target.value));

  try {
    const [metaRes, projRes] = await Promise.all([api('api/board/meta'), api('api/projects')]);
    state.meta = metaRes;
    state.projects = projRes.projects || [];
  } catch (e) {
    setStatus(`Failed to initialize: ${e.message}`, 'err');
    return;
  }
  renderProjectSelect();
  if (state.projects.length) selectProject(state.projects[0]);
  else setStatus('No projects available.', '');
}

function renderProjectSelect() {
  const sel = $('#project-select');
  sel.replaceChildren(el('option', { value: '', disabled: '' }, '— select —'));
  for (const p of state.projects) sel.append(el('option', { value: p }, p));
}

function setBoardEnabled(on) {
  for (const id of ['new-task-btn', 'new-epic-btn', 'refresh-btn']) $('#' + id).disabled = !on;
}

// ---- board load + render --------------------------------------------------

async function selectProject(name) {
  if (!name) { state.current = null; setBoardEnabled(false); return; }
  state.current = name;
  setBoardEnabled(true);
  await loadBoard();
}

async function loadBoard() {
  if (!state.current) return;
  setStatus('Loading…');
  try {
    const [tasksRes, epicsRes] = await Promise.all([
      api(`api/board/${encodeURIComponent(state.current)}/tasks`),
      api(`api/board/${encodeURIComponent(state.current)}/epics`),
    ]);
    const tr = refusalReason(tasksRes), er = refusalReason(epicsRes);
    if (tr) { setStatus(`${tr}`, 'err'); state.tasks = []; state.epics = []; }
    else { state.tasks = tasksRes.tasks || []; state.epics = epicsRes.ok ? (epicsRes.epics || []) : []; }
    renderBoard();
    renderEpics();
    if (!tr) setStatus(`Loaded ${state.tasks.length} card(s) across ${state.epics.length} epic(s).`, 'ok');
  } catch (e) {
    setStatus(`Load failed: ${e.message}`, 'err');
  }
}

function transitionsFrom(from) {
  return state.meta.transitions
    .filter((t) => t.startsWith(from + '>'))
    .map((t) => t.split('>')[1]);
}

function renderBoard() {
  const board = $('#board');
  board.replaceChildren();
  for (const st of state.meta.states) {
    const cards = state.tasks.filter((t) => t.state === st);
    const body = cards.length
      ? cards.map(renderCard)
      : [el('div', { class: 'column-empty' }, '— empty —')];
    const col = el('section', { class: 'column', dataset: { state: st } }, [
      el('div', { class: 'column-head' }, [
        st.replace('-', ' '),
        el('span', { class: 'column-count' }, String(cards.length)),
      ]),
      el('div', { class: 'column-body' }, body),
    ]);
    board.append(col);
  }
}

function renderCard(t) {
  const meta = [];
  if (t.epic) meta.push(el('span', { class: 'badge epic' }, t.epic));
  if (t.priority) meta.push(el('span', { class: 'badge prio' }, `p${t.priority}`));
  if (t.owner) meta.push(el('span', { class: 'badge owner' }, t.owner));
  return el('div', { class: 'card', tabindex: '0', role: 'button', onclick: () => openDetail(t.id), onkeydown: (e) => { if (e.key === 'Enter') openDetail(t.id); } }, [
    el('div', { class: 'card-id' }, t.id),
    el('div', { class: 'card-title' }, t.title),
    meta.length ? el('div', { class: 'card-meta' }, meta) : null,
  ]);
}

// ---- epics ----------------------------------------------------------------

function renderEpics() {
  const root = $('#epics');
  const list = state.epics.length
    ? state.epics.map((e) => el('div', { class: 'epic-row' }, [
        el('div', {}, [el('div', { class: 'epic-title' }, e.title), el('div', { class: 'epic-slug' }, e.slug)]),
        renderRollup(e.rollup),
        el('button', { class: 'ghost', type: 'button', onclick: () => openEpic(e.slug) }, 'open'),
      ]))
    : [el('div', { class: 'hint' }, 'No epics yet.')];
  root.replaceChildren(
    el('div', { class: 'epics-head' }, [el('h2', {}, 'Epics')]),
    el('div', { class: 'epic-list' }, list),
  );
}

function renderRollup(rollup) {
  return el('div', { class: 'rollup' }, state.meta.states.map((s) => {
    const n = rollup?.[s] ?? 0;
    return el('span', { class: 'rollup-pill', dataset: { zero: String(n === 0) } }, `${ROLLUP_LABEL[s] ?? s}: `, el('b', {}, String(n)));
  }));
}

async function openEpic(slug) {
  let data;
  try { data = await api(`api/board/${encodeURIComponent(state.current)}/epics/${encodeURIComponent(slug)}`); }
  catch (e) { return setStatus(`Read epic failed: ${e.message}`, 'err'); }
  const r = refusalReason(data);
  if (r) return setStatus(r, 'err');
  const body = el('div', {}, [
    el('div', { class: 'detail-head' }, [el('span', { class: 'detail-state' }, `epic · ${data.epic.slug}`)]),
    el('div', { class: 'detail-title' }, data.epic.title),
    detailSection('Goal', data.epic.goal || '—'),
    detailSection('Rollup', null, renderRollup(data.epic.rollup)),
    detailSection('Tasks', data.tasks.length ? null : '— none —',
      el('ul', { class: 'acceptance' }, data.tasks.map((t) => el('li', {}, [
        el('span', { class: 'card-id' }, t.id), ' ', t.title, ' · ', el('span', { class: 'badge' }, t.state),
      ]))),
    ),
  ]);
  showDetail(body);
}

// ---- card detail ----------------------------------------------------------

function detailSection(label, text, node) {
  return el('div', { class: 'detail-section' }, [
    el('h3', {}, label),
    node || (text != null ? el('p', { class: text ? '' : 'muted' }, text || '—') : null),
  ]);
}

async function openDetail(id) {
  let data;
  try { data = await api(`api/board/${encodeURIComponent(state.current)}/tasks/${encodeURIComponent(id)}`); }
  catch (e) { return setStatus(`Read task failed: ${e.message}`, 'err'); }
  const r = refusalReason(data);
  if (r) return setStatus(r, 'err');
  openDetailNode(data.task);
}

function openDetailNode(t) {
  const targets = transitionsFrom(t.state);
  const moveRow = el('div', { class: 'move-row' }, [
    el('label', { class: 'field' }, ['Move to',
      el('select', {}, targets.length
        ? targets.map((s) => el('option', { value: s }, s))
        : [el('option', { value: '', disabled: '' }, 'no legal moves')]),
    ]),
    el('button', { type: 'button', onclick: (e) => doMoveFromDetail(t.id, e) }, 'Move'),
  ]);

  const body = el('div', {}, [
    el('div', { class: 'detail-head' }, [
      el('span', { class: 'detail-id' }, t.id),
      el('span', { class: 'detail-state' }, t.state),
    ]),
    el('div', { class: 'detail-title' }, t.title),
    detailSection('Goal', t.goal),
    detailSection('Acceptance', null,
      t.acceptance?.length
        ? el('ul', { class: 'acceptance' }, (t.acceptance || []).map((a) => el('li', {}, [
            el('input', { type: 'checkbox', disabled: '', ...(a.done ? { checked: '' } : {}) }),
            el('span', {}, a.text),
          ])))
        : el('p', { class: 'muted' }, '— none —')),
    detailSection('Logbook', null,
      t.logbook?.length
        ? el('ul', { class: 'logbook' }, (t.logbook || []).slice().reverse().map(renderLogLine))
        : el('p', { class: 'muted' }, '— empty —')),
    detailSection('Move', null, moveRow),
    detailSection('Edit', null, renderEditForm(t)),
  ]);
  showDetail(body);
}

function renderLogLine(line) {
  // "<ISO> · <sid8> · <entry>"
  const parts = line.split(' · ');
  const sid = parts.length >= 3 ? parts[1] : '';
  const rest = parts.length >= 3 ? parts.slice(2).join(' · ') : line;
  return el('li', {}, sid ? [parts[0], ' · ', el('span', { class: 'sid' }, sid), ' · ', rest] : [line]);
}

function renderEditForm(t) {
  const epicOpts = [el('option', { value: '' }, '— none —'), ...state.epics.map((e) => el('option', { value: e.slug, ...(t.epic === e.slug ? { selected: '' } : {}) }, e.slug))];
  const f = el('form', { class: 'form-grid', onsubmit: (e) => doEdit(e, t.id) }, [
    el('label', { class: 'field' }, ['Title', el('input', { name: 'title', value: t.title })]),
    el('label', { class: 'field' }, ['Goal', el('textarea', { name: 'goal', rows: '3' }, t.goal || '')]),
    el('label', { class: 'field' }, ['Epic', el('select', { name: 'epic' }, epicOpts)]),
    el('label', { class: 'field' }, ['Priority', el('input', { name: 'priority', type: 'number', value: String(t.priority ?? 0) })]),
    el('label', { class: 'field' }, ['Depends on (comma-separated ids)', el('input', { name: 'depends_on', value: (t.depends_on || []).join(', ') })]),
    el('div', { class: 'form-error' }, ''),
    el('div', { class: 'form-actions' }, [el('button', { type: 'submit', class: 'primary' }, 'Save')]),
  ]);
  return f;
}

async function doEdit(e, id) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const fields = {
    title: fd.get('title')?.toString().trim(),
    goal: fd.get('goal')?.toString(),
    epic: fd.get('epic')?.toString() || null,
    priority: Number.parseInt(fd.get('priority'), 10) || 0,
    depends_on: fd.get('depends_on')?.toString().split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (!fields.title) { form.querySelector('.form-error').textContent = 'title is required'; return; }
  let data;
  try { data = await api(`api/board/${encodeURIComponent(state.current)}/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: fields }); }
  catch (e2) { form.querySelector('.form-error').textContent = e2.message; return; }
  const r = refusalReason(data);
  if (r) { form.querySelector('.form-error').textContent = r; return; }
  setStatus('Saved.', 'ok');
  closeDetail();
  await loadBoard();
}

async function doMoveFromDetail(id, ev) {
  const sel = ev.target.closest('.move-row').querySelector('select');
  const to = sel.value;
  if (!to) return;
  await moveCard(id, to);
  closeDetail();
}

// ---- move (surfaces INVALID_STATE refusals) --------------------------------

async function moveCard(id, to) {
  let data;
  try { data = await api(`api/board/${encodeURIComponent(state.current)}/tasks/${encodeURIComponent(id)}/move`, { method: 'POST', body: { to } }); }
  catch (e) { return setStatus(`Move failed: ${e.message}`, 'err'); }
  const r = refusalReason(data);
  if (r) { setStatus(`Move refused: ${r}`, 'err'); return; }
  setStatus(`Moved ${data.from} → ${data.to}.`, 'ok');
  await loadBoard();
}

// ---- new task form --------------------------------------------------------

function renderTaskForm() {
  const epicOpts = [el('option', { value: '' }, '— none —'), ...state.epics.map((e) => el('option', { value: e.slug }, e.slug))];
  const form = el('form', { class: 'form-grid', onsubmit: doFileTask }, [
    el('h2', {}, 'New task'),
    el('label', { class: 'field' }, ['Title', el('input', { name: 'title', required: '' })]),
    el('label', { class: 'field' }, ['Goal', el('textarea', { name: 'goal', rows: '3' })]),
    el('label', { class: 'field' }, ['Acceptance (one per line)', el('textarea', { name: 'acceptance', rows: '3' })]),
    el('label', { class: 'field' }, ['Epic', el('select', { name: 'epic' }, epicOpts)]),
    el('label', { class: 'field' }, ['Depends on (comma-separated ids)', el('input', { name: 'depends_on' })]),
    el('div', { class: 'form-error' }, ''),
    el('div', { class: 'form-actions' }, [
      el('button', { type: 'button', class: 'ghost', onclick: closeOverlay }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, 'File into triage'),
    ]),
  ]);
  openOverlay(el('div', { class: 'overlay-card' }, [
    el('button', { class: 'overlay-close', type: 'button', 'aria-label': 'Close', onclick: closeOverlay }, '✕'),
    form,
  ]));
}

async function doFileTask(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const body = {
    title: fd.get('title')?.toString().trim(),
    goal: fd.get('goal')?.toString(),
    acceptance: fd.get('acceptance')?.toString().split('\n').map((s) => s.trim()).filter(Boolean),
    epic: fd.get('epic')?.toString() || undefined,
    depends_on: fd.get('depends_on')?.toString().split(',').map((s) => s.trim()).filter(Boolean),
  };
  let data;
  try { data = await api(`api/board/${encodeURIComponent(state.current)}/tasks`, { method: 'POST', body }); }
  catch (e2) { form.querySelector('.form-error').textContent = e2.message; return; }
  const r = refusalReason(data);
  if (r) { form.querySelector('.form-error').textContent = r; return; }
  setStatus(`Filed ${data.id} into triage.`, 'ok');
  closeOverlay();
  await loadBoard();
}

// ---- new epic form --------------------------------------------------------

function renderEpicForm() {
  const form = el('form', { class: 'form-grid', onsubmit: doCreateEpic }, [
    el('h2', {}, 'New epic'),
    el('label', { class: 'field' }, ['Slug', el('input', { name: 'slug', required: '', pattern: '^[a-z0-9._-]+$', placeholder: 'lowercase, e.g. auth-flow' })]),
    el('label', { class: 'field' }, ['Title', el('input', { name: 'title', required: '' })]),
    el('label', { class: 'field' }, ['Goal', el('textarea', { name: 'goal', rows: '3' })]),
    el('div', { class: 'form-error' }, ''),
    el('div', { class: 'form-actions' }, [
      el('button', { type: 'button', class: 'ghost', onclick: closeOverlay }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, 'Create / refresh'),
    ]),
    el('p', { class: 'hint' }, 'Creating an existing slug refreshes its title/goal (upsert).'),
  ]);
  openOverlay(el('div', { class: 'overlay-card' }, [
    el('button', { class: 'overlay-close', type: 'button', 'aria-label': 'Close', onclick: closeOverlay }, '✕'),
    form,
  ]));
}

async function doCreateEpic(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const body = {
    slug: fd.get('slug')?.toString().trim(),
    title: fd.get('title')?.toString().trim(),
    goal: fd.get('goal')?.toString(),
  };
  let data;
  try { data = await api(`api/board/${encodeURIComponent(state.current)}/epics`, { method: 'POST', body }); }
  catch (e2) { form.querySelector('.form-error').textContent = e2.message; return; }
  const r = refusalReason(data);
  if (r) { form.querySelector('.form-error').textContent = r; return; }
  setStatus(`Epic ${body.slug} saved.`, 'ok');
  closeOverlay();
  await loadBoard();
}

init();