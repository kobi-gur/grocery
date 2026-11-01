// UI, Supabase client, offline queue. The deploy workflow fills the two placeholders from GitHub secrets.
const SUPABASE_URL = '__SUPABASE_URL__';
const SUPABASE_ANON_KEY = '__SUPABASE_ANON_KEY__';

const UNITS = {
  unit: { one: 'יחידה', many: 'יחידות' },
  g: { one: 'גרם', many: 'גרם' },
  kg: { one: 'ק"ג', many: 'ק"ג' },
  ml: { one: 'מ"ל', many: 'מ"ל' },
  l: { one: 'ליטר', many: 'ליטר' },
  pack: { one: 'אריזה', many: 'אריזות' },
  bag: { one: 'שקית', many: 'שקיות' },
  bottle: { one: 'בקבוק', many: 'בקבוקים' },
};
const CATALOG_COLUMNS = 'id,name_he,barcode,category_id,is_favorite,default_unit,default_qty,times_bought';
const STORE = { code: 'grocery.code', server: 'grocery.server', queue: 'grocery.queue', dismissed: 'grocery.thursdayDismissed' };
const LONG_PRESS_MS = 550;
const UNDO_MS = 5000;
const RETRY_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;
const SAFETY_REFRESH_MS = 30000;
const CHAIN_THUMB_BASE = 'https://res.cloudinary.com/shufersal/image/upload/f_auto,q_auto/v1551800922/prod/product_images/products_medium';
const OFF_PRODUCT_BASE = 'https://world.openfoodfacts.org/api/v2/product';
const OFF_MIN_BARCODE_LENGTH = 8;
const PLACEHOLDER_THUMB = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M10 18l14-7 14 7v14l-14 7-14-7zM10 18l14 7 14-7M24 25v14" fill="none" stroke="#8a948e" stroke-width="2" stroke-linejoin="round"/></svg>')}`;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uuid = () => crypto.randomUUID();
const readJson = (key) => {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
};
const writeJson = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: keep running from memory */ }
};

const emptyServer = () => ({ household: null, categories: [], rows: [], favorites: [], frequent: [], missing: [] });

let db = null;
let code = null;
let server = emptyServer();
let queue = readJson(STORE.queue) ?? [];
let applied = []; // acknowledged writes not yet reflected in a fetched snapshot
let flushing = false;
let acks = 0;
let refreshing = false;
let refreshAgain = false;
let retryTimer = null;
let channel = null;
let connection = 'ok'; // ok | offline | asleep
let route = 'list';
let thursdaySelection = new Set();
let selected = null; // catalog item picked from the suggestions
let searchSeq = 0;
let searchTimer = null;
let toastTimer = null;
let undoAction = null;

function formatQty(qty, unit) {
  const n = Number(qty);
  const label = UNITS[unit] ?? UNITS.unit;
  return `${Number.isInteger(n) ? n : Number(n.toFixed(3))} ${n === 1 ? label.one : label.many}`;
}

// Server state with unconfirmed writes replayed on top, so a tap never flickers back.
function view() {
  return [...applied, ...queue].reduce(applyOp, structuredClone(server));
}

function applyOp(state, op) {
  switch (op.type) {
    case 'add': {
      state.rows = state.rows.filter((r) => !(r.status === 'unavailable' && sameItem(r, op.item)));
      const existing = state.rows.find((r) => r.status === 'on_list' && sameItem(r, op.item));
      if (existing) {
        existing.qty = existing.unit === op.unit ? Number(existing.qty) + op.qty : op.qty;
        existing.unit = op.unit;
      } else {
        state.rows.push({ id: op.id, status: 'on_list', qty: op.qty, unit: op.unit, catalog_items: op.item });
      }
      break;
    }
    case 'status': {
      const row = state.rows.find((r) => r.id === op.id);
      if (!row) break;
      const other = state.rows.find((r) => r !== row && r.status === op.status && sameItem(r, row.catalog_items));
      if (other) {
        if (other.unit === row.unit) row.qty = Number(row.qty) + Number(other.qty);
        state.rows = state.rows.filter((r) => r !== other);
      }
      row.status = op.status;
      break;
    }
    case 'remove':
      state.rows = state.rows.filter((r) => r.id !== op.id);
      break;
    case 'star': {
      for (const r of state.rows) {
        if (r.catalog_items.id === op.item.id) r.catalog_items.is_favorite = op.value;
      }
      state.favorites = state.favorites.filter((f) => f.id !== op.item.id);
      if (op.value) state.favorites.push({ ...op.item, is_favorite: true });
      break;
    }
    case 'finish':
      state.missing = state.rows.filter((r) => r.status === 'unavailable').map((r) => ({ qty: r.qty, unit: r.unit, item: r.catalog_items }));
      state.rows = [];
      break;
  }
  return state;
}

