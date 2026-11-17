/**
 * @file worker.js · Cloudflare Worker that connects the widget to Notion.
 *
 * Why this exists
 * ---------------
 * The Notion API can't be called from a web page: it blocks browser (CORS)
 * requests, and the integration token would be exposed. This Worker holds
 * the token, checks a shared widget key, and forwards a small, fixed set of
 * operations. It is one file with no dependencies and runs on the free plan.
 *
 * Environment (Worker → Settings → Variables and Secrets)
 * -------------------------------------------------------
 *   NOTION_TOKEN    Secret   Internal integration token (starts with ntn_)
 *   WIDGET_KEY      Secret   Any long random string; also goes in the embed URL
 *   ALLOWED_ORIGIN  Text     Your GitHub Pages origin, e.g. https://you.github.io
 *
 * Routes
 * ------
 *   GET   /options                 Names for the dropdowns and pickers
 *   GET   /search?source=&q=       Title search in MeetingDb or RequestsDb
 *   POST  /entries                 Create a Work Log entry (Start)
 *   PATCH /entries/:id             Update Stop, Description, Output, Files
 *   POST  /uploads                 Upload one file; returns its file_upload id
 */


/* ==========================================================================
   1. Configuration · edit this block
   ========================================================================== */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** Database IDs: the 32-character code in each database's URL, before "?v=". */
const WORK_LOG_DB = 'PASTE_WORK_LOG_DATABASE_ID';

/**
 * Long-Term and Short-Term Goals only offer pages whose "Category" select is
 * "Research". The property in those databases must be a Select named exactly
 * "Category". The filter applies to both the recent list and the title search.
 */
const RESEARCH_ONLY = { property: 'Category', select: { equals: 'Research' } };

/**
 * One entry per linked field. Keys match COMBO_KEYS in app.js.
 *   database  where the names come from
 *   relation  the Work Log relation property it fills
 *   required  whether Start refuses without it
 *   recent    true  → newest pages first, and searchable by title. Every
 *                     field in the widget is a type-ahead picker, so keep
 *                     this true.
 *             false → the whole database sorted by name. Only useful if a
 *                     field is ever turned back into a plain dropdown; such
 *                     a field can't be searched.
 *   filter    optional Notion filter to shorten the list, for example
 *             { property: 'Status', status: { does_not_equal: 'Done' } }
 */
const SOURCES = {
  primary:   { database: 'PASTE_LONG_TERM_GOALS_DATABASE_ID',  relation: 'Long-Term Goals',  required: true,  recent: true,  filter: RESEARCH_ONLY },
  secondary: { database: 'PASTE_SHORT_TERM_GOALS_DATABASE_ID', relation: 'Short-Term Goals', required: true,  recent: true,  filter: RESEARCH_ONLY },
  tertiary:  { database: 'PASTE_MILESTONES_DATABASE_ID',       relation: 'Milestones',       required: true,  recent: true,  filter: null },
  task:      { database: 'PASTE_TASKS_DATABASE_ID',            relation: 'Tasks',            required: true,  recent: true,  filter: null },
  meeting:   { database: 'PASTE_MEETING_DB_DATABASE_ID',       relation: 'Meeting',          required: false, recent: true,  filter: null },
  request:   { database: 'PASTE_REQUESTS_DB_DATABASE_ID',      relation: 'Requests',         required: false, recent: true,  filter: null },
};

/** Work Log property names. Change the right-hand side if yours differ. */
const PROPS = {
  name: 'Name',               // title
  date: 'Date',               // date (day only)
  start: 'Start',             // date (with time)
  stop: 'Stop',               // date (with time)
  stage: 'Stage',             // select
  category: 'Category',       // select
  type: 'Type',               // select · the second level under Category
  jira: 'JIRA',               // url
  description: 'Description', // text
  output: 'Output',           // text
  files: 'Files',             // files & media
  pipelineLink: 'Pipeline Link',  // url
  pipelineFile: 'Pipeline File',  // files & media
  packages: 'Packages',       // text now; switch to a select later (see createEntry)
  platform: 'Platform',       // text now; switch to a select later (see createEntry)
};

const STAGES = new Set(['Planning', 'Execution', 'Assessment', 'Finalize']);

/**
 * Category → its own second-level options, mirroring SUBTYPES in app.js.
 * A category mapped to null (Support) takes no Type.
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

/**
 * Turns a bare ticket key into a link. Leave blank to store whatever the
 * widget sends as-is.  e.g. 'https://alleninstitute.atlassian.net/browse/'
 */
const JIRA_BASE_URL = '';

/** How many recent pages the pickers start with before any typing. */
const RECENT_LIMIT = 100;

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;


