/**
 * @file app.js · Work log widget for a Notion planner.
 *
 * Layout
 * ------
 *  Title
 *  Goals       Primary · Secondary · Tertiary        (type-ahead relations)
 *  Classifiers Stage · Category · Category's type    (selects)
 *  Links       Task · Meeting · Requests · JIRA      (type-ahead relations + URL)
 *  Buttons     Start · Stop · New
 *  Pipeline    Pipeline Link · Packages · Platform · Pipeline File
 *  Details     Description · Output · Files
 *
 * Flow
 * ----
 *  1. On load, fetch page names from the linked databases and fill the
 *     pickers. Every link is a combobox: newest pages first, closest title
 *     match as you type, and older pages found by searching Notion.
 *  2. Start → create a Work Log entry with the fields above.
 *  3. Stop  → write the Stop time to that entry.
 *  4. Description, Output, Pipeline Link, Packages and Platform autosave;
 *     Files and Pipeline File upload and attach.
 *  5. New   → clear the widget only. The Work Log entry is never touched.
 *
 * Why a proxy?
 * ------------
 * Notion's API refuses requests made directly from a browser (CORS), and the
 * integration token has to stay secret. Every call here goes to worker.js,
 * which holds the token and talks to Notion on the widget's behalf.
 *
 * State survives reloads (Notion re-renders embeds often) via localStorage.
 */

'use strict';


/* ==========================================================================
   1. Configuration
   ========================================================================== */

/**
 * Deployment settings come from the URL hash, so nothing private lives in
 * the repo. Browsers never send the hash to GitHub's servers.
 *
 *   https://<you>.github.io/worklog-widget/#api=<worker-url>&key=<widget-key>
 *
 * Optional: &theme=light or &theme=dark sets the starting theme. The footer
 * toggle overrides it and is remembered from then on.
 */
const hash = new URLSearchParams(location.hash.slice(1));

const CONFIG = Object.freeze({
  api: (hash.get('api') || '').replace(/\/+$/, ''),
  key: hash.get('key') || '',
  storageKey: 'worklog-widget:state:v2',
  optionsKey: 'worklog-widget:options:v2',
  themeKey: 'worklog-widget:theme',
  autosaveMs: 1200,
  searchMs: 250,
  maxFileBytes: 20 * 1024 * 1024,   // Notion single-part upload limit
});


/* ==========================================================================
   2. Taxonomy
   ========================================================================== */

/**
 * Every link to a Notion page. Each is a type-ahead picker: the newest pages
 * first, and the closest title match as you type. Keys match SOURCES in
 * worker.js and the element ids in index.html.
 */
const COMBO_KEYS = ['primary', 'secondary', 'tertiary', 'task', 'meeting', 'request'];

/** The plain <select>s: fixed local lists, not Notion pages. */
const SELECT_KEYS = ['stage', 'category', 'subtype'];

/**
 * What must be filled before Start, Stop and New unlock. Subtype is added
 * only when the chosen Category has a second level. Meeting, Requests and
 * JIRA are optional links. A link counts as filled only once a page has been
 * picked from its list; typed text that was never picked doesn't.
 *
 * To make a link required too, add its key here (for example 'meeting').
 */
const REQUIRED_KEYS = ['primary', 'secondary', 'tertiary', 'stage', 'category', 'task'];

/** Display names used in the "what's missing" hint. */
const LABELS = {
  primary: 'Primary',
  secondary: 'Secondary',
  tertiary: 'Tertiary',
  stage: 'Stage',
  category: 'Category',
  subtype: 'Type',
  task: 'Task',
  meeting: 'Meeting',
  request: 'Requests',
};

const STAGES = ['Planning', 'Execution', 'Assessment', 'Finalize'];

/**
 * Category → its own second-level options. A category that isn't a key here
 * (Support) has no second level, so the third cell of the Classifiers row
 * stays blank. Every name below must also exist in the Work Log "Type"
 * select, and the same list is validated in worker.js.
 */
const SUBTYPES = {
  Experiment: [
    'Sample Selection', 'Sectioning', 'Imaging', 'FACS',
    'Spatial-Sequencing', 'scRNA-seq',
  ],
  Analysis: [
    'Pipeline Dev', 'QC', 'Data Integration', 'Spatial Data Preparation',
    'scRNA-seq Data Preparation', 'Cell-Type Annotation', 'DE',
    'Multi-Modal Integration', 'Modeling', 'Optimization', 'Troubleshoot',
  ],
  Dissemination: ['Figures', 'Slides', 'Writing', 'Speech'],
  Support: null,
};

const CATEGORIES = Object.keys(SUBTYPES);

/**
 * Free-text fields that save to the entry. They're typed like Description and
 * Output now; Packages and Platform become selects later, at which point they
 * move out of this list and into SELECT_KEYS.
 */
const TEXT_KEYS = ['description', 'output', 'pipelineLink', 'packages', 'platform'];

/**
 * Attachment zones. Each one uploads to Notion and writes its whole list to
 * one Files property. `prop` is the key the Worker's PATCH route expects.
 */