function sameItem(row, item) {
  return row.catalog_items.id === item.id || row.catalog_items.name_he === item.name_he;
}

// Offline queue. Writes apply locally at once and replay in order when the network answers.
function enqueue(op) {
  queue.push(op);
  writeJson(STORE.queue, queue);
  render();
  flush();
}

function runOp(op) {
  switch (op.type) {
    case 'add':
      return db.rpc('add_list_item', { p_op_id: op.opId, p_id: op.id, p_catalog_item_id: op.item.id, p_name: op.item.name_he, p_qty: op.qty, p_unit: op.unit });
    case 'status':
      return db.rpc('set_list_item_status', { p_id: op.id, p_status: op.status });
    case 'remove':
      return db.rpc('remove_list_item', { p_id: op.id });
    case 'star':
      return db.rpc('set_favorite', { p_catalog_item_id: op.item.id, p_value: op.value });
    case 'finish':
      return db.rpc('finish_trip', { p_trip_id: op.tripId });
    default:
      return Promise.resolve({ error: null, status: 200 });
  }
}

const isTransient = (status) => !status || status >= 500 || status === 408 || status === 429;

async function flush() {
  if (flushing || !db || queue.length === 0) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const { error, status } = await runOp(queue[0]);
      if (error && isTransient(status)) {
        setConnection();
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, RETRY_MS);
        return;
      }
      if (error) showToast('משהו השתבש, נסו שוב');
      else applied.push(queue[0]);
      queue.shift();
      writeJson(STORE.queue, queue);
      acks += 1;
      setConnection('ok');
    }
  } finally {
    flushing = false;
  }
  render();
  refresh();
}

function setConnection(next) {
  connection = next ?? (navigator.onLine ? 'asleep' : 'offline');
  renderStatus();
}

async function fetchAll() {
  const [households, categories, rows, favorites, frequent, trips] = await Promise.all([
    db.from('households').select('id,wifey_phone,reset_weekday,reset_hour'),
    db.from('categories').select('id,name_he,sort_order').order('sort_order'),
    db.from('list_items').select(`id,qty,unit,status,catalog_items(${CATALOG_COLUMNS})`).in('status', ['on_list', 'unavailable', 'bought']),
    db.from('catalog_items').select(CATALOG_COLUMNS).eq('is_favorite', true).order('name_he'),
    db.from('catalog_items').select(CATALOG_COLUMNS).gt('times_bought', 0).order('times_bought', { ascending: false }).limit(300),
    db.from('trips').select(`trip_items(qty,unit,outcome,catalog_items(${CATALOG_COLUMNS}))`).order('finished_at', { ascending: false }).limit(1),
  ]);
  const failed = [households, categories, rows, favorites, frequent, trips].find((r) => r.error);
  if (failed) return { ok: false, status: failed.status };
  if (households.data.length === 0) return { ok: false, badCode: true };
  return {
    ok: true,
    data: {
      household: households.data[0],
      categories: categories.data,
      rows: rows.data,
      favorites: favorites.data,
      frequent: frequent.data,
      missing: (trips.data[0]?.trip_items ?? [])
        .filter((t) => t.outcome === 'unavailable')
        .map((t) => ({ qty: t.qty, unit: t.unit, item: t.catalog_items })),
    },
  };
}