/* ==========================================================================
   2. Router
   ========================================================================== */

export default {
  /**
   * @param {Request} request
   * @param {{NOTION_TOKEN:string, WIDGET_KEY:string, ALLOWED_ORIGIN?:string}} env
   */
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      assertConfigured(env);
      assertAuthorized(request, env);

      const url = new URL(request.url);
      const entry = url.pathname.match(/^\/entries\/([0-9a-fA-F-]{32,36})$/);
      let result;

      if (request.method === 'GET' && url.pathname === '/options') {
        result = await listOptions(env);
      } else if (request.method === 'GET' && url.pathname === '/search') {
        result = await searchSource(env, url.searchParams.get('source'), url.searchParams.get('q'));
      } else if (request.method === 'POST' && url.pathname === '/entries') {
        result = await createEntry(env, await readBody(request));
      } else if (request.method === 'PATCH' && entry) {
        result = await updateEntry(env, entry[1], await readBody(request));
      } else if (request.method === 'POST' && url.pathname === '/uploads') {
        result = await uploadFile(env, request);
      } else {
        throw new HttpError(404, 'Not found.');
      }

      return json(result, 200, cors);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || 'Unexpected error.' }, status, cors);
    }
  },
};


/* ==========================================================================
   3. Handlers
   ========================================================================== */

/** GET /options → { primary: [{id, name}], …, meeting: […], request: […] } */
async function listOptions(env) {
  const entries = Object.entries(SOURCES);

  // allSettled, not all: one bad database shouldn't hide the others, and the
  // error should name every dropdown that failed so they can be fixed in one pass.
  const settled = await Promise.allSettled(
    entries.map(([, source]) => (source.recent
      ? queryRecent(env, source.database, source.filter)
      : queryAll(env, source.database, source.filter))),
  );

  const failures = [];
  const lists = settled.map((result, i) => {
    const [key, source] = entries[i];
    if (result.status === 'fulfilled') return [key, result.value];
    failures.push({ source, error: result.reason });
    return [key, []];
  });

  if (failures.length) {
    const lines = failures.map(({ source, error }) => {
      const idStart = normalizeId(source.database).slice(0, 8);
      return error.status === 404
        ? `${source.relation}: not found, or not shared with the integration (ID starts ${idStart})`
        : `${source.relation}: ${error.message}`;
    });
    throw new HttpError(failures[0].error.status || 500, lines.join(' | '));
  }
  return Object.fromEntries(lists);
}

/**
 * GET /search?source=meeting&q=kickoff → { results: [{id, name}] }
 * Searches the whole database by title, so pages older than the recent
 * list stay reachable from the pickers.
 */
async function searchSource(env, key, query) {
  const source = SOURCES[key];
  if (!source || !source.recent) throw new HttpError(400, 'Unknown search source.');

  const q = asString(query).trim();
  if (q.length < 2) return { results: [] };

  const titleProp = await titlePropertyName(env, source.database);
  const titleFilter = { property: titleProp, title: { contains: q } };

  const res = await notion(env, 'POST', `/databases/${source.database}/query`, {
    page_size: 20,
    filter: source.filter ? { and: [source.filter, titleFilter] } : titleFilter,
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  });

  return { results: res.results.map((page) => ({ id: page.id, name: titleOf(page) })) };
}