const FILE_FIELDS = {
  files:         { prop: 'files',         noun: 'file' },
  pipelineFiles: { prop: 'pipelineFiles', noun: 'pipeline file' },
};
const FILE_KEYS = Object.keys(FILE_FIELDS);

/** @param {string} category @returns {string[]|null} */
const subtypesFor = (category) => SUBTYPES[category] || null;


/* ==========================================================================
   3. State
   ========================================================================== */

/**
 * @typedef {{id: string, name: string}} PageRef
 *
 * @typedef {Object} WidgetState
 * @property {string} title
 * @property {Record<string,string>} picks   Select key → chosen option name
 * @property {Record<string,PageRef|null>} links  Picker key → chosen Notion page
 * @property {string} jira
 * @property {string} description
 * @property {string} output
 * @property {string} pipelineLink  URL of the pipeline (repo, workflow, docs)
 * @property {string} packages      Free text for now; becomes a select later
 * @property {string} platform      Free text for now; becomes a select later
 * @property {string|null} pageId   Work Log page created by Start
 * @property {string|null} start    ISO 8601 timestamp with UTC offset
 * @property {string|null} stop     ISO 8601 timestamp with UTC offset
 * @property {PageRef[]} files          File uploads attached to Files
 * @property {PageRef[]} pipelineFiles  File uploads attached to Pipeline File
 * @property {boolean} manual       Manual mode: log a finished item by hand
 * @property {string} mDate         Manual entry day, YYYY-MM-DD
 * @property {{start: ClockTime, end: ClockTime}} mTime  Manual entry times
 *
 * @typedef {{h: string, m: string, p: ''|'AM'|'PM'}} ClockTime
 *   12-hour pieces exactly as picked: h "01"–"12", m "00"–"59"
 */

const emptyClock = () => ({ h: '', m: '', p: '' });

/** @returns {WidgetState} */
function emptyState() {
  return {
    title: '',
    picks: Object.fromEntries(SELECT_KEYS.map((k) => [k, ''])),
    links: Object.fromEntries(COMBO_KEYS.map((k) => [k, null])),
    jira: '',
    description: '',
    output: '',
    pipelineLink: '',
    packages: '',
    platform: '',
    pageId: null,
    start: null,
    stop: null,
    files: [],
    pipelineFiles: [],
    manual: false,
    mDate: '',
    mTime: { start: emptyClock(), end: emptyClock() },
  };
}

/** Read JSON from localStorage; null if missing, corrupt or blocked. */
function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

/** Write JSON to localStorage; failures are non-fatal. */
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* session-only */ }
}

/** @returns {WidgetState} saved state merged onto a clean default */
function loadState() {
  const saved = readJSON(CONFIG.storageKey) || {};
  const base = emptyState();
  const merged = {
    ...base,
    ...saved,
    picks: { ...base.picks, ...(saved.picks || {}) },
    links: { ...base.links, ...(saved.links || {}) },
    manual: saved.manual === true,
    mTime: {
      start: { ...base.mTime.start, ...(saved.mTime?.start || {}) },
      end: { ...base.mTime.end, ...(saved.mTime?.end || {}) },
    },
  };
  for (const key of FILE_KEYS) merged[key] = Array.isArray(saved[key]) ? saved[key] : [];

  // Primary, Secondary, Tertiary and Task used to be plain selects that kept
  // a page id in `picks`. Carry an in-progress choice over into `links`, with
  // its name looked up from the cached lists.
  const cached = readJSON(CONFIG.optionsKey) || {};
  for (const key of COMBO_KEYS) {
    const legacyId = saved.picks?.[key];
    if (legacyId && !merged.links[key]) {
      const hit = (cached[key] || []).find((page) => page.id === legacyId);
      merged.links[key] = { id: legacyId, name: hit?.name || 'Saved selection' };
    }
    delete merged.picks[key];
  }

  // A subtype can't outlive a category change, or a rename such as
  // "Pipeline development" → "Pipeline Dev" made after it was saved.
  if (!subtypesFor(merged.picks.category)?.includes(merged.picks.subtype)) {
    merged.picks.subtype = '';
  }
  return merged;
}

/** @type {WidgetState} */
let state = loadState();
const save = () => writeJSON(CONFIG.storageKey, state);

/** Cached dropdown options, keyed as in worker.js. */
let options = readJSON(CONFIG.optionsKey) || {};

let busy = false;          // a Start/Stop/upload request is in flight
let saveTimer = null;      // pending Description/Output autosave
let confirmTimer = null;   // "Clear anyway?" window on the New button


/* ==========================================================================
   4. DOM references
   ========================================================================== */

const $ = (id) => document.getElementById(id);