// One fetch at a time. A result that started before a write was acknowledged is stale, so fetch again.
async function refresh() {
  if (!db) return;
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      const acksAtStart = acks;
      const result = await fetchAll();
      if (result.badCode) {
        signOut();
        return;
      }
      if (!result.ok) {
        setConnection();
        return;
      }
      setConnection('ok');
      if (acksAtStart !== acks) {
        refreshAgain = true;
      } else if (!refreshAgain) {
        server = result.data;
        applied = [];
        writeJson(STORE.server, server);
        subscribe();
        render();
      }
    } while (refreshAgain);
  } finally {
    refreshing = false;
  }
}

// The database broadcasts a data-free ping on every list change, see 0001_schema.sql.
function subscribe() {
  const householdId = server.household?.id;
  if (!householdId) return;
  if (channel) return;
  const current = db.channel(`household:${householdId}`);
  channel = current;
  current
    .on('broadcast', { event: 'changed' }, () => refresh())
    .subscribe((status) => {
      if (current !== channel) return;
      if (status === 'SUBSCRIBED') {
        refresh();
      } else {
        // iOS drops the socket in the background. The next refresh subscribes again.
        channel = null;
        db.removeChannel(current);
      }
    });
}

function connect(newCode) {
  code = newCode;
  db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { 'x-household-code': code },
      fetch: (input, init = {}) => fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    },
  });
}

function signOut() {
  localStorage.removeItem(STORE.code);
  localStorage.removeItem(STORE.server);
  localStorage.removeItem(STORE.queue);
  if (channel) db.removeChannel(channel);
  channel = null;
  db = null;
  server = emptyServer();
  queue = [];
  applied = [];
  showSetup();
}

// Rendering
function render() {
  renderStatus();
  const state = view();
  const showing = { list: route === 'list', favorites: route === 'favorites', thursday: route === 'thursday' };
  $('screen-list').hidden = !showing.list;
  $('screen-favorites').hidden = !showing.favorites;
  $('screen-thursday').hidden = !showing.thursday;
  $('finish-bar').hidden = !showing.list;
  $('thursday-action').hidden = !showing.thursday;
  $('back').hidden = showing.list;
  $('open-favorites').hidden = !showing.list;
  $('title').textContent = showing.list ? 'רשימת קניות' : showing.favorites ? 'מועדפים' : 'מה להוסיף?';
  if (showing.list) renderList(state);
  if (showing.favorites) renderFavorites(state);
  if (showing.thursday) renderThursday(state);
}

function renderStatus() {
  const el = $('status');
  const pending = queue.length;
  if (connection === 'offline') {
    el.textContent = pending ? `אין קליטה. ${pending} שינויים מחכים ויישלחו לבד` : 'אין קליטה. אפשר להמשיך, הכל יישלח לבד';
  } else if (connection === 'asleep') {
    el.textContent = 'המסד ישן, לחץ להעיר';
  }
  el.hidden = connection === 'ok';
}

function onListIds(state) {
  return new Set(state.rows.map((r) => r.catalog_items.id));
}

function renderList(state) {
  $('thursday-banner').hidden = !thursdayDue(state.household);
  const active = state.rows.filter((r) => r.status === 'on_list' || r.status === 'unavailable');
  const boughtCount = state.rows.length - active.length;
  const taken = onListIds(state);
  let html = '';

  const missing = state.missing.filter((m) => !taken.has(m.item.id));
  if (missing.length) {
    html += `<section class="strip"><h2>חסר בפעם הקודמת</h2><div class="chips">${missing.map((m) =>
      `<button class="chip missing" data-add="${esc(m.item.id)}" data-source="missing">${esc(m.item.name_he)}</button>`).join('')}</div></section>`;
  }
  const frequent = state.frequent.filter((f) => !taken.has(f.id) && !missing.some((m) => m.item.id === f.id)).slice(0, 10);
  if (frequent.length) {
    html += `<section class="strip"><h2>בדרך כלל קונים</h2><div class="chips">${frequent.map((f) =>
      `<button class="chip" data-add="${esc(f.id)}" data-source="frequent">${esc(f.name_he)}</button>`).join('')}</div></section>`;
  }

  if (active.length === 0) {
    html += `<p class="empty">${boughtCount ? 'קניתם הכל. אפשר ללחוץ סיימתי' : 'הרשימה ריקה. מה חסר?'}</p>`;
  }
  for (const group of groupRows(active, state.categories)) {
    html += `<section class="group"><h2>${esc(group.name)}</h2><ul class="rows">${group.rows.map(rowHtml).join('')}</ul></section>`;
  }
  if (boughtCount && active.length) html += `<p class="count">נקנו ${boughtCount}</p>`;

  $('list-content').innerHTML = html;
  $('finish').disabled = state.rows.length === 0;
}