/** POST /entries → { id, url } */
async function createEntry(env, body) {
  const title = asString(body.title).trim();
  if (!title) throw new HttpError(400, 'Add a title.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asString(body.date))) throw new HttpError(400, 'Date is missing or malformed.');
  if (!isTimestamp(body.start)) throw new HttpError(400, 'Start time is missing or malformed.');
  if (!STAGES.has(body.stage)) throw new HttpError(400, `Unknown stage "${body.stage}".`);
  if (!(body.category in SUBTYPES)) throw new HttpError(400, `Unknown category "${body.category}".`);

  // The second level is required exactly when the category defines one.
  const allowed = SUBTYPES[body.category];
  const subtype = asString(body.subtype);
  if (allowed && !allowed.includes(subtype)) throw new HttpError(400, `Choose a type for ${body.category}.`);
  if (!allowed && subtype) throw new HttpError(400, `${body.category} takes no type.`);

  const properties = {
    [PROPS.name]: { title: [{ type: 'text', text: { content: title.slice(0, 2000) } }] },
    [PROPS.date]: { date: { start: body.date } },
    [PROPS.start]: { date: { start: body.start } },
    [PROPS.stage]: { select: { name: body.stage } },
    [PROPS.category]: { select: { name: body.category } },
    [PROPS.type]: { select: subtype ? { name: subtype } : null },
    [PROPS.jira]: { url: jiraUrl(body.jira) },
    [PROPS.description]: richText(body.description),
    [PROPS.output]: richText(body.output),
    [PROPS.pipelineLink]: { url: webUrl(body.pipelineLink) },
    // Packages and Platform are plain text for now. When they become selects,
    // swap each line for:  { select: body.packages ? { name: body.packages } : null }
    [PROPS.packages]: richText(body.packages),
    [PROPS.platform]: richText(body.platform),
  };

  for (const [key, source] of Object.entries(SOURCES)) {
    const id = body.relations?.[key];
    if (!id) {
      if (source.required) throw new HttpError(400, `Choose an entry for ${key}.`);
      continue;                                   // optional link left empty
    }
    if (!isNotionId(id)) throw new HttpError(400, `The ${key} selection is malformed.`);
    properties[source.relation] = { relation: [{ id }] };
  }

  const page = await notion(env, 'POST', '/pages', {
    parent: { database_id: WORK_LOG_DB },
    properties,
  });
  return { id: page.id, url: page.url };
}

/**
 * PATCH /entries/:id with any of
 * { stop, description, output, pipelineLink, packages, platform, files, pipelineFiles }
 */
async function updateEntry(env, pageId, body) {
  const properties = {};

  if (body.stop !== undefined) {
    if (!isTimestamp(body.stop)) throw new HttpError(400, 'Stop time is malformed.');
    properties[PROPS.stop] = { date: { start: body.stop } };
  }
  if (typeof body.description === 'string') properties[PROPS.description] = richText(body.description);
  if (typeof body.output === 'string') properties[PROPS.output] = richText(body.output);
  if (typeof body.pipelineLink === 'string') properties[PROPS.pipelineLink] = { url: webUrl(body.pipelineLink) };
  if (typeof body.packages === 'string') properties[PROPS.packages] = richText(body.packages);
  if (typeof body.platform === 'string') properties[PROPS.platform] = richText(body.platform);

  // Each attachment zone writes its whole list to its own Files property.
  if (body.files !== undefined) properties[PROPS.files] = fileList(body.files, 'Files');
  if (body.pipelineFiles !== undefined) properties[PROPS.pipelineFile] = fileList(body.pipelineFiles, 'Pipeline File');

  if (!Object.keys(properties).length) throw new HttpError(400, 'Nothing to update.');

  await assertWorkLogPage(env, pageId);
  await notion(env, 'PATCH', `/pages/${pageId}`, { properties });
  return { ok: true };
}

/**
 * POST /uploads (multipart, field "file") → { id, name }
 * Notion's direct upload is two steps: create the upload, then send bytes.
 * The id is attached to the entry by a following PATCH /entries/:id.
 */
async function uploadFile(env, request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'Send the file in a "file" form field.');
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, `${file.name} is over 20 MB.`);

  const created = await notion(env, 'POST', '/file_uploads', {
    mode: 'single_part',
    filename: file.name,
    content_type: file.type || 'application/octet-stream',
  });

  const bytes = new FormData();
  bytes.append('file', file, file.name);
  await notion(env, 'POST', `/file_uploads/${created.id}/send`, bytes);

  return { id: created.id, name: file.name };
}


/* ==========================================================================
   4. Notion helpers
   ========================================================================== */

/**
 * Call the Notion API. Retries twice on rate limiting (429).
 * @param {object} env
 * @param {string} method
 * @param {string} path
 * @param {object|FormData} [body]
 */
async function notion(env, method, path, body) {
  const headers = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    'Notion-Version': NOTION_VERSION,
  };
  let payload;
  if (body instanceof FormData) {
    payload = body;                                   // multipart; boundary set automatically
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NOTION_API + path, { method, headers, body: payload });

    if (res.status === 429 && attempt < 2) {
      const waitSeconds = Number(res.headers.get('Retry-After')) || 1;
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status, `Notion: ${data.message || res.statusText}`);
    return data;
  }
}

/** Every page in a database (following pagination), sorted by name. */
async function queryAll(env, databaseId, filter) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;

    const res = await notion(env, 'POST', `/databases/${databaseId}/query`, body);
    for (const page of res.results) pages.push({ id: page.id, name: titleOf(page) });
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return pages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** The newest pages in a database, most recently created first. */
async function queryRecent(env, databaseId, filter) {
  const body = {
    page_size: Math.min(RECENT_LIMIT, 100),
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  };
  if (filter) body.filter = filter;

  const res = await notion(env, 'POST', `/databases/${databaseId}/query`, body);
  return res.results.map((page) => ({ id: page.id, name: titleOf(page) }));
}