const el = {
  root: $('log'),
  title: $('title'),
  selects: Object.fromEntries(SELECT_KEYS.map((k) => [k, $(k)])),
  subtypeField: $('subtype-field'),
  subtypeLabel: $('subtype-label'),
  jira: $('jira'),
  start: $('start'),
  stop: $('stop'),
  log: $('log-btn'),      // not "log": that id is the <main> element
  manual: $('manual'),
  manualPanel: $('manual-panel'),
  mDate: $('m-date'),
  mDuration: $('m-duration'),
  mSelects: {
    start: { h: $('m-start-h'), m: $('m-start-m') },
    end:   { h: $('m-end-h'),   m: $('m-end-m') },
  },
  periodBtns: document.querySelectorAll('[data-period]'),
  newBtn: $('new'),
  hint: $('hint'),
  description: $('description'),
  output: $('output'),
  pipelineLink: $('pipeline-link'),
  packages: $('packages'),
  platform: $('platform'),
  zones: {
    files:         { input: $('files'),         drop: $('drop'),          text: $('drop-text'),          list: $('file-list') },
    pipelineFiles: { input: $('pipeline-file'), drop: $('pipeline-drop'), text: $('pipeline-drop-text'), list: $('pipeline-file-list') },
  },
  clockState: $('clock-state'),
  clockTime: $('clock-time'),
  sync: $('sync'),
  reload: $('reload'),
  themeLight: $('theme-light'),
  themeDark: $('theme-dark'),
};


/* ==========================================================================
   5. Theme
   ========================================================================== */

const systemTheme = () =>
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/**
 * Apply a theme. Without an explicit choice the CSS follows the system, so
 * data-theme is removed rather than pinned — that way a Notion page switched
 * to dark mode takes the widget with it.
 * @param {'light'|'dark'|null} choice
 * @param {boolean} [remember]
 */
function setTheme(choice, remember = false) {
  if (choice) document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;

  if (remember) {
    try {
      if (choice) localStorage.setItem(CONFIG.themeKey, choice);
      else localStorage.removeItem(CONFIG.themeKey);
    } catch { /* session-only */ }
  }

  const active = choice || systemTheme();
  el.themeLight.setAttribute('aria-pressed', String(active === 'light'));
  el.themeDark.setAttribute('aria-pressed', String(active === 'dark'));
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(CONFIG.themeKey); } catch { /* ignore */ }
  const fromHash = hash.get('theme');
  const choice = ['light', 'dark'].includes(saved) ? saved
    : ['light', 'dark'].includes(fromHash) ? fromHash
    : null;
  setTheme(choice);

  // Keep the pressed state honest while following the system.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (!document.documentElement.dataset.theme) setTheme(null);
    });
}

/** Clicking the active half returns to following the system. */
function toggleTheme(choice) {
  const current = document.documentElement.dataset.theme || null;
  setTheme(current === choice ? null : choice, true);
}


/* ==========================================================================
   6. Helpers: time, text, status line
   ========================================================================== */

const pad = (n) => String(n).padStart(2, '0');

/**
 * Local time as ISO 8601 with offset, e.g. 2026-11-16T09:42:05-08:00.
 * Notion stores the instant correctly and shows it in your time zone.
 * @param {Date} d
 */
function localISO(d) {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** @param {Date} d  → "9:42 AM" */
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** @param {number} ms → "1:05:09" */
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * A day plus 12-hour pieces → a local Date, or null until every piece is set.
 * 12 AM is midnight and 12 PM is noon.
 * @param {string} day  YYYY-MM-DD
 * @param {ClockTime} t
 */
function toDate(day, t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !t.h || !t.m || !t.p) return null;
  const [y, mo, d] = day.split('-').map(Number);
  const hour = (Number(t.h) % 12) + (t.p === 'PM' ? 12 : 0);
  return new Date(y, mo - 1, d, hour, Number(t.m));
}

/** Manual entry's Start and End as Dates (null while incomplete). */
const manualRange = () => ({
  s: toDate(state.mDate, state.mTime.start),
  e: toDate(state.mDate, state.mTime.end),
});

/** "1 h 30 min", "45 min" */
function fmtMinutes(ms) {
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  return h ? `${h} h ${total % 60} min` : `${total} min`;
}

/**
 * What still stops Manual mode from logging: '' when the date and both times
 * are set and make sense. End must follow Start on the same day, and can't
 * be in the future since the work has to have happened.
 */