function groupRows(rows, categories) {
  const known = new Map(categories.map((c) => [c.id, c]));
  const groups = new Map();
  for (const row of rows) {
    const category = known.get(row.catalog_items.category_id);
    const key = category?.id ?? 'none';
    if (!groups.has(key)) groups.set(key, { name: category?.name_he ?? 'אחר', order: category?.sort_order ?? Number.MAX_SAFE_INTEGER, rows: [] });
    groups.get(key).rows.push(row);
  }
  const sorted = [...groups.values()].sort((a, b) => a.order - b.order);
  for (const g of sorted) {
    g.rows.sort((a, b) => (a.status === b.status ? a.catalog_items.name_he.localeCompare(b.catalog_items.name_he, 'he') : a.status === 'on_list' ? -1 : 1));
  }
  return sorted;
}

function rowHtml(row) {
  const item = row.catalog_items;
  const unavailable = row.status === 'unavailable';
  return `<li class="row ${unavailable ? 'unavailable' : ''}">
    <button class="row-main" data-row="${esc(row.id)}">
      <span class="name">${esc(item.name_he)}, ${esc(formatQty(row.qty, row.unit))}</span>
      ${unavailable ? '<span class="note">לא היה במלאי</span>' : ''}
    </button>
    <button class="icon-btn star ${item.is_favorite ? 'on' : ''}" data-star="${esc(item.id)}" aria-label="${item.is_favorite ? 'להוריד ממועדפים' : 'להוסיף למועדפים'}" aria-pressed="${item.is_favorite}">${item.is_favorite ? '&#9733;' : '&#9734;'}</button>
    <button class="icon-btn" data-remove="${esc(row.id)}" aria-label="למחוק מהרשימה">&times;</button>
  </li>`;
}

function renderFavorites(state) {
  const favorites = [...state.favorites].sort((a, b) => a.name_he.localeCompare(b.name_he, 'he'));
  let html = '';
  if (favorites.length === 0) {
    html = '<p class="empty">אין עדיין מועדפים. לוחצים על הכוכב ליד פריט ברשימה</p>';
  } else {
    html += '<button class="primary inline-link" data-go="thursday">להוסיף מועדפים לרשימה</button>';
    html += `<ul class="rows">${favorites.map((f) => `<li class="row">
      <span class="row-main"><span class="name">${esc(f.name_he)}</span></span>
      <button class="icon-btn star on" data-star="${esc(f.id)}" aria-label="להוריד ממועדפים" aria-pressed="true">&#9733;</button>
    </li>`).join('')}</ul>`;
  }
  $('screen-favorites').innerHTML = html;
}

function renderThursday(state) {
  const taken = onListIds(state);
  const favorites = [...state.favorites].sort((a, b) => a.name_he.localeCompare(b.name_he, 'he'));
  if (favorites.length === 0) {
    $('screen-thursday').innerHTML = '<p class="empty">אין עדיין מועדפים. לוחצים על הכוכב ליד פריט ברשימה</p>';
    $('thursday-action').hidden = true;
    return;
  }
  $('screen-thursday').innerHTML = `<p class="pad">כולם מסומנים. מורידים את מה שלא צריך השבוע.</p><ul class="rows">${favorites.map((f) => {
    const done = taken.has(f.id);
    return `<li class="row"><label class="select-row ${done ? 'done' : ''}">
      <input type="checkbox" data-pick="${esc(f.id)}" ${done ? 'disabled' : ''} ${!done && thursdaySelection.has(f.id) ? 'checked' : ''}>
      <span>${esc(f.name_he)}, ${esc(formatQty(f.default_qty, f.default_unit))}${done ? '<small>כבר ברשימה</small>' : ''}</span>
    </label></li>`;
  }).join('')}</ul>`;
  const count = favorites.filter((f) => !taken.has(f.id) && thursdaySelection.has(f.id)).length;
  $('thursday-confirm').textContent = count ? `להוסיף ${count} לרשימה` : 'לא נבחר כלום';
  $('thursday-confirm').disabled = count === 0;
}