/** Text of a page's title property, whatever that property is called. */
function titleOf(page) {
  const prop = Object.values(page.properties).find((p) => p.type === 'title');
  return (prop?.title || []).map((t) => t.plain_text).join('').trim() || 'Untitled';
}

/**
 * The name of a database's title property, needed to filter by it.
 * Cached for the life of the isolate, so most searches cost one call.
 */
const titleNames = new Map();

async function titlePropertyName(env, databaseId) {
  if (titleNames.has(databaseId)) return titleNames.get(databaseId);

  const db = await notion(env, 'GET', `/databases/${databaseId}`);
  const found = Object.entries(db.properties).find(([, p]) => p.type === 'title');
  if (!found) throw new HttpError(500, 'That database has no title property.');

  titleNames.set(databaseId, found[0]);
  return found[0];
}

/** Notion caps a text chunk at 2,000 characters; split longer text. */
function richText(value) {
  const text = asString(value);
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < 100; i += 2000) {
    chunks.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
  }
  return { rich_text: chunks };
}

/**
 * A Files property value from [{id, name}] of uploaded files.
 * @param {unknown} list
 * @param {string} label  property name, for error messages
 */
function fileList(list, label) {
  if (!Array.isArray(list) || list.length > 100) {
    throw new HttpError(400, `${label} must be a list of up to 100 items.`);
  }
  return {
    files: list.map((f) => {
      if (!isNotionId(f?.id)) throw new HttpError(400, 'A file id is malformed.');
      return { type: 'file_upload', file_upload: { id: f.id }, name: asString(f.name).slice(0, 100) || 'file' };
    }),
  };
}

/** A pasted link: blank stays null, and a bare "github.com/x/y" gets https://. */
function webUrl(value) {
  const raw = asString(value).trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return /^[\w-]+(\.[\w-]+)+(\/|$)/.test(raw) ? `https://${raw}` : raw;
}

/** "SCI-412" → a browse URL when JIRA_BASE_URL is set; blank stays null. */
function jiraUrl(value) {
  const raw = asString(value).trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (JIRA_BASE_URL && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(raw)) {
    return JIRA_BASE_URL.replace(/\/+$/, '') + '/' + raw.toUpperCase();
  }
  return raw;
}

/** Refuse to edit anything that isn't a Work Log entry. */
async function assertWorkLogPage(env, pageId) {
  const page = await notion(env, 'GET', `/pages/${pageId}`);
  if (normalizeId(page.parent?.database_id) !== normalizeId(WORK_LOG_DB)) {
    throw new HttpError(403, 'That page is not in the Work Log database.');
  }
}


/* ==========================================================================
   5. Request plumbing
   ========================================================================== */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Widget-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function readBody(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Request body must be JSON.'); }
}

function assertConfigured(env) {
  if (!env.NOTION_TOKEN || !env.WIDGET_KEY) {
    throw new HttpError(500, 'Worker is missing NOTION_TOKEN or WIDGET_KEY.');
  }
  const slots = [['Work Log', WORK_LOG_DB], ...Object.values(SOURCES).map((s) => [s.relation, s.database])];
  if (slots.some(([, id]) => id.startsWith('PASTE_'))) {
    throw new HttpError(500, 'Add your database IDs to worker.js.');
  }

  // Catch the common paste mistakes before Notion turns them into a vague 404.
  const key = normalizeId(env.WIDGET_KEY);
  for (const [name, id] of slots) {
    if (!/^[0-9a-f]{32}$/.test(normalizeId(id))) {
      throw new HttpError(500, `The ${name} database ID in worker.js isn't a 32-character Notion ID. Copy the part of the database URL before "?v=".`);
    }
    if (normalizeId(id) === key) {
      throw new HttpError(500, `The ${name} database ID in worker.js is the same string as WIDGET_KEY. Paste the real database ID there, and give WIDGET_KEY its own random value.`);
    }
  }
}

function assertAuthorized(request, env) {
  const given = request.headers.get('X-Widget-Key') || '';
  if (given.length !== env.WIDGET_KEY.length || given !== env.WIDGET_KEY) {
    throw new HttpError(401, 'Widget key rejected. Check key= in the embed URL.');
  }
}

const asString = (v) => (typeof v === 'string' ? v : '');
const normalizeId = (id) => asString(id).replace(/-/g, '').toLowerCase();
const isNotionId = (id) => /^[0-9a-f]{32}$/.test(normalizeId(id));
const isTimestamp = (v) => typeof v === 'string' && v.includes('T') && !Number.isNaN(Date.parse(v));