function manualProblem() {
  const { s, e } = manualRange();
  const missing = [];
  if (!state.mDate) missing.push('Date');
  if (!s) missing.push('Start Time');
  if (!e) missing.push('End Time');
  if (missing.length) return `Set ${joinList(missing)} to log.`;
  if (e <= s) return 'End Time must be after Start Time.';
  if (e > new Date()) return 'End Time can’t be in the future.';
  return '';
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** ["a","b","c"] → "a, b and c" */
function joinList(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** @param {string} message  @param {''|'error'} [tone] */
function setSync(message, tone = '') {
  el.sync.textContent = message;
  el.sync.dataset.tone = tone;
}

const fail = (err) => setSync(err.message, 'error');


/* ==========================================================================
   7. API client (talks to worker.js only)
   ========================================================================== */

/**
 * Call the Worker. Throws an Error whose message is safe to show the user.
 * @param {string} path
 * @param {{method?:string, json?:object, form?:FormData, signal?:AbortSignal}} [opts]
 */
async function api(path, { method = 'GET', json, form, signal } = {}) {
  if (!CONFIG.api || !CONFIG.key) {
    throw new Error('The embed URL needs #api=… and key=…. See README step 5.');
  }

  const headers = { 'X-Widget-Key': CONFIG.key };
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;   // the browser sets the multipart boundary itself
  }

  let res;
  try {
    res = await fetch(CONFIG.api + path, { method, headers, body, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Could not reach the Worker. Check the api URL and your connection.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}


/* ==========================================================================
   8. Dropdown options
   ========================================================================== */

/** Fill a <select> from a list of names, keeping the current pick visible. */
function fillSelect(key, items, placeholder, emptyLabel = 'No entries found') {
  const select = el.selects[key];
  select.replaceChildren(
    new Option(items.length ? placeholder : emptyLabel, ''),
    ...items.map((item) => new Option(item.name, item.id)),
  );

  const picked = state.picks[key];
  if (picked && !items.some((item) => item.id === picked)) {
    select.append(new Option('(not in current list)', picked));
  }
  select.value = picked;
}

/** Stage and Category never change; they're local lists. */
function fillLocalSelects() {
  fillSelect('stage', STAGES.map((name) => ({ id: name, name })), 'Choose…');
  fillSelect('category', CATEGORIES.map((name) => ({ id: name, name })), 'Choose…');
}

/** Manual mode's hour (01–12) and minute (00–59) lists. */
function fillTimeSelects() {
  const hours = Array.from({ length: 12 }, (_, i) => pad(i + 1));
  const minutes = Array.from({ length: 60 }, (_, i) => pad(i));
  for (const when of ['start', 'end']) {
    el.mSelects[when].h.replaceChildren(new Option('HH', ''), ...hours.map((v) => new Option(v, v)));
    el.mSelects[when].m.replaceChildren(new Option('MM', ''), ...minutes.map((v) => new Option(v, v)));
  }
}

/**
 * Show or hide the third Classifiers cell and fill it for the chosen
 * category. Called on every render so it survives reloads.
 */
function renderSubtype() {
  const category = state.picks.category;
  const list = subtypesFor(category);

  el.subtypeField.hidden = !list;
  if (!list) return;

  el.subtypeLabel.textContent = category;
  fillSelect('subtype', list.map((name) => ({ id: name, name })), 'Choose…');
}

/**
 * Where the last attempt to fetch the Notion lists stands. The pickers use it
 * so an empty list says why: still loading, failed, or genuinely empty.
 */
let listsStatus = 'loading';   // 'loading' | 'ok' | 'error'

/** Show cached lists instantly (the pickers start from them), then refresh. */
async function loadOptions() {
  listsStatus = 'loading';

  el.reload.disabled = true;
  setSync('Loading lists…');
  try {
    options = await api('/options');
    writeJSON(CONFIG.optionsKey, options);
    listsStatus = 'ok';
    for (const key of COMBO_KEYS) combos[key].setRecent(options[key] || []);
    setSync('Lists up to date');
  } catch (err) {
    listsStatus = 'error';
    fail(err);
  } finally {
    el.reload.disabled = false;
    for (const key of COMBO_KEYS) combos[key].refresh();
    render();
  }
}


/* ==========================================================================
   9. Type-ahead pickers (Primary, Secondary, Tertiary, Task, Meeting, Requests)
   ========================================================================== */

/**
 * Rank a page name against what's typed. Lower is better:
 *   0 starts with it · 1 a word starts with it · 2 contains it
 *   3 letters appear in order · Infinity no match
 * @param {string} name @param {string} query
 */
function matchScore(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  const at = n.indexOf(q);
  if (at === 0) return 0;
  if (at > 0) return /[\s\-_/([]/.test(n[at - 1]) ? 1 : 2;

  let pos = -1;
  for (const ch of q) {
    pos = n.indexOf(ch, pos + 1);
    if (pos < 0) return Infinity;
  }
  return 3;
}

/**
 * A type-ahead picker over one Notion database.
 *
 * Empty input lists the most recently added pages. Typing ranks those
 * locally and, after a short pause, also asks the Worker to search the whole
 * database by title so older pages are reachable.
 *
 * @param {'primary'|'secondary'|'tertiary'|'task'|'meeting'|'request'} key
 */
function createCombo(key) {
  const input = $(key);
  const list = $(`${key}-list`);
  const status = $(`${key}-state`);

  let recent = Array.isArray(options[key]) ? options[key] : [];
  let found = [];            // extra pages returned by the Worker's search
  let shown = [];            // what's currently in the list, in order
  let active = -1;           // index into shown
  let searchTimer = null;
  let searchJob = null;      // AbortController for the in-flight search

  /** @returns {PageRef[]} best matches for the current input */
  function candidates() {
    const query = input.value.trim();
    const pool = [...recent];
    for (const page of found) {
      if (!pool.some((p) => p.id === page.id)) pool.push(page);
    }
    if (!query) return pool.slice(0, 25);

    return pool
      .map((page, index) => ({ page, score: matchScore(page.name, query), index }))
      .filter((hit) => hit.score < Infinity)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .slice(0, 25)
      .map((hit) => hit.page);
  }

  function open() {
    if (input.disabled) return;
    shown = candidates();
    active = shown.length ? 0 : -1;      // the closest match is pre-selected

    list.replaceChildren(...(shown.length ? shown.map((page, index) => {
      const li = document.createElement('li');
      li.id = `${key}-opt-${index}`;
      li.setAttribute('role', 'option');
      li.textContent = page.name;
      li.setAttribute('aria-selected', String(index === active));
      li.addEventListener('mousedown', (event) => {   // beats blur
        event.preventDefault();
        choose(page);
      });
      return li;
    }) : [emptyItem()]));

    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `${key}-opt-${active}` : '');
  }

  function emptyItem() {
    const li = document.createElement('li');
    li.className = 'is-empty';
    // An empty list means different things: say which.
    li.textContent = recent.length ? 'No match'
      : listsStatus === 'loading' ? 'Loading…'
      : listsStatus === 'error' ? 'Couldn’t load. See the message below.'
      : 'No pages found';
    return li;
  }

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  /** @param {number} delta */
  function move(delta) {
    if (list.hidden) return open();
    if (!shown.length) return;
    active = (active + delta + shown.length) % shown.length;
    [...list.children].forEach((li, index) => li.setAttribute('aria-selected', String(index === active)));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `${key}-opt-${active}`);
  }

  /** @param {PageRef} page */
  function choose(page) {
    state.links[key] = { id: page.id, name: page.name };
    input.value = page.name;
    save();
    close();
    render();
  }

  function clear() {
    if (!state.links[key]) return;
    state.links[key] = null;
    save();
    render();
  }

  /** Ask the Worker to search the whole database, so old pages are findable. */
  function queueSearch() {
    clearTimeout(searchTimer);
    const query = input.value.trim();
    if (query.length < 2) return;

    searchTimer = setTimeout(async () => {
      searchJob?.abort();
      searchJob = new AbortController();
      try {
        const res = await api(
          `/search?source=${key}&q=${encodeURIComponent(query)}`,
          { signal: searchJob.signal },
        );
        found = res.results || [];
        if (document.activeElement === input) open();
      } catch (err) {
        if (err.name !== 'AbortError') fail(err);
      }
    }, CONFIG.searchMs);
  }

  let focused = false;       // the warning waits until you leave the field

  input.addEventListener('focus', () => { focused = true; render(); open(); });
  input.addEventListener('click', open);

  input.addEventListener('input', () => {
    clear();                       // typing unpicks whatever was linked
    open();
    queueSearch();
  });

  input.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); move(1); break;
      case 'ArrowUp':   event.preventDefault(); move(-1); break;
      case 'Enter':
        if (!list.hidden && active >= 0 && shown[active]) {
          event.preventDefault();
          choose(shown[active]);
        }
        break;
      case 'Escape':
        if (!list.hidden) { event.preventDefault(); close(); }
        break;
      case 'Tab': close(); break;
    }
  });

  input.addEventListener('blur', () => {
    focused = false;
    close();
    // Free text that was never picked isn't a link; show the chosen name back.
    const picked = state.links[key];
    if (picked && input.value !== picked.name) input.value = picked.name;
    else if (!picked) render();    // warns if text is left unlinked, resets if emptied
  });

  return {
    /** @param {PageRef[]} pages */
    setRecent(pages) {
      recent = Array.isArray(pages) ? pages : [];
    },
    /** Redraw the list if it's open, e.g. when the lists finish loading. */
    refresh() {
      if (!list.hidden) open();
    },
    /** Push state into the input and its status line. */
    sync() {
      const picked = state.links[key];
      if (picked) input.value = picked.name;     // free text is left as typed
      input.disabled = busy || Boolean(state.pageId);
      input.classList.toggle('is-picked', Boolean(picked));

      // The line below names the source database. A chosen page shows as the
      // input's own text and green outline, so it only changes to a warning
      // when typed text isn't a link yet.
      const unlinked = !picked && !focused && Boolean(input.value.trim());
      const text = unlinked ? 'Not linked. Choose a page from the list.' : status.dataset.db;
      if (status.textContent !== text) status.textContent = text;   // don't re-announce
      status.dataset.warn = String(unlinked);
    },
    reset() {
      input.value = '';
      found = [];
      close();
    },
  };
}