function go(next) {
  route = next;
  if (next === 'thursday') {
    const state = view();
    const taken = onListIds(state);
    thursdaySelection = new Set(state.favorites.filter((f) => !taken.has(f.id)).map((f) => f.id));
    markThursdayHandled(state.household);
  }
  const hash = next === 'list' ? '#' : `#${next}`;
  if (location.hash !== hash && !(next === 'list' && location.hash === '')) history.pushState(null, '', hash === '#' ? location.pathname : hash);
  window.scrollTo(0, 0);
  render();
}

// In-app prompt for the weekly favorites. Shown from the set hour until accepted or dismissed.
function weekKey(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  return start.toISOString().slice(0, 10);
}

function thursdayDue(household) {
  if (!household) return false;
  const now = new Date();
  const afterHour = now.getDay() > household.reset_weekday || (now.getDay() === household.reset_weekday && now.getHours() >= household.reset_hour);
  return afterHour && localStorage.getItem(STORE.dismissed) !== weekKey() && view().favorites.length > 0;
}

function markThursdayHandled() {
  localStorage.setItem(STORE.dismissed, weekKey());
}

// Actions
function addToList(item, qty, unit) {
  enqueue({ type: 'add', opId: uuid(), id: uuid(), item, qty, unit });
}

function tapRow(id) {
  const row = view().rows.find((r) => r.id === id);
  if (!row) return;
  const previous = row.status;
  enqueue({ type: 'status', id, status: 'bought' });
  showToast(`נקנה: ${row.catalog_items.name_he}`, () => enqueue({ type: 'status', id, status: previous }));
}

function longPressRow(id) {
  const row = view().rows.find((r) => r.id === id);
  if (!row) return;
  enqueue({ type: 'status', id, status: row.status === 'unavailable' ? 'on_list' : 'unavailable' });
}

function removeRow(id) {
  const row = view().rows.find((r) => r.id === id);
  if (!row) return;
  enqueue({ type: 'remove', id });
  showToast(`נמחק: ${row.catalog_items.name_he}`, () => addToList(row.catalog_items, Number(row.qty), row.unit));
}

function toggleStar(itemId) {
  const state = view();
  const item = state.rows.map((r) => r.catalog_items).find((c) => c.id === itemId)
    ?? state.favorites.find((f) => f.id === itemId)
    ?? state.frequent.find((f) => f.id === itemId);
  if (!item) return;
  enqueue({ type: 'star', item, value: !item.is_favorite });
}

function showToast(text, undo) {
  clearTimeout(toastTimer);
  undoAction = undo ?? null;
  $('toast-text').textContent = text;
  $('toast-undo').hidden = !undo;
  $('toast').hidden = false;
  toastTimer = setTimeout(hideToast, undo ? UNDO_MS : 2500);
}

function hideToast() {
  clearTimeout(toastTimer);
  undoAction = null;
  $('toast').hidden = true;
}

function askFinish() {
  const state = view();
  const unavailable = state.rows.filter((r) => r.status === 'unavailable');
  const left = state.rows.filter((r) => r.status === 'on_list');
  let html = '<h2>לסיים את הקנייה?</h2>';
  if (left.length) html += `<p>עוד ${left.length === 1 ? 'פריט אחד לא סומן. גם הוא יימחק' : `${left.length} פריטים לא סומנו. גם הם יימחקו`} מהרשימה.</p>`;
  if (unavailable.length) {
    html += `<p>נשלח בוואטסאפ מה לא היה:</p><ul>${unavailable.map((r) => `<li>${esc(r.catalog_items.name_he)}, ${esc(formatQty(r.qty, r.unit))}</li>`).join('')}</ul>`;
  } else {
    html += '<p>הכל היה, אין מה לשלוח בוואטסאפ.</p>';
  }
  html += '<div class="actions"><button class="primary" id="finish-confirm">סיימתי</button><button class="secondary" id="finish-cancel">עוד לא</button></div>';
  $('modal-sheet').innerHTML = html;
  $('modal').hidden = false;
  $('finish-confirm').addEventListener('click', confirmFinish);
  $('finish-cancel').addEventListener('click', () => { $('modal').hidden = true; });
}