/** @type {Record<string, ReturnType<typeof createCombo>>} */
const combos = Object.fromEntries(COMBO_KEYS.map((k) => [k, createCombo(k)]));


/* ==========================================================================
   10. Rendering
   ========================================================================== */

/** Keys that must be filled right now, including subtype when it's showing. */
function requiredNow() {
  const keys = [...REQUIRED_KEYS];
  if (subtypesFor(state.picks.category)) keys.push('subtype');
  return keys;
}

/** Whether a required field has a real choice: a picked page or an option. */
const isFilled = (key) =>
  COMBO_KEYS.includes(key) ? Boolean(state.links[key]?.id) : Boolean(state.picks[key]);

const isComplete = () => Boolean(state.title.trim()) && requiredNow().every(isFilled);

/** "Add a title and choose Stage and Task to continue." */
function missingHint() {
  const parts = [];
  if (!state.title.trim()) parts.push('add a title');
  const unpicked = requiredNow().filter((k) => !isFilled(k))
    .map((k) => (k === 'subtype' ? state.picks.category : LABELS[k]));
  if (unpicked.length) parts.push(`choose ${joinList(unpicked)}`);
  const text = parts.join(' and ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} to continue.`;
}

/** Push state into the form controls (used on load, New, and cross-tab sync). */
function applyStateToForm() {
  el.title.value = state.title;
  el.jira.value = state.jira;
  for (const key of TEXT_KEYS) el[key].value = state[key];
  for (const key of COMBO_KEYS) $(key).value = state.links[key]?.name || '';
  renderSubtype();
  for (const key of SELECT_KEYS) el.selects[key].value = state.picks[key];

  el.mDate.value = state.mDate;
  for (const when of ['start', 'end']) {
    el.mSelects[when].h.value = state.mTime[when].h;
    el.mSelects[when].m.value = state.mTime[when].m;
  }
}

/** Recompute every derived bit of UI from state. */
function render() {
  renderSubtype();
  el.selects.subtype.value = state.picks.subtype;

  const complete = isComplete();
  const hasEntry = Boolean(state.pageId);
  const running = hasEntry && !state.stop;

  el.root.dataset.state = running ? 'running' : hasEntry ? 'stopped' : 'idle';

  // Manual mode swaps Start and Stop for Log and reveals the time pickers.
  const manual = state.manual;
  const problem = manual ? manualProblem() : '';
  el.start.hidden = manual;
  el.stop.hidden = manual;
  el.log.hidden = !manual;
  el.manualPanel.hidden = !manual;
  el.manual.setAttribute('aria-pressed', String(manual));

  // Buttons: all require a complete form (per spec), plus their own rule.
  el.start.disabled = busy || !complete || hasEntry;
  el.stop.disabled = busy || !complete || !running;
  el.log.disabled = busy || !complete || Boolean(problem) || hasEntry;
  el.newBtn.disabled = busy || !complete;
  el.manual.disabled = busy || hasEntry;      // press New first to switch modes

  // Manual time controls lock once the entry exists, like the classifiers.
  const timeLocked = busy || hasEntry;
  el.mDate.disabled = timeLocked;
  for (const when of ['start', 'end']) {
    el.mSelects[when].h.disabled = timeLocked;
    el.mSelects[when].m.disabled = timeLocked;
  }
  for (const btn of el.periodBtns) {
    btn.disabled = timeLocked;
    btn.setAttribute('aria-pressed', String(state.mTime[btn.dataset.when].p === btn.dataset.period));
  }
  const { s, e } = manualRange();
  el.mDuration.textContent = manual && s && e && e > s ? `Duration: ${fmtMinutes(e - s)}` : '';

  // After Start, the classification is fixed so the widget can't drift away
  // from the Notion entry it created.
  el.title.readOnly = hasEntry;
  el.jira.disabled = busy || hasEntry;
  for (const key of SELECT_KEYS) el.selects[key].disabled = busy || hasEntry;
  for (const key of COMBO_KEYS) combos[key].sync();

  // Attachments need an entry to attach to.
  for (const key of FILE_KEYS) {
    const zone = el.zones[key];
    zone.input.disabled = busy || !hasEntry;
    zone.drop.classList.toggle('is-disabled', zone.input.disabled);
    zone.text.textContent = hasEntry
      ? `Drop ${FILE_FIELDS[key].noun}s here or browse`
      : `Start an entry to attach ${FILE_FIELDS[key].noun}s`;
  }

  el.hint.textContent =
    !complete ? missingHint()
    : manual && !hasEntry ? (problem || 'Ready to log.')
    : manual ? 'Logged. Add a description, output or files, then press New.'
    : running ? 'Logging. Press Stop when you finish.'
    : hasEntry ? 'Stopped. Add a description, output or files, then press New.'
    : 'Ready to start.';

  renderClock();
  renderFiles();
}

/** Status text and elapsed time. Runs every second. */
function renderClock() {
  if (!state.start) {
    // Manual mode previews the duration while the pickers are being set.
    const { s, e } = manualRange();
    const preview = state.manual && s && e && e > s;
    el.clockState.textContent = preview ? 'Manual entry' : 'Not started';
    el.clockTime.textContent = preview ? fmtDuration(e - s) : '0:00:00';
    return;
  }
  const started = new Date(state.start);
  const ended = state.stop ? new Date(state.stop) : new Date();
  const label = state.stop ? `Stopped at ${fmtTime(ended)}` : `Started at ${fmtTime(started)}`;

  // Only touch the live region when its text actually changes.
  if (el.clockState.textContent !== label) el.clockState.textContent = label;
  el.clockTime.textContent = fmtDuration(ended - started);
}

function renderFiles() {
  for (const key of FILE_KEYS) {
    el.zones[key].list.replaceChildren(...state[key].map((file, index) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = file.name;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link-btn';
      remove.textContent = 'Remove';
      remove.disabled = busy;
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.addEventListener('click', () => removeFile(key, index));

      li.append(name, remove);
      return li;
    }));
  }
}


/* ==========================================================================
   11. Actions: Start, Stop, New
   ========================================================================== */

/** The create call's body; Start and Stop are added by the caller. */
const entryPayload = (startISO) => ({
  title: state.title.trim(),
  date: startISO.slice(0, 10),                       // Date: day only
  start: startISO,                                   // Start: day + time
  stage: state.picks.stage,
  category: state.picks.category,
  subtype: state.picks.subtype,                      // '' when Support
  // Page ids of every picked link; '' for an optional one left empty.
  relations: Object.fromEntries(COMBO_KEYS.map((k) => [k, state.links[k]?.id || ''])),
  jira: state.jira.trim(),
  ...textPayload(),                                  // include anything typed early
});

/** Create the Work Log entry. */
async function startEntry() {
  if (el.start.disabled) return;
  busy = true;
  render();
  setSync('Creating entry…');

  const startedAt = localISO(new Date());
  try {
    const { id } = await api('/entries', { method: 'POST', json: entryPayload(startedAt) });
    Object.assign(state, { pageId: id, start: startedAt, stop: null, files: [], pipelineFiles: [] });
    save();
    setSync('Entry created in Work Log');
  } catch (err) {
    fail(err);
  } finally {
    busy = false;
    render();
  }
}

/** Manual mode: create a finished entry with both times from the pickers. */
async function logEntry() {
  if (el.log.disabled) return;
  const { s, e } = manualRange();
  const startISO = localISO(s);
  const stopISO = localISO(e);

  busy = true;
  render();
  setSync('Logging entry…');

  try {
    const { id } = await api('/entries', {
      method: 'POST',
      json: { ...entryPayload(startISO), stop: stopISO },
    });
    Object.assign(state, { pageId: id, start: startISO, stop: stopISO, files: [], pipelineFiles: [] });
    save();
    setSync(`Logged ${fmtMinutes(e - s)} in Work Log`);
  } catch (err) {
    fail(err);
  } finally {
    busy = false;
    render();
  }
}