function confirmFinish() {
  $('modal').hidden = true;
  const state = view();
  const unavailable = state.rows.filter((r) => r.status === 'unavailable');
  const phone = (state.household?.wifey_phone ?? '').replace(/\D/g, '');
  // Queued and saved first, and opened in this same tap, because iOS blocks window.open outside a tap.
  enqueue({ type: 'finish', tripId: uuid() });
  hideToast();
  if (unavailable.length && phone) {
    const lines = unavailable.map((r) => `${r.catalog_items.name_he}, ${formatQty(r.qty, r.unit)}`);
    const text = `לא היה במלאי:\n${lines.join('\n')}`;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank');
  }
}

// Product thumbnails: chain image by barcode, then Open Food Facts, then the placeholder.
// Shufersal's file code is the barcode's last three spreadsheet-column letters (A to Z, then AA...) plus its digit sum.
function chainThumbUrl(barcode) {
  let n = Number(barcode);
  let letters = '';
  for (let i = 0; i < 3; i += 1) {
    n -= 1;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  const digitSum = [...barcode].reduce((sum, digit) => sum + Number(digit), 0);
  return `${CHAIN_THUMB_BASE}/${letters}${digitSum}_M_P_${barcode}_1.png`;
}

const chainThumbMisses = new Set();
const offThumbUrls = new Map();

// The Open Food Facts file name has a language and a revision, so it takes a lookup. Remembered for the session.
function offThumbUrl(barcode) {
  if (!offThumbUrls.has(barcode)) {
    offThumbUrls.set(barcode, fetch(`${OFF_PRODUCT_BASE}/${barcode}.json?fields=image_front_small_url,image_small_url`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data?.product?.image_front_small_url ?? data?.product?.image_small_url ?? null)
      .catch(() => {
        offThumbUrls.delete(barcode);
        return null;
      }));
  }
  return offThumbUrls.get(barcode);
}

function showThumb(img, url, onMiss) {
  img.onerror = () => {
    img.onerror = null;
    img.src = PLACEHOLDER_THUMB;
    onMiss?.();
  };
  img.src = url;
}

function loadThumb(img) {
  const barcode = img.dataset.barcode;
  if (!/^\d+$/.test(barcode ?? '')) return;
  const tryOff = async () => {
    if (barcode.length < OFF_MIN_BARCODE_LENGTH) return;
    const url = await offThumbUrl(barcode);
    if (url && img.dataset.barcode === barcode) showThumb(img, url);
  };
  if (chainThumbMisses.has(barcode)) {
    tryOff();
    return;
  }
  showThumb(img, chainThumbUrl(barcode), () => {
    chainThumbMisses.add(barcode);
    tryOff();
  });
}

const thumbObserver = new IntersectionObserver((entries, observer) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    loadThumb(entry.target);
  }
}, { rootMargin: '100px' });

function thumbHtml(item) {
  return `<img class="thumb" src="${PLACEHOLDER_THUMB}" alt="" loading="lazy" decoding="async" crossorigin="anonymous" data-barcode="${esc(item.barcode ?? '')}">`;
}

function showDetailThumb(item) {
  const img = $('add-thumb');
  img.onerror = null;
  img.hidden = !item;
  img.dataset.barcode = item?.barcode ?? '';
  img.src = PLACEHOLDER_THUMB;
  if (item) loadThumb(img);
}