/** Write the Stop time (and flush any unsaved notes). */
async function stopEntry() {
  if (el.stop.disabled) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  busy = true;
  render();
  setSync('Stopping…');

  const stoppedAt = localISO(new Date());
  try {
    await api(`/entries/${state.pageId}`, {
      method: 'PATCH',
      json: { stop: stoppedAt, ...textPayload() },
    });
    state.stop = stoppedAt;
    save();
    setSync(`Stopped at ${fmtTime(new Date(stoppedAt))}`);
  } catch (err) {
    fail(err);
  } finally {
    busy = false;
    render();
  }
}

/**
 * Clear the widget for a new entry. The Notion entry is left as is.
 * If the entry is still running, the first press asks for confirmation.
 */
async function newEntry() {
  if (el.newBtn.disabled) return;

  const running = state.pageId && !state.stop;
  if (running && !confirmTimer) {
    el.newBtn.textContent = 'Clear anyway?';
    setSync('This entry has no Stop time yet. Press again to clear the widget anyway.');
    confirmTimer = setTimeout(resetNewButton, 4000);
    return;
  }
  resetNewButton();

  if (saveTimer) await saveNotes();   // don't lose the last few keystrokes

  // Manual mode and its day carry over, so a run of manual entries for the
  // same day only needs the times changed. The times themselves are cleared.
  const { manual, mDate } = state;
  state = emptyState();
  Object.assign(state, { manual, mDate });
  save();
  for (const key of COMBO_KEYS) combos[key].reset();
  applyStateToForm();
  setSync('Cleared. The Work Log entry is unchanged.');
  render();
}

function resetNewButton() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  el.newBtn.textContent = 'New';
}


/* ==========================================================================
   12. Text autosave (Description, Output, Pipeline Link, Packages, Platform)
   ========================================================================== */

/** The text fields as the Worker expects them. */
const textPayload = () => Object.fromEntries(TEXT_KEYS.map((k) => [k, state[k]]));

/** Debounce: save shortly after typing stops. */
function queueNotesSave() {
  if (!state.pageId) return;           // nothing to save to yet; Start sends it
  clearTimeout(saveTimer);
  setSync('Unsaved changes');
  saveTimer = setTimeout(saveNotes, CONFIG.autosaveMs);
}

async function saveNotes() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const pageId = state.pageId;
  if (!pageId) return;

  setSync('Saving…');
  try {
    await api(`/entries/${pageId}`, { method: 'PATCH', json: textPayload() });
    if (state.pageId === pageId) setSync(`Saved at ${fmtTime(new Date())}`);
  } catch (err) {
    fail(err);
  }
}


/* ==========================================================================
   13. Files
   ========================================================================== */

/**
 * Upload each file, then set the zone's Files property to the full list.
 * Notion replaces the whole Files value on update, so the widget always
 * sends every file it has attached to this entry in that zone.
 * @param {'files'|'pipelineFiles'} key  which zone
 * @param {FileList|File[]} fileList
 */
async function attachFiles(key, fileList) {
  const { prop, noun } = FILE_FIELDS[key];
  const pageId = state.pageId;
  const files = [...fileList];            // copy before the input is reset
  if (!pageId || busy || !files.length) return;

  busy = true;
  render();
  const skipped = [];

  try {
    for (const file of files) {
      if (file.size > CONFIG.maxFileBytes) {
        skipped.push(file.name);
        continue;
      }
      setSync(`Uploading ${file.name}…`);
      const form = new FormData();
      form.append('file', file, file.name);
      const upload = await api('/uploads', { method: 'POST', form });

      const next = [...state[key], { id: upload.id, name: file.name }];
      await api(`/entries/${pageId}`, { method: 'PATCH', json: { [prop]: next } });
      state[key] = next;
      save();
      renderFiles();
    }
    if (skipped.length) setSync(`Over 20 MB, not attached: ${skipped.join(', ')}`, 'error');
    else setSync(`${capitalize(noun)}${files.length > 1 ? 's' : ''} attached`);
  } catch (err) {
    fail(err);
  } finally {
    busy = false;
    el.zones[key].input.value = '';
    render();
  }
}

/**
 * @param {'files'|'pipelineFiles'} key  which zone
 * @param {number} index  position in that zone's list
 */
async function removeFile(key, index) {
  if (busy || !state.pageId) return;
  const { prop, noun } = FILE_FIELDS[key];
  busy = true;
  render();
  setSync(`Removing ${noun}…`);

  const next = state[key].filter((_, i) => i !== index);
  try {
    await api(`/entries/${state.pageId}`, { method: 'PATCH', json: { [prop]: next } });
    state[key] = next;
    save();
    setSync(`${capitalize(noun)} removed`);
  } catch (err) {
    fail(err);
  } finally {
    busy = false;
    render();
  }
}


/* ==========================================================================
   14. Events
   ========================================================================== */

el.title.addEventListener('input', () => {
  state.title = el.title.value;
  save();
  render();
});

for (const key of SELECT_KEYS) {
  el.selects[key].addEventListener('change', (event) => {
    state.picks[key] = event.target.value;
    // A new category brings its own second level, so the old one is void.
    if (key === 'category') state.picks.subtype = '';
    save();
    render();
  });
}

el.jira.addEventListener('input', () => {
  state.jira = el.jira.value;
  save();
});

for (const key of TEXT_KEYS) {
  el[key].addEventListener('input', () => {
    state[key] = el[key].value;
    save();
    queueNotesSave();
  });
  el[key].addEventListener('blur', () => { if (saveTimer) saveNotes(); });
}

// Manual mode: the toggle, the day, and each hour / minute / AM-PM piece.
el.manual.addEventListener('click', () => {
  if (el.manual.disabled) return;
  state.manual = !state.manual;
  if (state.manual && !state.mDate) state.mDate = localISO(new Date()).slice(0, 10);
  save();
  applyStateToForm();
  render();
});

el.mDate.addEventListener('input', () => {
  state.mDate = el.mDate.value;
  save();
  render();
});

for (const when of ['start', 'end']) {
  for (const part of ['h', 'm']) {
    el.mSelects[when][part].addEventListener('change', (event) => {
      state.mTime[when][part] = event.target.value;
      save();
      render();
    });
  }
}

for (const btn of el.periodBtns) {
  btn.addEventListener('click', () => {
    state.mTime[btn.dataset.when].p = btn.dataset.period;
    save();
    render();
  });
}

el.start.addEventListener('click', startEntry);
el.stop.addEventListener('click', stopEntry);
el.log.addEventListener('click', logEntry);
el.newBtn.addEventListener('click', newEntry);
el.reload.addEventListener('click', loadOptions);
el.themeLight.addEventListener('click', () => toggleTheme('light'));
el.themeDark.addEventListener('click', () => toggleTheme('dark'));

// Browse and drag-and-drop, for each attachment zone.
for (const key of FILE_KEYS) {
  const { input, drop } = el.zones[key];

  input.addEventListener('change', () => attachFiles(key, input.files));

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => {
      if (input.disabled) return;
      event.preventDefault();
      drop.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('is-over'));
  }
  drop.addEventListener('drop', (event) => {
    if (input.disabled) return;
    event.preventDefault();
    attachFiles(key, event.dataTransfer.files);
  });
}

// A file dropped anywhere else shouldn't navigate the iframe away.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

// Keep two copies of the widget (two tabs, or the same embed twice) in step.
window.addEventListener('storage', (event) => {
  if (event.key !== CONFIG.storageKey) return;
  state = loadState();
  applyStateToForm();
  render();
});


/* ==========================================================================
   15. Init
   ========================================================================== */

initTheme();
fillLocalSelects();
fillTimeSelects();
for (const key of COMBO_KEYS) combos[key].setRecent(options[key] || []);
applyStateToForm();
render();
loadOptions();
setInterval(renderClock, 1000);