// Add form
function parseQty() {
  const n = Number($('add-qty').value.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function stepQty(delta) {
  const next = Math.round((parseQty() + delta) * 1000) / 1000;
  $('add-qty').value = next > 0 ? next : parseQty();
}

function resetAdd() {
  selected = null;
  searchSeq += 1;
  clearTimeout(searchTimer);
  $('add-name').value = '';
  $('add-qty').value = '1';
  $('add-unit').value = 'unit';
  $('add-details').hidden = true;
  showDetailThumb(null);
  closeSuggestions();
}

function closeSuggestions() {
  $('suggestions').hidden = true;
  $('suggestions').innerHTML = '';
}

function pickItem(item) {
  selected = item;
  $('add-name').value = item.name_he;
  $('add-qty').value = Number(item.default_qty) || 1;
  $('add-unit').value = item.default_unit;
  $('add-details').hidden = false;
  showDetailThumb(item);
  closeSuggestions();
}

function onNameInput() {
  selected = null;
  showDetailThumb(null);
  const q = $('add-name').value.trim();
  $('add-details').hidden = q === '';
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  if (!q) {
    closeSuggestions();
    return;
  }
  renderSuggestions(q, localMatches(q));
  searchTimer = setTimeout(async () => {
    const { data, error } = await db.rpc('search_catalog', { p_q: q, p_limit: 12 });
    if (seq === searchSeq && !error) renderSuggestions(q, data);
  }, 150);
}

// Offline autocomplete from what the household already buys.
function localMatches(q) {
  const state = view();
  const pool = new Map([...state.frequent, ...state.favorites].map((i) => [i.id, i]));
  return [...pool.values()].filter((i) => i.name_he.includes(q)).slice(0, 8);
}

let suggestionItems = [];

function renderSuggestions(q, items) {
  suggestionItems = items;
  const exact = items.some((i) => i.name_he === q);
  let html = '';
  if (!exact) html += `<li><button type="button" class="new" data-new="1">להוסיף: ${esc(q)}</button></li>`;
  html += items.map((item, index) => `<li><button type="button" data-suggest="${index}">${thumbHtml(item)}<span class="suggest-name">${esc(item.name_he)}</span>${item.times_bought > 0 ? '<small>קנינו בעבר</small>' : ''}</button></li>`).join('');
  $('suggestions').innerHTML = html;
  $('suggestions').hidden = false;
  thumbObserver.disconnect();
  for (const img of $('suggestions').querySelectorAll('.thumb')) thumbObserver.observe(img);
}

function submitAdd(event) {
  event.preventDefault();
  const name = $('add-name').value.trim();
  if (!name) return;
  const unit = $('add-unit').value;
  const item = selected ?? {
    id: uuid(),
    name_he: name,
    category_id: null,
    is_favorite: false,
    default_unit: unit,
    default_qty: parseQty(),
    times_bought: 0,
  };
  addToList(item, parseQty(), unit);
  resetAdd();
  $('add-name').focus();
}

function bindEvents() {
  $('add').addEventListener('submit', submitAdd);
  $('add-name').addEventListener('input', onNameInput);
  $('qty-plus').addEventListener('click', () => stepQty(1));
  $('qty-minus').addEventListener('click', () => stepQty(-1));
  $('suggestions').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.new) {
      selected = null;
      closeSuggestions();
      $('add-qty').focus();
    } else {
      pickItem(suggestionItems[Number(button.dataset.suggest)]);
    }
  });

  bindRowGestures($('list-content'));
  for (const screen of ['screen-favorites', 'screen-thursday']) {
    $(screen).addEventListener('click', (e) => {
      const go_ = e.target.closest('[data-go]');
      if (go_) go(go_.dataset.go);
      const star = e.target.closest('[data-star]');
      if (star) toggleStar(star.dataset.star);
    });
  }
  $('screen-thursday').addEventListener('change', (e) => {
    const id = e.target.dataset?.pick;
    if (!id) return;
    if (e.target.checked) thursdaySelection.add(id);
    else thursdaySelection.delete(id);
    render();
  });
  $('thursday-confirm').addEventListener('click', () => {
    const state = view();
    const taken = onListIds(state);
    for (const f of state.favorites) {
      if (thursdaySelection.has(f.id) && !taken.has(f.id)) addToList(f, Number(f.default_qty) || 1, f.default_unit);
    }
    go('list');
  });
  $('thursday-yes').addEventListener('click', () => go('thursday'));
  $('thursday-no').addEventListener('click', () => {
    markThursdayHandled();
    render();
  });
  $('open-favorites').addEventListener('click', () => go('favorites'));
  $('back').addEventListener('click', () => go('list'));
  $('finish').addEventListener('click', askFinish);
  $('toast-undo').addEventListener('click', () => {
    const undo = undoAction;
    hideToast();
    if (undo) undo();
  });
  $('status').addEventListener('click', () => { flush(); refresh(); });

  window.addEventListener('popstate', () => {
    route = routeFromHash();
    if (route === 'thursday') go('thursday');
    else render();
  });
  window.addEventListener('online', wake);
  window.addEventListener('offline', () => setConnection('offline'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) wake();
  });
  setInterval(() => {
    if (!document.hidden) wake();
  }, SAFETY_REFRESH_MS);
}

function wake() {
  flush();
  refresh();
}

// Tap = bought, long press = unavailable. Handled together so a long press does not also count as a tap.
function bindRowGestures(container) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let longPressed = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  container.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('[data-row]');
    longPressed = false;
    if (!row) return;
    startX = e.clientX;
    startY = e.clientY;
    const id = row.dataset.row;
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      longPressRow(id);
    }, LONG_PRESS_MS);
  });
  container.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
  });
  container.addEventListener('pointerup', cancel);
  container.addEventListener('pointercancel', cancel);
  container.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-row]')) e.preventDefault();
  });
  container.addEventListener('click', (e) => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    const row = e.target.closest('[data-row]');
    if (row) return tapRow(row.dataset.row);
    const star = e.target.closest('[data-star]');
    if (star) return toggleStar(star.dataset.star);
    const remove = e.target.closest('[data-remove]');
    if (remove) return removeRow(remove.dataset.remove);
    const chip = e.target.closest('[data-add]');
    if (chip) addChip(chip.dataset.add, chip.dataset.source);
  });
}

function addChip(itemId, source) {
  const state = view();
  if (source === 'missing') {
    const m = state.missing.find((x) => x.item.id === itemId);
    if (m) addToList(m.item, Number(m.qty), m.unit);
  } else {
    const f = state.frequent.find((x) => x.id === itemId);
    if (f) addToList(f, Number(f.default_qty) || 1, f.default_unit);
  }
}

// Setup
function showSetup() {
  $('app').hidden = true;
  $('setup').hidden = false;
  $('setup-code').focus();
}

async function submitSetup(event) {
  event.preventDefault();
  const typed = $('setup-code').value.trim();
  if (!typed) return;
  $('setup-error').textContent = '';
  connect(typed);
  const { data, error, status } = await db.from('households').select('id');
  if (error) {
    db = null;
    $('setup-error').textContent = isTransient(status) ? 'אין חיבור כרגע, נסו שוב' : 'משהו השתבש, נסו שוב';
    return;
  }
  if (data.length === 0) {
    db = null;
    $('setup-error').textContent = 'הקוד לא נכון';
    return;
  }
  localStorage.setItem(STORE.code, typed);
  $('setup-code').value = '';
  startApp();
}

function routeFromHash() {
  const hash = location.hash.slice(1);
  return hash === 'favorites' || hash === 'thursday' ? hash : 'list';
}

function startApp() {
  $('setup').hidden = true;
  $('app').hidden = false;
  server = readJson(STORE.server) ?? emptyServer();
  const initial = routeFromHash();
  if (initial === 'thursday') go('thursday');
  else {
    route = initial;
    render();
  }
  flush();
  refresh().then(() => {
    if (initial === 'thursday') go('thursday');
  });
}

function init() {
  $('add-unit').innerHTML = Object.entries(UNITS).map(([value, label]) => `<option value="${value}">${esc(label.many)}</option>`).join('');
  bindEvents();
  $('setup').addEventListener('submit', submitSetup);

  if ('serviceWorker' in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // A new version took over. Reload unless the user is in the middle of typing.
      if (hadController && !$('add-name').value) location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => { /* the app still works online without it */ });
  }

  const saved = localStorage.getItem(STORE.code);
  if (saved) {
    connect(saved);
    startApp();
  } else {
    showSetup();
  }
}

init();
