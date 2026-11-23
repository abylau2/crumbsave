import {
  ALMATY, DISTRICTS, esc, haversine, fmtDist, fmtKzt, luhn, validExpiry, OVERPASS_ENDPOINTS, overpassQuery,
  parseElements, twoGisUrl, demoOffer, newOrderId, newPin, b64urlEncode, b64urlDecode,
  packOrder, unpackOrder, photoFor, logoText, addressQuery, nearestAddress,
} from './lib.js?v=20261123c';
import { DICT, LIB } from './i18n.js?v=20261123c';

const CFG = window.CRUMBSAVE_CONFIG || {};
const root = document.getElementById('root');

// ---------- хранилище ----------
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const sess = {
  get(k, fb) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const getOrders = () => store.get('cs_orders', []);
const getSold = () => store.get('cs_sold', {});
const getFavs = () => store.get('cs_favs', []);
const getUser = () => store.get('cs_user', null);

// ---------- язык / тема ----------
let lang = store.get('cs_lang', 'ru');
if (!DICT[lang]) lang = 'ru';
function t(key, vars) {
  let s = DICT[lang]?.[key] ?? DICT.ru[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
// Перевод текстов из lib.js; «Сегодня 21:00–22:00» → «Today 21:00–22:00».
function tr(str) {
  const m = LIB[lang]; if (!m || !str) return str || '';
  if (m[str]) return m[str];
  return String(str).replace(/^(Сегодня|Завтра)(?=\s)/, (w) => m[w] || w);
}
function setLang(l) {
  lang = l; store.set('cs_lang', l);
  document.documentElement.lang = l;
  route();
}
function applyTheme() {
  document.documentElement.classList.toggle('dark', store.get('cs_dark', false));
}
applyTheme();
document.documentElement.lang = lang;

// ---------- состояние ----------
const state = {
  loc: sess.get('cs_loc', null),
  source: sess.get('cs_src', 'default'), // 'gps' | 'district' | 'default'
  district: sess.get('cs_district', ''),
  radius: sess.get('cs_radius', 2000),
  cat: 'all',
  q: '',
  searchOpen: false,
  places: [],
  status: 'idle',
  geoMsg: '',
  geoInfo: false,
  ipCity: sess.get('cs_ipcity', ''),
  shown: 24,
  geoBusy: false,
  popOpen: false,
  initDone: false,
};
let loadToken = 0;
let mapInst = null;
let timer = null;
let renderGen = 0;

const placeCache = new Map(sess.get('cs_places', []).map((p) => [p.id, p]));
function rememberPlaces(list) {
  list.forEach((p) => placeCache.set(p.id, p));
  sess.set('cs_places', [...placeCache.values()].slice(-300));
}
const findPlace = (id) => state.places.find((p) => p.id === id) || placeCache.get(id) || store.get('cs_pc', {})[id];
function persistPlace(p) { const pc = store.get('cs_pc', {}); pc[p.id] = p; store.set('cs_pc', pc); }

// ---------- иконки (lucide) ----------
const ICONS = {
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/>',
  map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
  heart: '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/>',
  bag: '<path d="M16 10a4 4 0 0 1-8 0"/><path d="M3.103 6.034h17.794"/><path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
  nav: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  locate: '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  arrowR: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
};
const icon = (n, cls = 'w-4 h-4', fill = 'none') => `<svg class="${cls}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

// ---------- геолокация ----------
function refresh() {
  const v = (location.hash || '#/feed').replace(/^#\/?/, '').split('/')[0] || 'feed';
  if (v === 'feed' || v === 'map') route();
}
function geoErrorText(err) {
  if (!err) return t('geo.unavailable');
  if (err.code === 1) return t('geo.denied');
  if (err.code === 3) return t('geo.timeout');
  return t('geo.unavailable');
}
// Примерное положение по IP — если браузер не даёт геолокацию (выключены службы
// геолокации в macOS/Windows, отказ в разрешении, нет Wi‑Fi).
async function ipLocate() {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch('https://ipwho.is/?fields=success,city,latitude,longitude&lang=ru', { signal: ctl.signal });
    const j = await r.json();
    if (!j.success || typeof j.latitude !== 'number') return null;
    return { lat: j.latitude, lng: j.longitude, city: j.city || '' };
  } catch { return null; } finally { clearTimeout(to); }
}
function setLoc(loc, source) {
  state.loc = { lat: loc.lat, lng: loc.lng }; state.source = source; state.district = '';
  sess.set('cs_loc', state.loc); sess.set('cs_src', source); sess.set('cs_district', '');
}
function gpsOnce(opts) {
  return new Promise((resolve) => navigator.geolocation.getCurrentPosition((pos) => resolve({ pos }), (err) => resolve({ err }), opts));
}
async function locate() {
  state.geoBusy = true; state.geoMsg = ''; state.geoInfo = false; refresh();
  let err = null;
  if ('geolocation' in navigator) {
    let r = await gpsOnce({ enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
    if (r.err && r.err.code !== 1) r = await gpsOnce({ enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
    if (r.pos) {
      state.geoBusy = false;
      const here = { lat: r.pos.coords.latitude, lng: r.pos.coords.longitude };
      if (outsideService(here)) return true;
      setLoc(here, 'gps');
      return true;
    }
    err = r.err;
  }
  const ip = await ipLocate();
  state.geoBusy = false;
  if (ip && outsideService(ip)) return true;
  if (ip) {
    setLoc(ip, 'ip'); state.ipCity = ip.city; sess.set('cs_ipcity', ip.city);
    state.geoInfo = true;
    state.geoMsg = t(err && err.code === 1 ? 'geo.ipDenied' : 'geo.ipApprox');
    return true;
  }
  state.geoMsg = err ? geoErrorText(err) : t('geo.unsupported');
  return false;
}
// Сервис пока работает только в Алматы: если человек дальше 40 км — показываем центр Алматы и объясняем почему.
const SERVICE_RADIUS = 40000;
function outsideService(loc) {
  const d = haversine(loc, ALMATY);
  if (d <= SERVICE_RADIUS) return false;
  setDistrict('center');
  state.geoInfo = true;
  const km = Math.round(d / 1000);
  state.geoMsg = t('geo.onlyAlmaty', { km: km >= 1000 ? km.toLocaleString('ru-RU') : km });
  return true;
}
function setDistrict(id) {
  const d = DISTRICTS.find((x) => x.id === id) || DISTRICTS[0];
  state.loc = { lat: d.lat, lng: d.lng };
  state.source = d.id === 'center' ? 'default' : 'district';
  state.district = d.id === 'center' ? '' : d.id;
  sess.set('cs_loc', state.loc); sess.set('cs_src', state.source); sess.set('cs_district', state.district);
  state.geoMsg = '';
}

// ---------- реальные заведения (OpenStreetMap / Overpass) ----------
// Параллельные «хеджированные» запросы: первый сервер стартует сразу, следующие — с задержкой;
// побеждает самый быстрый ответ. Результат кэшируется в localStorage на 6 часов.
const OV_TTL = 6 * 60 * 60 * 1000;
function ovKey(loc, radius) { return `cs_ov_${loc.lat.toFixed(3)}_${loc.lng.toFixed(3)}_${radius}`; }
function cachedOverpass(loc, radius) {
  const c = store.get(ovKey(loc, radius), null);
  return c && Date.now() - c.t < OV_TTL ? c.els : null;
}
// Гонка зеркал Overpass: первый сервер сразу, остальные с задержкой; побеждает самый быстрый.
function overpassRace(query, { prefetch = null, timeout = 15000 } = {}) {
  const body = `data=${encodeURIComponent(query)}`;
  const ctls = [];
  const one = (ep, delay) => new Promise((resolve, reject) => {
    const ctl = new AbortController(); ctls.push(ctl);
    const start = setTimeout(async () => {
      const to = setTimeout(() => ctl.abort(), timeout);
      try {
        const res = await fetch(ep, { method: 'POST', body, signal: ctl.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.elements) throw new Error('bad');
        resolve(json.elements);
      } catch (e) { reject(e); } finally { clearTimeout(to); }
    }, delay);
    ctl.signal.addEventListener('abort', () => clearTimeout(start));
  });
  const racers = OVERPASS_ENDPOINTS.map((ep, i) => one(ep, i === 0 ? 0 : 1200 * i));
  if (prefetch && prefetch.body === body) racers.unshift(prefetch.promise.then((els) => els || Promise.reject(new Error('prefetch'))));
  return Promise.any(racers).finally(() => ctls.forEach((c) => c.abort()));
}
const trimEls = (els) => els.map((e) => ({ type: e.type, id: e.id, lat: e.lat, lon: e.lon, center: e.center, tags: e.tags }));
function fetchOverpass(loc, radius) {
  return overpassRace(overpassQuery(loc.lat, loc.lng, radius), { timeout: 40000 }).then((els) => {
    const trimmed = trimEls(els);
    store.set(ovKey(loc, radius), { t: Date.now(), els: trimmed, lat: loc.lat, lng: loc.lng, r: radius });
    return trimmed;
  });
}
// Быстрый первый запрос: ближайшие места (до 1,5 км, до 400 штук) — отвечает за 1–2 с.
const QUICK_R = 1500;
function fetchQuick(loc) {
  return overpassRace(overpassQuery(loc.lat, loc.lng, QUICK_R, 400), { prefetch: window.__csPrefetch, timeout: 20000 }).then(trimEls);
}
// Любой свежий кэш, который целиком покрывает нужный круг (например, загруженный ранее радиус побольше).
function coverFromCache(loc, radius) {
  let best = null;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('cs_ov_')) continue;
      const c = store.get(k, null);
      if (!c || !c.r || Date.now() - c.t > OV_TTL) continue;
      const d = haversine(loc, { lat: c.lat, lng: c.lng });
      if (d + radius <= c.r + 50 && (!best || c.r < best.r)) best = c;
    }
  } catch { /* ignore */ }
  return best ? best.els : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- точные адреса (номер дома из соседнего здания OSM) ----------
const ADDR_TTL = 7 * 24 * 3600 * 1000;
const addrCache = (() => { const c = store.get('cs_addr', {}); const now = Date.now(); for (const k of Object.keys(c)) if (now - c[k].t > ADDR_TTL) delete c[k]; return c; })();
function applyAddr(list) {
  for (const p of list) if (!p.address && addrCache[p.id]?.a) p.address = addrCache[p.id].a;
  return list;
}
let addrBusy = false;
async function resolveAddresses(list, radius = 50, remember = true) {
  const todo = list.filter((p) => !p.address && !addrCache[p.id]).slice(0, 60);
  if (!todo.length) return false;
  const els = await overpassRace(addressQuery(todo, radius), { timeout: 30000 });
  for (const p of todo) addrCache[p.id] = { a: nearestAddress(els, p, radius + 10) || '', t: Date.now() };
  store.set('cs_addr', addrCache);
  applyAddr(list); if (remember) rememberPlaces(list);
  return true;
}
async function enrichFeedAddresses() {
  if (addrBusy) return;
  addrBusy = true;
  try { if (await resolveAddresses(state.places.slice(0, Math.max(state.shown, 24)))) refresh(); } catch { /* адреса — не критично */ } finally { addrBusy = false; }
}
async function enrichPlaceAddress(p) {
  if (p.address || addrCache[p.id]) return;
  try {
    if (await resolveAddresses([p], 70)) {
      const live = state.places.find((x) => x.id === p.id); if (live) live.address = p.address;
      if ((location.hash || '').startsWith(`#/place/${p.id}`)) route();
    }
  } catch { /* ignore */ }
}

async function loadPlaces() {
  const token = ++loadToken;
  state.shown = 24;
  const loc = state.loc; const radius = state.radius;
  let shown = false;
  const show = (els) => {
    if (token !== loadToken) return;
    state.places = applyAddr(parseElements(els, loc).filter((p) => p.distance == null || p.distance <= radius + 30));
    rememberPlaces(state.places);
    state.status = 'ready'; shown = true;
    refresh();
    setTimeout(enrichFeedAddresses, 300);
  };
  const cover = cachedOverpass(loc, radius) || coverFromCache(loc, radius);
  if (cover) show(cover);
  else { state.status = 'loading'; refresh(); }
  // 1) быстрые ближайшие места — чтобы лента появилась сразу
  if (!cover && radius > QUICK_R) {
    try { show(await fetchQuick(loc)); } catch { /* попробуем полный запрос */ }
    if (token !== loadToken) return;
  }
  // 2) полный радиус, с одной повторной попыткой
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { show(await fetchOverpass(loc, radius)); return; } catch { if (token !== loadToken) return; await sleep(1500); }
    if (token !== loadToken) return;
  }
  if (!shown) { state.status = 'error'; refresh(); }
}
async function init() {
  if (state.initDone) return;
  state.initDone = true;
  if (!state.loc) { state.loc = { ...ALMATY }; state.source = 'default'; }
  loadPlaces(); // сразу грузим город/район, не дожидаясь GPS
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p && p.state === 'granted' && state.source === 'default' && await locate()) loadPlaces();
  } catch { /* Permissions API недоступен */ }
}

// ---------- общие куски UI ----------
const offerFor = (p) => demoOffer(p, new Date(), getSold()[p.id] || 0);
function leftText(n) {
  if (n === 0) return t('left.0');
  if (n === 1) return t('left.1');
  return t(n >= 2 && n <= 4 ? 'left.few' : 'left.many', { n });
}
const BTN_PRIMARY = 'w-full min-h-[50px] rounded-[14px] bg-brand hover:bg-brand-hover text-white font-bold text-sm flex items-center justify-center gap-2 transition disabled:opacity-60';

function langSwitch() {
  const b = (l, label, title) => `<button role="radio" aria-checked="${lang === l}" title="${title}" data-lang="${l}" class="h-8 min-w-10 px-2.5 rounded-full text-xs font-bold transition ${lang === l ? 'bg-surface text-ink shadow-sm' : 'text-sub hover:text-ink'}">${label}</button>`;
  return `<div role="radiogroup" aria-label="${t('lang')}" class="inline-flex p-0.5 rounded-full bg-muted border border-line">${b('ru', 'RU', 'Русский')}${b('en', 'EN', 'English')}${b('kk', 'KZ', 'Қазақша')}</div>`;
}

const LOGO_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="13" fill="#1f5750"/><path d="M14 18h20l-1.6 17.2a3 3 0 0 1-3 2.8H18.6a3 3 0 0 1-3-2.8z" fill="#f7ecd6"/><path d="M19.5 18v-1.5a4.5 4.5 0 0 1 9 0V18" fill="none" stroke="#f7ecd6" stroke-width="2.6" stroke-linecap="round"/><path d="M24 33.5c-3.8-1.4-5.4-4.7-4.4-8.6 3.9-.6 6.6 1.3 7.3 4.6" fill="#2f7d6d"/><path d="M24 33.5c.4-3.6 2.4-6.4 6-7.6.7 3.9-1.5 6.9-6 7.6z" fill="#3fa58d"/></svg>';
function initials(u) {
  const src = (u?.name || u?.email || 'CS').trim();
  const parts = src.split(/[\s._@-]+/).filter((w) => /^\p{L}/u.test(w));
  return ((parts[0]?.[0] || 'C') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase();
}
function activeOrdersCount() {
  const now = Date.now();
  return getOrders().filter((o) => orderEnd(o) > now).length;
}
function headerHtml(active) {
  const nav = [['feed', 'compass', 'nav.feed'], ['map', 'map', 'nav.map'], ['favorites', 'heart', 'nav.fav'], ['orders', 'bag', 'nav.orders']];
  const user = getUser();
  const n = user ? activeOrdersCount() : 0;
  return `<header class="cs-header hidden md:block"><div class="cs-hwrap">
      <a class="cs-brand" href="#/feed" aria-label="CrumbSave — ${t('nav.feed')}">${LOGO_SVG}CrumbSave</a>
      <nav class="cs-nav" aria-label="${t('nav.main')}">
        ${nav.map(([k, ic, key]) => `<a ${active === k ? 'aria-current="page"' : ''} href="#/${k}">${icon(ic, 'w-[18px] h-[18px]')}${t(key)}${k === 'orders' && n ? `<span class="cs-badge" aria-label="${n}">${n}</span>` : ''}</a>`).join('')}
      </nav>
      ${user
    ? `<a class="cs-user" href="#/profile" ${active === 'profile' ? 'aria-current="page"' : ''}><span class="cs-ava">${esc(initials(user))}</span>${esc(user.name || user.email.split('@')[0])}</a>`
    : `<a class="cs-login" href="#/login">${t('login')}</a>`}
    </div></header>`;
}

function mobileNav(active) {
  const items = [['feed', 'compass', 'nav.feed'], ['map', 'map', 'nav.map'], ['favorites', 'heart', 'nav.fav'], ['orders', 'bag', 'nav.orders'], ['profile', 'user', 'nav.profile']];
  return `<nav class="md:hidden sticky bottom-0 z-20 h-[76px] shrink-0 border-t border-line bg-surface/90 backdrop-blur-xl px-4 pb-3 flex items-center justify-around">
    ${items.map(([k, ic, key]) => `<a ${active === k ? 'aria-current="page"' : ''} class="relative flex flex-col items-center gap-0.5 min-h-[44px] min-w-[44px] justify-center transition ${active === k ? 'text-brand dark:text-emerald-400' : 'text-sub hover:text-ink'}" href="#/${k}">${icon(ic, 'w-[22px] h-[22px]')}<span class="text-[10px] font-semibold">${t(key)}</span></a>`).join('')}
  </nav>`;
}

// Оболочка страницы: шапка (десктоп) + содержимое + нижняя навигация (мобильная)
function shell(inner, active, { maxw = 'md:max-w-6xl', nav = true } = {}) {
  root.innerHTML = `<main class="mx-auto max-w-[430px] md:max-w-none min-h-dvh bg-canvas relative shadow-2xl md:shadow-none">
    ${headerHtml(active)}
    <div class="flex flex-col min-h-dvh md:min-h-[calc(100dvh-4rem)]">
      <div class="flex-1 w-full md:mx-auto md:px-2 ${maxw}">${inner}</div>
      ${nav ? mobileNav(active) : ''}
    </div></main>`;
}

const isFav = (id) => getFavs().includes(id);

function fmtMins(m) { return m >= 60 ? t('time.hm', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') }) : t('time.m', { m }); }
function timeText(o) {
  if (o.minsLeft != null && o.open) return t('time.left', { t: fmtMins(o.minsLeft), c: o.closes });
  return tr(o.window);
}
function soonCls(o) { return o.minsLeft != null && o.open && o.minsLeft <= 60 ? 'text-urgent font-semibold' : 'text-sub'; }

function placeCard(p, eager) {
  const o = offerFor(p);
  const lowCls = o.left <= 1 ? 'bg-urgent-soft text-urgent' : 'bg-surface/95 text-ink';
  const fav = isFav(p.id);
  return `<div class="relative bg-surface rounded-[18px] border border-line card-shadow overflow-hidden md:hover:-translate-y-0.5 md:hover:shadow-lg transition">
    <a class="block" href="#/place/${esc(p.id)}">
      <div class="relative aspect-[16/10] bg-muted">
        <img alt="${esc(tr(o.title))}" class="w-full h-full object-cover" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="640" height="400" src="${esc(photoFor(p))}">
        <span class="absolute left-3 bottom-3 px-2.5 py-1 rounded-full text-[11px] font-bold ${lowCls}">${esc(leftText(o.left))}</span>
        <span class="absolute left-3 top-2 mt-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-ink text-canvas">${t('demo')}</span>
      </div>
      <div class="p-4 space-y-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 shrink-0 rounded-full bg-brand-soft text-brand dark:text-emerald-300 text-[10px] font-extrabold flex items-center justify-center">${esc(logoText(p.name))}</div>
          <div class="min-w-0">
            <div class="flex items-center gap-2"><h4 class="font-bold text-[15px] text-ink truncate">${esc(p.name)}</h4>
              ${p.distance != null ? `<span class="flex items-center gap-0.5 text-xs font-semibold text-ink shrink-0">${icon('pin', 'w-3 h-3')} ${esc(fmtDist(p.distance))}</span>` : ''}</div>
            <p class="text-xs text-sub truncate">${esc(tr(p.kind))}${p.address ? ` · ${esc(p.address)}` : ''}</p>
          </div>
        </div>
        <p class="text-sm text-ink">${esc(tr(o.title))}</p>
        <div class="flex items-end justify-between">
          <div class="flex items-center gap-1.5 text-xs ${soonCls(o)}">${icon('clock', 'w-3.5 h-3.5')}<span class="numeric">${esc(timeText(o))}</span></div>
          <div class="flex items-center gap-2">
            <span class="px-1.5 py-0.5 rounded-md bg-brand-soft text-brand dark:text-emerald-300 text-[11px] font-bold">−${o.discount}%</span>
            <div class="flex flex-col items-end leading-tight"><del class="text-[11px] text-sub numeric">${fmtKzt(o.ref)}</del><span class="text-base font-extrabold text-ink numeric">${fmtKzt(o.price)}</span></div>
          </div>
        </div>
      </div>
    </a>
    <button aria-label="${esc(fav ? t('fav.remove') : t('fav.add', { name: p.name }))}" aria-pressed="${fav}" data-fav="${esc(p.id)}" class="absolute top-2 right-2 w-11 h-11 flex items-center justify-center"><span class="w-9 h-9 rounded-full bg-surface/95 flex items-center justify-center shadow">${icon('heart', `w-[18px] h-[18px] ${fav ? 'text-urgent' : 'text-ink'}`, fav ? 'currentColor' : 'none')}</span></button>
  </div>`;
}

function skeletonCards(n = 6) {
  return Array.from({ length: n }, () => `<div class="bg-surface rounded-[18px] border border-line overflow-hidden" aria-hidden="true">
    <div class="aspect-[16/10] skel"></div><div class="p-4 space-y-3"><div class="h-10 skel rounded-full" style="width:66%"></div><div class="h-4 skel rounded-md"></div><div class="h-8 skel rounded-md"></div></div></div>`).join('');
}

function locLabel() {
  if (state.source === 'gps') return t('near');
  if (state.source === 'ip') return t('near.approx');
  if (state.source === 'district') return tr(state.district);
  return t('city');
}
function geoMsgHtml() {
  if (!state.geoMsg) return '';
  const cls = state.geoInfo ? 'bg-brand-soft text-ink' : 'bg-urgent-soft text-urgent';
  return `<div class="px-4 pb-2"><div class="${cls} rounded-[14px] px-4 py-2.5 text-sm font-medium flex items-center justify-between gap-3" role="${state.geoInfo ? 'status' : 'alert'}">
    <span class="flex items-center gap-2">${icon(state.geoInfo ? 'locate' : 'pin', 'w-4 h-4 shrink-0')}${esc(state.geoMsg)}</span>
    <button class="w-8 h-8 shrink-0 rounded-full flex items-center justify-center hover:bg-muted" data-action="hide-geo" aria-label="${t('back')}">${icon('x', 'w-4 h-4')}</button></div></div>`;
}
function geoPopHtml() {
  if (!state.popOpen) return '';
  return `<div class="geo-pop" role="dialog" aria-label="${t('pickDistrict')}">
    <button data-action="locate" ${state.geoBusy ? 'disabled' : ''}>${icon('locate', 'w-[18px] h-[18px] text-brand')}<span>${state.geoBusy ? t('geo.busy') : t('geo.locate')}</span></button>
    <hr>
    <div class="px-3 pt-1 pb-1 text-xs text-sub font-semibold">${t('geo.radius')}</div>
    <div class="flex gap-2 px-3 pb-2">${[1000, 2000, 3000, 5000].map((r) => `<button data-radius="${r}" style="width:auto;padding:6px 12px" class="rounded-full border ${r === state.radius ? 'bg-ink text-canvas border-ink' : 'border-line'}">${r / 1000} ${t('km')}</button>`).join('')}</div>
    <hr>
    <div class="px-3 pt-1 pb-1 text-xs text-sub font-semibold">${t('geo.districts')}</div>
    ${DISTRICTS.map((d) => `<button data-district="${esc(d.id)}">${icon('pin', 'w-4 h-4 text-sub')}<span>${d.id === 'center' ? t('geo.center') : esc(tr(d.id))}</span></button>`).join('')}
  </div>`;
}
function cityRow(withSearch) {
  return `<div class="sticky top-0 md:top-16 z-20 bg-canvas/95 backdrop-blur px-4 pt-4 pb-2 md:pt-6 flex items-center justify-between gap-2">
    <div class="relative">
      <button class="flex items-center gap-1.5 min-h-[44px] text-ink" aria-label="${t('pickDistrict')}" aria-expanded="${state.popOpen}" data-action="pop">${icon('pin', 'w-4 h-4')}<span class="font-bold text-[15px]">${esc(locLabel())}</span>${icon('chevron', 'w-4 h-4')}</button>
      ${geoPopHtml()}
    </div>
    <div class="flex items-center gap-2">
      ${state.source !== 'gps' ? `<button class="h-11 px-4 rounded-full flex items-center gap-2 bg-surface border border-line text-ink text-sm font-semibold" data-action="locate" ${state.geoBusy ? 'disabled' : ''}>${icon('locate', 'w-4 h-4 text-brand')}${state.geoBusy ? t('geo.busy') : t('geo.btn')}</button>` : ''}
      ${withSearch ? `<button aria-label="${t('search')}" data-action="search" class="w-11 h-11 rounded-full flex items-center justify-center bg-surface border border-line text-ink">${icon('search', 'w-[18px] h-[18px]')}</button>` : ''}
    </div></div>`;
}

// ---------- экраны ----------
function renderFeed() {
  const cats = ['all', 'bakery', 'ready', 'groceries'];
  const q = state.q.trim().toLowerCase();
  const list = state.places.filter((p) => (state.cat === 'all' || p.cat === state.cat) && (!q || p.name.toLowerCase().includes(q)))
    .map((p, i) => ({ p, i, out: offerFor(p).left === 0 ? 1 : 0 })).sort((a, b) => a.out - b.out || a.i - b.i).map((x) => x.p);
  let body;
  if (state.status === 'loading' || state.status === 'idle') body = `<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 md:gap-5">${skeletonCards()}</div>`;
  else if (state.status === 'error') body = `<div class="bg-urgent-soft text-urgent rounded-[18px] p-4 text-sm font-semibold flex items-center justify-between gap-3" role="alert"><span>${t('load.error')}</span><button class="h-9 px-4 rounded-full bg-surface text-ink border border-line" data-action="retry">${t('retry')}</button></div>`;
  else if (!list.length) body = `<div class="text-center space-y-2 pt-10"><h3 class="text-xl font-bold text-ink">${t('empty.title')}</h3><p class="text-sm text-sub">${t('empty.text')}</p></div>`;
  else body = `<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 md:gap-5">${list.slice(0, state.shown).map((p, i) => placeCard(p, i < 3)).join('')}</div>
    ${list.length > state.shown ? `<div class="flex justify-center pt-2"><button class="h-11 px-6 rounded-full bg-surface border border-line text-ink text-sm font-bold hover:bg-muted" data-action="more">${t('feed.more', { n: Math.min(24, list.length - state.shown) })}</button></div>` : ''}`;
  shell(`
    ${cityRow(true)}
    ${state.searchOpen ? `<div class="px-4 pb-2"><input id="q" class="input" placeholder="${t('searchPh')}" value="${esc(state.q)}" aria-label="${t('search')}"></div>` : ''}
    ${geoMsgHtml()}
    <div class="flex gap-2 px-4 py-2 overflow-x-auto no-scrollbar">
      ${cats.map((c) => `<button aria-pressed="${state.cat === c}" data-cat="${c}" class="shrink-0 h-9 px-4 rounded-full text-[13px] font-semibold border transition ${state.cat === c ? 'bg-ink text-canvas border-ink' : 'bg-surface text-ink border-line'}">${t(`cat.${c}`)}</button>`).join('')}
    </div>
    <div class="px-4 pb-6 md:pb-12 space-y-4">
      <div class="flex items-baseline justify-between pt-2"><h3 class="text-lg md:text-2xl font-bold text-ink">${t('feed.today')}</h3><span class="text-xs md:text-sm text-sub">${state.status === 'ready' ? esc(t('feed.count', { n: list.length, r: state.radius / 1000 })) + ' · ' : ''}${t('feed.until')}</span></div>
      ${body}
    </div>`, 'feed');
  const qi = document.getElementById('q');
  if (qi && state.searchOpen) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
}

// Прямая ссылка на набор в новом браузере: заведения ещё нет в памяти — загружаем его по номеру из OpenStreetMap.
const placeLookups = {};
function fetchPlaceById(id) {
  const m = /^([nwr])(\d+)$/.exec(id || '');
  if (!m) return Promise.resolve(null);
  if (!placeLookups[id]) {
    const type = { n: 'node', w: 'way', r: 'relation' }[m[1]];
    placeLookups[id] = overpassRace(`[out:json][timeout:20];${type}(id:${m[2]});out center tags;`, { timeout: 20000 })
      .then((els) => {
        const [p] = parseElements(els, state.loc || ALMATY);
        if (p) { applyAddr([p]); rememberPlaces([p]); persistPlace(p); }
        return p || null;
      })
      .catch(() => { delete placeLookups[id]; return undefined; });
  }
  return placeLookups[id];
}
function placeMissing(id) {
  const myHash = location.hash;
  shell(`<div class="px-6 pt-16 md:pt-10 space-y-4" role="status"><div class="h-8 skel rounded-md" style="width:60%"></div><p class="text-sm text-sub">${t('l.loading')}</p></div>`, 'feed', { maxw: 'md:max-w-2xl' });
  fetchPlaceById(id).then((p) => {
    if (location.hash !== myHash) return;
    if (p) { route(); return; }
    const msg = p === null ? t('l.notFound') : t('load.error');
    shell(`<div class="px-6 pt-16 md:pt-10 space-y-4"><h3 class="text-xl font-bold text-ink">${msg}</h3>
      <div class="flex gap-3 flex-wrap">${p === undefined ? `<button class="${LOGIN_BTN}" data-action="reload">${t('retry')}</button>` : ''}<a class="${LOGIN_BTN}" href="#/feed">${t('nav.feed')}</a></div></div>`, 'feed', { maxw: 'md:max-w-2xl' });
  });
}

const INSIDE = { bakery: 'l.insideText.bakery', ready: 'l.insideText.ready', groceries: 'l.insideText.groceries' };
function renderPlace(id) {
  const p = findPlace(id);
  if (!p) { placeMissing(id); return; }
  enrichPlaceAddress(p);
  const o = offerFor(p);
  const phone = p.phone ? p.phone.replace(/[^\d+]/g, '') : '';
  const fav = isFav(p.id);
  root.innerHTML = `<main class="mx-auto max-w-[430px] md:max-w-none min-h-dvh bg-canvas relative shadow-2xl md:shadow-none">
    ${headerHtml('feed')}
    <div class="min-h-dvh md:min-h-0 flex flex-col md:grid md:grid-cols-[1.1fr_1fr] md:gap-10 md:items-start md:max-w-6xl md:mx-auto md:px-6 md:py-8">
      <div class="relative h-[260px] md:h-[520px] bg-muted md:rounded-[28px] md:overflow-hidden md:sticky md:top-24">
        <img alt="${esc(tr(o.title))}" class="w-full h-full object-cover" fetchpriority="high" decoding="async" src="${esc(photoFor(p, 1000))}">
        <div class="absolute inset-x-0 top-0 p-4 flex justify-between">
          <button aria-label="${t('back')}" data-action="back" class="w-11 h-11 rounded-full bg-surface/95 text-ink flex items-center justify-center shadow">${icon('back', 'w-5 h-5')}</button>
          <div class="flex gap-2">
            <button aria-label="${t('share')}" data-action="share" class="w-11 h-11 rounded-full bg-surface/95 text-ink flex items-center justify-center shadow">${icon('share', 'w-5 h-5')}</button>
            <button aria-label="${t('nav.fav')}" aria-pressed="${fav}" data-fav="${esc(p.id)}" class="w-11 h-11 rounded-full bg-surface/95 text-ink flex items-center justify-center shadow">${icon('heart', `w-5 h-5 ${fav ? 'text-urgent' : ''}`, fav ? 'currentColor' : 'none')}</button>
          </div>
        </div>
      </div>
      <div class="flex-1 pb-32 md:pb-0">
        <div class="p-5 md:p-0 space-y-5">
          <div class="space-y-1.5">
            <div class="flex items-center gap-1.5 text-sm text-sub"><span class="font-semibold text-ink">${esc(p.name)}</span>·<span>${esc(tr(p.kind))}</span>${p.distance != null ? `·<span class="flex items-center gap-0.5">${icon('pin', 'w-3 h-3')} ${esc(fmtDist(p.distance))}</span>` : ''}</div>
            <h2 class="text-2xl md:text-4xl font-extrabold text-ink">${esc(tr(o.title))}</h2>
            <p class="flex items-center gap-1 text-sm text-sub">${icon('pin', 'w-4 h-4 shrink-0')} ${p.address ? esc(p.address) : esc(addrCache[p.id] ? t('city') : t('l.addrLoading'))}</p>
            <p class="text-sm font-semibold text-sub">${esc(leftText(o.left))} · <span class="text-urgent">${t('demo')}</span></p>
          </div>
          <div class="flex items-center justify-between p-4 rounded-[18px] bg-brand-soft">
            <div><span class="text-xs font-semibold uppercase tracking-wide text-brand dark:text-emerald-300">${t('l.pickup')}</span>
              <p class="text-lg font-bold text-ink numeric">${esc(tr(o.window).replace(' ', ', '))}</p><p class="text-xs text-sub">${t('l.pickupHint')}</p></div>
            ${icon('clock', 'w-7 h-7 text-brand dark:text-emerald-300')}
          </div>
          <div><h4 class="font-bold text-ink mb-1">${t('l.inside')}</h4><p class="text-sm text-sub leading-relaxed">${t(INSIDE[p.cat] || INSIDE.ready)}</p></div>
          ${p.hours ? `<p class="text-sm"><span class="font-semibold text-ink">${t('l.hours')}</span><span class="text-sub">${esc(p.hours)}</span></p>` : ''}
          <p class="text-sm"><span class="font-semibold text-ink">${t('l.allergens')}</span><span class="text-sub">${t('l.allergensVal')}</span></p>
          <p class="text-sm"><span class="font-semibold text-ink">${t('l.cancel')}</span><span class="text-sub">${t('l.cancelVal')}</span></p>
          <p class="text-xs text-sub">${t('l.demoNote')}</p>
          <div class="flex items-center justify-between pt-4 border-t border-line gap-3">
            <div class="min-w-0"><p class="text-sm font-semibold text-ink">${esc(p.name)}</p><p class="text-xs text-sub">${p.address ? `${esc(p.address)} · ${esc(t('city'))}` : esc(t('city'))}</p></div>
            <a href="${esc(twoGisUrl(p.name, p.lat, p.lng, p.address))}" data-route-id="${esc(p.id)}" data-route-name="${esc(p.name)}" data-route-lat="${p.lat}" data-route-lng="${p.lng}" data-route-addr="${esc(p.address || '')}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-1.5 text-sm font-bold text-brand dark:text-emerald-300 min-h-[44px] shrink-0">${icon('nav', 'w-4 h-4')} ${t('l.route')}</a>
          </div>
          <div class="flex items-center gap-4 text-sm font-semibold text-brand dark:text-emerald-300 flex-wrap">
            ${phone ? `<a class="min-h-[44px] flex items-center" href="tel:${esc(phone)}">${t('l.call')}</a>` : ''}
            ${p.website ? `<a class="min-h-[44px] flex items-center" href="${esc(p.website)}" target="_blank" rel="noopener noreferrer nofollow">${t('l.site')}</a>` : ''}
          </div>
        </div>
        <footer class="fixed md:static bottom-0 inset-x-0 mx-auto max-w-[430px] md:max-w-none md:mt-6 bg-surface border-t md:border border-line md:rounded-[18px] md:card-shadow p-4 pb-6 md:pb-4 flex items-center gap-4 z-20">
          <div class="shrink-0"><div class="flex items-baseline gap-2"><del class="text-xs text-sub numeric">${fmtKzt(o.ref)}</del><strong class="text-xl font-extrabold text-ink numeric">${fmtKzt(o.price)}</strong></div>
            <div class="text-[11px] text-sub">${t('l.fee', { fee: fmtKzt(o.fee) })}</div></div>
          <div class="flex-1"><button class="${BTN_PRIMARY}" data-action="book" data-id="${esc(p.id)}" ${o.left ? '' : 'disabled'}>${o.left ? t('l.book') : t('l.soldOut')}</button></div>
        </footer>
      </div>
    </div></main>`;
}

async function renderMap() {
  const gen = renderGen;
  if (state.status === 'idle') init();
  shell(`${cityRow(false)}
    ${geoMsgHtml()}
    <div class="relative h-[calc(100dvh-140px)] md:h-[calc(100dvh-4rem-76px)] md:px-4 md:pb-4"><div id="map" class="w-full h-full z-0 md:rounded-[18px]" role="region" aria-label="${t('nav.map')}"></div></div>`, 'map', { maxw: 'md:max-w-none' });
  try {
    if (!document.querySelector('link[href="vendor/leaflet.css"]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'vendor/leaflet.css'; document.head.appendChild(l);
    }
    await loadScript('vendor/leaflet.js');
  } catch { document.getElementById('map').innerHTML = '<p class="p-4 text-sm">Map failed to load</p>'; return; }
  const el = document.getElementById('map');
  if (gen !== renderGen || !el || mapInst) return;
  const L = window.L;
  const c = state.loc || ALMATY;
  mapInst = L.map(el, { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([c.lat, c.lng], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(mapInst);
  const pts = [[c.lat, c.lng]];
  const ring = L.circle([c.lat, c.lng], { radius: state.radius, color: '#1f5750', weight: 1.5, fillColor: '#1f5750', fillOpacity: 0.05, interactive: false }).addTo(mapInst);
  if (state.source === 'gps' || state.source === 'ip') {
    L.circleMarker([c.lat, c.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(mapInst).bindTooltip(t('near'));
  }
  const list = state.places.slice(0, 400);
  const popupFor = (p, o) => {
    const box = document.createElement('div'); box.className = 'space-y-1 min-w-[180px]';
    const a = document.createElement('a'); a.className = 'font-bold'; a.href = `#/place/${p.id}`; a.textContent = p.name;
    const ad = document.createElement('div'); ad.className = 'text-xs'; ad.textContent = p.address || tr(p.kind);
    const ol = document.createElement('a'); ol.className = 'block text-xs'; ol.href = `#/place/${p.id}`;
    ol.append(document.createTextNode(`${tr(o.title)} — `)); const bb = document.createElement('b'); bb.textContent = fmtKzt(o.price); ol.append(bb);
    box.append(a, ad, ol);
    return box;
  };
  // Все заведения — аккуратные точки; подписи — только тем, что не перекрывают друг друга (больше при приближении).
  const dots = L.layerGroup().addTo(mapInst);
  const labels = L.layerGroup().addTo(mapInst);
  list.forEach((p) => {
    L.circleMarker([p.lat, p.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#1f5750', fillOpacity: 0.9 })
      .bindTooltip(p.name, { direction: 'top', offset: [0, -6] }).bindPopup(() => popupFor(p, offerFor(p))).addTo(dots);
  });
  const layout = () => {
    if (!mapInst) return;
    labels.clearLayers();
    const size = mapInst.getSize(); const taken = []; let n = 0;
    for (const p of list) {
      if (n >= 30) break;
      const pt = mapInst.latLngToContainerPoint([p.lat, p.lng]);
      if (pt.x < 0 || pt.y < 0 || pt.x > size.x || pt.y > size.y) continue;
      const name = p.name.length > 22 ? `${p.name.slice(0, 21)}…` : p.name;
      const w = 48 + name.length * 6.6; const r = { x1: pt.x - 16, y1: pt.y - 16, x2: pt.x - 16 + w, y2: pt.y + 16 };
      if (taken.some((q) => !(r.x2 + 6 < q.x1 || r.x1 - 6 > q.x2 || r.y2 + 4 < q.y1 || r.y1 - 4 > q.y2))) continue;
      taken.push(r); n += 1;
      const o = offerFor(p);
      const pill = document.createElement('div');
      pill.style.cssText = 'display:inline-flex;width:max-content;align-items:center;gap:4px;padding:3px 8px 3px 3px;border-radius:999px;background:var(--surface);border:1px solid var(--border);box-shadow:0 2px 8px rgb(0 0 0 / 15%);font:700 11px system-ui;color:var(--text)';
      const img = document.createElement('img'); img.alt = ''; img.src = photoFor(p, 80);
      img.style.cssText = 'width:22px;height:22px;border-radius:999px;object-fit:cover';
      const cnt = document.createElement('span'); cnt.style.color = 'var(--brand)'; cnt.textContent = String(o.left);
      pill.append(img, document.createTextNode(name), cnt);
      L.marker([p.lat, p.lng], { icon: L.divIcon({ html: pill, className: '', iconSize: null, iconAnchor: [14, 14] }), zIndexOffset: 1000 - n })
        .bindPopup(() => popupFor(p, o)).addTo(labels);
    }
  };
  mapInst.on('zoomend moveend', layout);
  mapInst.fitBounds(ring.getBounds(), { padding: [20, 20] });
  layout();
}

// --- аккаунт (демо: только в браузере) ---
function requireLogin(next) {
  if (getUser()) return true;
  sess.set('cs_next', next);
  location.hash = '#/login';
  return false;
}
function renderAuth(mode) {
  const isLogin = mode === 'login';
  root.innerHTML = `<main class="cs-auth">
    <section class="cs-auth-side">
      <a class="cs-brand cs-brand-light" href="#/feed">${LOGO_SVG}CrumbSave</a>
      <div class="cs-auth-copy"><h1>${t('a.heroTitle')}</h1><p>${t('a.heroSub')}</p></div>
      <ul><li><b>1</b>${t('a.pt1')}</li><li><b>2</b>${t('a.pt2')}</li><li><b>3</b>${t('a.pt3')}</li></ul>
    </section>
    <section class="cs-auth-form">
      <form id="auth" novalidate>
        <a class="cs-auth-back" href="#/feed">${icon('back', 'w-4 h-4')}${t('a.backToFeed')}</a>
        <h2>${t(isLogin ? 'a.login' : 'a.register')}</h2>
        <p class="cs-auth-switch">${t(isLogin ? 'a.noAccount' : 'a.haveAccount')} <a href="#/${isLogin ? 'register' : 'login'}">${t(isLogin ? 'a.toRegister' : 'a.toLogin')}</a></p>
        ${isLogin ? '' : `<label class="cs-field">${t('a.name')}<input name="name" autocomplete="name" placeholder="${t('a.namePh')}"></label>`}
        <label class="cs-field">${t('a.email')}<input name="email" type="email" autocomplete="email" placeholder="you@mail.kz"></label>
        <label class="cs-field">${t('a.password')}<input name="pw" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" placeholder="••••••••"></label>
        <p class="cs-auth-err" id="auth-err" role="alert"></p>
        <button type="submit" class="cs-auth-btn">${t(isLogin ? 'a.submitLogin' : 'a.submitRegister')}</button>
        <p class="cs-auth-note">${t('a.demoShort')}</p>
      </form>
    </section></main>`;
  const f = document.getElementById('auth');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = f.email.value.trim();
    const err = document.getElementById('auth-err');
    let msg = '';
    if (!isLogin && f.name.value.trim().length < 2) msg = t('a.errName');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) msg = t('a.errEmail');
    else if (f.pw.value.length < 4) msg = t('a.errPw');
    err.textContent = msg;
    if (msg) return;
    store.set('cs_user', { email, name: (f.name?.value || email.split('@')[0]).trim() });
    f.pw.value = '';
    const next = sess.get('cs_next', '#/feed'); sess.del('cs_next');
    location.hash = next;
  });
}

const LOGIN_BTN = 'inline-flex min-h-[48px] px-5 items-center rounded-[14px] bg-brand text-white font-bold text-sm';
function renderFavorites() {
  const user = getUser();
  let inner;
  if (!user) {
    inner = `<div class="px-6 pt-16 md:pt-4 space-y-4"><h3 class="text-xl font-bold text-ink">${t('f.loginTitle')}</h3><p class="text-sm text-sub">${t('f.loginText')}</p><a class="${LOGIN_BTN}" href="#/login" data-next="#/favorites">${t('login')}</a></div>`;
  } else {
    const list = getFavs().map(findPlace).filter(Boolean);
    inner = list.length
      ? `<div class="px-4 pb-6"><div class="grid gap-4 md:grid-cols-2 md:gap-5">${list.map((p) => placeCard(p)).join('')}</div></div>`
      : `<div class="px-6 pt-16 md:pt-4"><p class="text-sm text-sub">${t('f.empty')}</p></div>`;
  }
  shell(`<h2 class="px-4 pt-6 pb-3 md:pt-10 md:pb-6 text-2xl md:text-3xl font-extrabold text-ink">${t('f.title')}</h2>${inner}`, 'favorites', { maxw: user ? 'md:max-w-6xl' : 'md:max-w-4xl' });
}

function renderOrders() {
  const user = getUser();
  let inner;
  if (!user) {
    inner = `<div class="px-6 pt-16 md:pt-4 space-y-4"><h3 class="text-xl font-bold text-ink">${t('f.loginTitle')}</h3><p class="text-sm text-sub">${t('o.loginText')}</p><a class="${LOGIN_BTN}" href="#/login" data-next="#/orders">${t('login')}</a></div>`;
  } else {
    const orders = getOrders();
    inner = orders.length ? `<div class="px-4 pb-6 space-y-3"><h3 class="text-sm font-semibold text-sub">${t('o.active')}</h3>${orders.map((o) => `
      <a href="#/ticket/${esc(o.id)}" class="block bg-surface border border-line rounded-[18px] p-4 card-shadow space-y-1">
        <div class="flex items-center justify-between"><h4 class="font-bold text-ink">${esc(o.placeName)}</h4>${orderEnd(o) && orderEnd(o) < Date.now() ? `<span class="text-xs font-bold text-sub">${t('t.expired')}</span>` : `<span class="text-xs font-bold text-brand dark:text-emerald-300">${t('t.paid')}</span>`}</div>
        <p class="text-sm text-ink">${esc(tr(o.title))}</p>
        <p class="text-xs text-sub numeric">${esc(tr(o.window))} · ${fmtKzt(o.price + o.fee)}</p></a>`).join('')}</div>`
      : `<div class="px-6 pt-16 md:pt-4 space-y-4"><p class="text-sm text-sub">${t('o.empty')}</p><a class="${LOGIN_BTN}" href="#/feed">${t('nav.feed')}</a></div>`;
  }
  shell(`<h2 class="px-4 pt-6 pb-3 md:pt-10 md:pb-6 text-2xl md:text-3xl font-extrabold text-ink">${t('o.title')}</h2>${inner}`, 'orders', { maxw: 'md:max-w-4xl' });
}

function renderProfile() {
  const user = getUser();
  const dark = store.get('cs_dark', false);
  shell(`<h2 class="px-4 pt-6 pb-3 md:pt-10 md:pb-6 text-2xl md:text-3xl font-extrabold text-ink">${t('p.title')}</h2>
    <div class="px-4 pb-6 space-y-4">
      <div class="flex items-center gap-4 p-4 bg-surface border border-line rounded-[18px]">
        <div class="w-14 h-14 rounded-full bg-brand text-white font-extrabold flex items-center justify-center">${esc((user?.name || 'CS').slice(0, 2).toUpperCase())}</div>
        <div class="space-y-1"><h3 class="font-bold text-ink">${esc(user ? user.name : t('p.guest'))}</h3>
          ${user ? `<div class="text-sm text-sub">${t('p.saved', { n: getOrders().length })}</div><button class="text-sm font-semibold text-brand dark:text-emerald-300" data-action="logout">${t('logout')}</button>`
    : `<div class="flex gap-3 text-sm font-semibold text-brand dark:text-emerald-300"><a href="#/login">${t('login')}</a><a href="#/register">${t('register')}</a></div>`}</div></div>
      <div class="bg-surface border border-line rounded-[18px] divide-y divide-line">
        <div class="flex items-center justify-between gap-3 p-4"><div class="flex items-center gap-3"><div class="w-9 h-9 rounded-full bg-brand-soft text-brand dark:text-emerald-300 flex items-center justify-center">${icon('moon', 'w-4 h-4')}</div>
          <div><span class="block text-sm font-semibold text-ink">${t('p.dark')}</span><span class="block text-xs text-sub">${t('p.darkSub')}</span></div></div>
          <button class="px-3 h-9 rounded-full bg-muted text-xs font-bold text-ink" data-action="theme">${dark ? t('p.toLight') : t('p.toDark')}</button></div></div>
      <div class="bg-surface border border-line rounded-[18px] p-4 space-y-2 text-sm">
        <div class="flex justify-between"><span class="text-sub">${t('p.city')}</span><span class="font-semibold text-ink">${t('city')}</span></div>
        <div class="flex justify-between items-center"><span class="text-sub">${t('lang')}</span>${langSwitch()}</div>
        <p class="text-xs text-sub pt-2 border-t border-line">${t('p.about')}</p></div>
    </div>`, 'profile', { maxw: 'md:max-w-2xl' });
}

// --- заказ и оплата ---
const HOLD_MS = 10 * 60 * 1000;
function makeDraft(p) {
  const o = offerFor(p);
  return { id: newOrderId(), pin: newPin(), placeId: p.id, placeName: p.name, address: p.address, lat: p.lat, lng: p.lng, cat: p.cat,
    title: o.title, window: o.window, price: o.price, fee: o.fee, ref: o.ref, status: 'pending', createdAt: Date.now() };
}
const getDraft = (placeId) => { const d = sess.get('cs_draft', null); return d && d.placeId === placeId ? d : null; };

const KASPI_RED = '#d92d20';
const kaspiLogo = (cls = 'w-5 h-5') => `<img alt="" class="${cls}" src="vendor/kaspi-logo.png" style="border-radius:22%">`;

async function renderCheckout(id) {
  const p = findPlace(id);
  if (!p) { placeMissing(id); return; }
  if (!requireLogin(`#/checkout/${id}`)) return;
  const o = offerFor(p);
  let order = getDraft(id);
  if (!order || Date.now() - order.createdAt > HOLD_MS) {
    if (!o.left) { location.hash = `#/place/${id}`; return; }
    order = makeDraft(p);
  }
  sess.set('cs_draft', order);
  const total = order.price + order.fee;
  root.innerHTML = `<main class="mx-auto max-w-[430px] md:max-w-none min-h-dvh bg-canvas relative shadow-2xl md:shadow-none">${headerHtml('feed')}
    <div class="min-h-dvh md:min-h-0 flex flex-col md:max-w-xl md:mx-auto md:py-8">
      <div class="flex items-center gap-3 px-4 pt-4 pb-3">
        <button aria-label="${t('back')}" data-action="back" class="w-11 h-11 rounded-full bg-surface border border-line flex items-center justify-center text-ink">${icon('back', 'w-5 h-5')}</button>
        <div class="min-w-0"><h2 class="font-bold text-ink">${t('c.title')}</h2><p class="text-xs text-sub truncate">${esc(order.placeName)}${order.address ? ` • ${esc(order.address)}` : ''}</p></div>
      </div>
      <div class="bg-brand-soft px-4 py-2 md:rounded-xl flex items-center justify-between text-xs">
        <span class="flex items-center gap-2 font-semibold text-ink"><span class="w-2 h-2 rounded-full bg-brand pulse-dot"></span> ${t('c.held')}</span>
        <span class="flex items-center gap-1 font-bold text-brand dark:text-emerald-300 numeric">${icon('clock', 'w-3.5 h-3.5')} <span id="hold">10:00</span></span>
      </div>
      <div class="flex-1 p-4 space-y-4 pb-40 md:pb-4">
        <div class="flex gap-3 items-center">
          <img alt="" class="w-16 h-16 rounded-xl object-cover bg-muted" src="${esc(photoFor({ id: order.placeId, cat: order.cat }, 200))}">
          <div class="min-w-0"><h5 class="font-bold text-ink">${esc(tr(order.title))}</h5><p class="text-xs text-sub truncate">${t('qty1')} · ${esc(order.placeName)}</p><p class="text-xs text-sub">${esc(t('c.pickupAt', { window: tr(order.window) }))}</p></div>
        </div>
        <div class="bg-surface border border-line rounded-[18px] overflow-hidden">
          <div class="flex justify-between items-center px-4 py-3 border-b border-line"><span class="text-sm font-bold text-ink">${t('c.method')}</span>
            <span class="flex items-center gap-1 text-[11px] font-semibold text-brand dark:text-emerald-300">${icon('shield', 'w-3.5 h-3.5')} ${t('c.zeroFee')}</span></div>
          <div class="flex items-center gap-3 px-4 py-3.5">
            <span class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:#fdeceb">${kaspiLogo('w-6 h-6')}</span>
            <span class="flex-1 min-w-0"><span class="block text-sm font-semibold text-ink">Kaspi Pay</span><span class="block text-[11px] text-sub">${t('c.kaspiSub')}</span></span>
            <span class="w-6 h-6 rounded-full bg-brand text-white flex items-center justify-center">${icon('check', 'w-3.5 h-3.5')}</span>
          </div>
          <div class="px-4 pb-3.5"><div class="flex items-start gap-2 rounded-xl bg-muted px-3 py-2.5 text-[11px] text-sub">${icon('qr', 'w-4 h-4 shrink-0 text-ink')}<span>${t('c.kaspiHow')}</span></div></div>
        </div>
        <div class="space-y-2 text-sm">
          <div class="flex justify-between text-sub"><span>${t('c.subtotal')} (1 шт.)</span><span class="numeric">${fmtKzt(order.price)}</span></div>
          <div class="flex justify-between text-sub"><span>${t('c.fee')}</span><span class="numeric">${fmtKzt(order.fee)}</span></div>
          <div class="flex justify-between pt-2 border-t border-line font-extrabold text-ink text-base"><span>${t('c.total')}</span><span class="numeric">${fmtKzt(total)}</span></div>
          ${order.ref ? `<div class="flex justify-between text-brand dark:text-emerald-300 font-semibold"><span>${t('c.saving')}</span><span class="numeric">${fmtKzt(order.ref - order.price)}</span></div>` : ''}
          <p class="text-xs text-sub">${t('l.cancelVal')}</p>
        </div>
      </div>
      <div class="fixed md:static bottom-0 inset-x-0 mx-auto max-w-[430px] md:max-w-none bg-surface md:bg-transparent border-t md:border-0 border-line p-4 pb-6 space-y-2 z-20" id="pay-body">
        <button class="w-full min-h-[52px] rounded-[14px] px-4 font-bold text-sm text-white flex items-center justify-between kaspi-btn" style="background:${KASPI_RED}" data-action="kaspi">
          <span class="flex items-center gap-2"><span class="w-6 h-6 rounded-md bg-white flex items-center justify-center">${kaspiLogo('w-5 h-5')}</span>${t('c.kaspiOpen')} · <span class="numeric">${fmtKzt(total)}</span></span>${icon('arrowR', 'w-4 h-4')}</button>
        <p class="text-center text-[11px] text-sub">${t('c.offer')}</p>
      </div>
    </div></main>`;
  const tick = () => {
    const left = HOLD_MS - (Date.now() - order.createdAt);
    const el = document.getElementById('hold');
    if (!el) return;
    if (left <= 0) {
      clearInterval(timer); sess.del('cs_draft'); document.querySelector('.kaspi-modal')?.remove();
      el.textContent = '00:00';
      document.getElementById('pay-body').innerHTML = `<div class="rounded-[14px] bg-urgent-soft text-urgent text-sm font-semibold p-3">${t('c.expired')}</div><a class="${BTN_PRIMARY}" href="#/place/${esc(id)}">${t('c.toListing')}</a>`;
      return;
    }
    el.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  };
  clearInterval(timer); tick(); timer = setInterval(tick, 1000);
}

function openKaspi() {
  const order = sess.get('cs_draft', null);
  if (!order) return;
  const total = order.price + order.fee;
  const m = document.createElement('div');
  m.className = 'kaspi-modal';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Kaspi QR');
  m.innerHTML = `<div class="kaspi-card">
    <div class="kaspi-head" style="background:${KASPI_RED}">
      <button class="kaspi-x" data-close aria-label="${t('back')}">✕</button>
      <div class="flex items-center gap-2 text-white font-bold"><span class="w-7 h-7 rounded-lg bg-white flex items-center justify-center">${kaspiLogo('w-5 h-5')}</span>Kaspi QR</div>
      <p class="text-white text-xs" style="opacity:.85">${esc(CFG.kaspiMerchant || '')}</p>
      <p class="text-white text-3xl font-extrabold numeric">${fmtKzt(total)}</p>
    </div>
    <div class="p-5 space-y-4">
      <div class="kaspi-qr"><img src="${CFG.kaspiQrImage || 'vendor/kaspi-qr.png'}" alt="Kaspi QR ${esc(CFG.kaspiMerchant || '')}" width="240" height="274"></div>
      <div class="grid gap-2 text-xs" style="grid-template-columns:repeat(3,1fr)">
        ${[t('c.step1'), t('c.step2', { sum: `<span style="white-space:nowrap">${fmtKzt(total)}</span>` }), t('c.step3')].map((x, i) => `<div class="rounded-xl bg-muted p-2.5 text-center"><span class="mx-auto mb-1 w-5 h-5 rounded-full bg-ink text-canvas text-[10px] font-bold flex items-center justify-center">${i + 1}</span><span class="text-sub">${x}</span></div>`).join('')}
      </div>
      <p class="text-[11px] text-sub text-center numeric">${esc(t('c.kaspiComment', { n: order.id }))}</p>
      <div class="flex items-center justify-center gap-2 text-xs font-semibold text-sub"><span class="w-2 h-2 rounded-full pulse-dot" style="background:${KASPI_RED}"></span>${t('c.waiting')}</div>
      <button class="${BTN_PRIMARY}" data-paid>${t('c.paidArrived')}</button>
    </div></div>`;
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) close();
    else if (e.target.closest('[data-paid]')) {
      const card = m.querySelector('.kaspi-card');
      card.innerHTML = `<div class="pay-status" role="status" aria-live="polite">
        <div class="pay-anim"><svg viewBox="0 0 80 80" aria-hidden="true"><circle class="pay-ring" cx="40" cy="40" r="34"/><path class="pay-tick" d="M25 41l10 10 20-22"/></svg></div>
        <p class="pay-title">${t('c.processing')}</p>
        <p class="pay-sub numeric">${fmtKzt(total)} · Kaspi · ${esc(CFG.kaspiMerchant || '')}</p></div>`;
      const st = card.querySelector('.pay-status');
      setTimeout(() => {
        st.classList.add('done');
        st.querySelector('.pay-title').textContent = t('c.success');
        if (navigator.vibrate) navigator.vibrate(30);
      }, 1800);
      setTimeout(() => { close(); markPaid(order); }, 3300);
      m.onclick = null; m.style.pointerEvents = 'none';
    }
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(m);
  m.querySelector('[data-paid]').focus();
}

// Конец окна выдачи заказа: «Сегодня 21:00–22:00» → дата создания + 22:00 (или +1 день для «Завтра»).
function orderEnd(o) {
  const m = String(o.window || '').match(/(\d{1,2}):(\d{2})\s*$/);
  if (!m) return 0;
  const d = new Date(o.createdAt || Date.now());
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (/Завтра|Tomorrow|Ертең/.test(o.window)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function openHelp() {
  const m = document.createElement('div');
  m.className = 'kaspi-modal';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', t('t.help'));
  m.innerHTML = `<div class="kaspi-card" style="padding:24px!important;gap:14px!important">
    <button class="kaspi-x" data-close aria-label="${t('back')}">✕</button>
    <h3 class="text-xl font-extrabold text-ink">${t('h.title')}</h3>
    <ul class="space-y-3 text-sm text-sub" style="list-style:disc;padding-left:18px">
      <li>${t('h.q1')}</li><li>${t('h.q2')}</li><li>${t('h.q3')}</li><li>${t('h.q4')}</li></ul>
    <button class="${BTN_PRIMARY}" data-close>${t('h.ok')}</button></div>`;
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(m);
  m.querySelector('.kaspi-x').focus();
}

function saveOrder(o) {
  store.set('cs_orders', getOrders().map((x) => (x.id === o.id ? o : x)));
}

function markPaid(order) {
  const fresh = findPlace(order.placeId);
  if (!order.address) order.address = fresh?.address || addrCache[order.placeId]?.a || '';
  const orders = getOrders().filter((o) => o.id !== order.id);
  orders.unshift({ ...order, status: 'paid' });
  store.set('cs_orders', orders.slice(0, 50));
  const sold = getSold(); sold[order.placeId] = (sold[order.placeId] || 0) + 1; store.set('cs_sold', sold);
  const p = findPlace(order.placeId); if (p) persistPlace(p);
  sess.del('cs_draft');
  location.hash = `#/ticket/${order.id}`;
}

async function renderTicket(id) {
  const o = getOrders().find((x) => x.id === id);
  if (!o) { shell(`<div class="px-6 pt-16 space-y-4"><p class="text-sm text-sub">${t('t.notFound')}</p><a class="${LOGIN_BTN}" href="#/feed">${t('nav.feed')}</a></div>`, 'orders', { maxw: 'md:max-w-2xl' }); return; }
  if (!o.address) {
    const known = findPlace(o.placeId)?.address || addrCache[o.placeId]?.a;
    if (known) { o.address = known; saveOrder(o); }
    else if (!addrCache[o.placeId] && o.lat) {
      const tmp = { id: o.placeId, lat: o.lat, lng: o.lng, address: '' };
      resolveAddresses([tmp], 70, false).then(() => {
        if (tmp.address) { o.address = tmp.address; saveOrder(o); if (location.hash === `#/ticket/${o.id}`) route(); }
      }).catch(() => {});
    }
  }
  const expired = orderEnd(o) && orderEnd(o) < Date.now();
  const steps = [t('t.paid'), t('t.ready'), t('t.done')];
  const step = (i) => {
    const circle = i === 0 ? `<div class="w-8 h-8 rounded-full flex items-center justify-center bg-brand text-white">${icon('check', 'w-4 h-4')}</div>`
      : i === 1 ? '<div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 border-brand text-brand dark:text-emerald-300">2</div>'
        : '<div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold bg-muted text-sub">3</div>';
    return `<div class="flex flex-col items-center gap-1">${circle}<span class="text-[11px] font-semibold ${i < 2 ? 'text-ink' : 'text-sub'}">${steps[i]}</span></div>`;
  };
  root.innerHTML = `<main class="mx-auto max-w-[430px] md:max-w-none min-h-dvh bg-canvas relative shadow-2xl md:shadow-none">${headerHtml('orders')}
    <div class="min-h-dvh md:min-h-0 md:max-w-xl md:mx-auto md:py-8">
      <div class="flex items-center justify-between px-4 pt-4">
        <a aria-label="${t('back')}" href="#/orders" class="w-11 h-11 rounded-full bg-surface border border-line flex items-center justify-center text-ink">${icon('x', 'w-5 h-5')}</a>
        <span class="text-xs font-bold tracking-widest text-sub numeric">${esc(t('t.order', { n: o.id }).toUpperCase())}</span>
        <button type="button" data-action="help" class="text-sm font-semibold text-brand dark:text-emerald-300 min-h-[44px] flex items-center">${t('t.help')}</button>
      </div>
      <div class="p-4 space-y-4">
        <div class="flex items-center px-2">${step(0)}<div class="flex-1 h-0.5 mx-1 mb-5 bg-brand"></div>${step(1)}<div class="flex-1 h-0.5 mx-1 mb-5 bg-line"></div>${step(2)}</div>
        <div class="relative bg-surface border border-line rounded-[24px] p-5 space-y-4 card-shadow ticket">
          <div class="flex items-center justify-between gap-2">
            ${expired ? `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-muted text-sub">${t('t.expired')}</span>` : `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-brand-soft text-brand dark:text-emerald-300"><span class="w-1.5 h-1.5 rounded-full bg-current pulse-dot"></span> ${t('t.canPick')}</span>`}
            <span class="inline-flex items-center gap-1 text-[11px] font-semibold text-sub">${kaspiLogo('w-3.5 h-3.5')} Kaspi · <span class="numeric">${fmtKzt(o.price + o.fee)}</span></span>
          </div>
          <div><h3 class="text-xl font-extrabold text-ink">${esc(o.placeName)}</h3><p class="text-sm text-sub">${o.address ? `${esc(o.address)} · ` : ''}${esc(t('city'))}</p></div>
          <div class="flex justify-between items-center gap-3 p-3 rounded-xl bg-muted text-sm"><span class="font-semibold text-ink numeric">${esc(t('t.window', { w: tr(o.window) }))}</span><span class="text-sub text-right">${esc(tr(o.title))}</span></div>
          <div class="ticket-cut"></div>
          <div class="flex justify-center"><div class="p-3 bg-white rounded-2xl qr" style="width:224px" id="tqr" aria-label="QR">…</div></div>
          <div class="flex justify-center items-baseline gap-2"><span class="text-sm text-sub">${t('t.staff')}</span><span class="text-2xl font-extrabold text-ink numeric" style="letter-spacing:.3em">${esc(o.pin)}</span></div>
          <p class="text-center text-xs text-sub">${t('t.show')}</p>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <a href="${esc(twoGisUrl(o.placeName, o.lat, o.lng, o.address))}" data-route-id="${esc(o.placeId)}" data-route-name="${esc(o.placeName)}" data-route-lat="${o.lat}" data-route-lng="${o.lng}" data-route-addr="${esc(o.address || '')}" target="_blank" rel="noopener noreferrer" class="min-h-[48px] rounded-[14px] bg-surface border border-line text-ink font-bold text-sm flex items-center justify-center gap-2">${icon('nav', 'w-4 h-4')} ${t('l.route')}</a>
          <a href="#/feed" class="min-h-[48px] rounded-[14px] bg-brand hover:bg-brand-hover text-white font-bold text-sm flex items-center justify-center gap-2">${t('t.more')}</a>
        </div>
      </div>
    </div></main>`;
  try { const q = await qrSvg(`CRUMBSAVE|${o.id}|${o.pin}`); const el = document.getElementById('tqr'); if (el) el.innerHTML = q; }
  catch { const el = document.getElementById('tqr'); if (el) el.textContent = o.pin; }
}

function renderPay(payload) {
  try {
    const o = unpackOrder(b64urlDecode(payload));
    if (!getOrders().some((x) => x.id === o.id)) store.set('cs_orders', [o, ...getOrders()].slice(0, 50));
    location.replace(`#/ticket/${o.id}`);
  } catch {
    shell(`<div class="px-6 pt-16 space-y-4"><p class="text-sm text-error">${t('pay.bad')}</p><a class="${LOGIN_BTN}" href="#/feed">${t('nav.feed')}</a></div>`, 'feed');
  }
}

// ---------- ленивые библиотеки ----------
const loadedScripts = {};
function loadScript(src) {
  if (!loadedScripts[src]) {
    loadedScripts[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src)); document.head.appendChild(s);
    });
  }
  return loadedScripts[src];
}
async function qrSvg(text, level = 'M') {
  await loadScript('vendor/qrcode.js');
  const qr = window.qrcode(0, level); qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function toast(msg) {
  const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 2200);
}

// ---------- роутер ----------
let lastHash = null;
let navDepth = 0; // сколько переходов сделано внутри сайта (для кнопки «Назад»)
function route() {
  renderGen += 1;
  const hash = location.hash || '#/feed';
  const [name, arg] = hash.replace(/^#\/?/, '').split('/');
  const view = name || 'feed';
  if (mapInst) { mapInst.remove(); mapInst = null; }
  if (view !== 'checkout') clearInterval(timer);
  document.querySelector('.kaspi-modal')?.remove();
  if (view === 'feed') { renderFeed(); init(); }
  else if (view === 'map') renderMap();
  else if (view === 'place') renderPlace(arg);
  else if (view === 'checkout') renderCheckout(arg);
  else if (view === 'ticket') renderTicket(arg);
  else if (view === 'orders') renderOrders();
  else if (view === 'favorites') renderFavorites();
  else if (view === 'profile') renderProfile();
  else if (view === 'login') renderAuth('login');
  else if (view === 'register') renderAuth('register');
  else if (view === 'pay') renderPay(arg || '');
  else { location.hash = '#/feed'; return; }
  if (hash !== lastHash) { window.scrollTo(0, 0); lastHash = hash; }
}

// ---------- события ----------
root.addEventListener('click', async (e) => {
  const rt = e.target.closest('[data-route-id]');
  if (rt) {
    const r = rt.dataset;
    const known = r.routeAddr || findPlace(r.routeId)?.address || addrCache[r.routeId]?.a;
    if (known || addrCache[r.routeId]) return; // адрес уже есть (или точно не найден) — обычная ссылка
    e.preventDefault();
    const w = window.open('about:blank', '_blank');
    const tmp = { id: r.routeId, lat: Number(r.routeLat), lng: Number(r.routeLng), address: '' };
    try { await Promise.race([resolveAddresses([tmp], 70, false), sleep(4000)]); } catch { /* ignore */ }
    const url = twoGisUrl(r.routeName, tmp.lat, tmp.lng, tmp.address || addrCache[r.routeId]?.a || '');
    if (w) { try { w.opener = null; } catch { /* ignore */ } w.location.href = url; } else location.href = url;
    return;
  }
  const tEl = e.target.closest('[data-action],[data-cat],[data-tab],[data-fav],[data-lang],[data-radius],[data-district],[data-next]');
  if (!tEl) {
    if (state.popOpen && !e.target.closest('.geo-pop')) { state.popOpen = false; refresh(); }
    return;
  }
  const d = tEl.dataset;
  if (d.next) { sess.set('cs_next', d.next); return; }
  if (d.cat) { state.cat = d.cat; state.shown = 24; renderFeed(); return; }
  if (d.tab) { sess.set('cs_paytab', d.tab); route(); return; }
  if (d.lang) { setLang(d.lang); return; }
  if (d.radius) { state.radius = Number(d.radius); sess.set('cs_radius', state.radius); state.popOpen = false; loadPlaces().then(() => { if (state.status === 'ready') toast(t('feed.count', { n: state.places.length, r: state.radius / 1000 })); }); return; }
  if (d.district !== undefined) { setDistrict(d.district); state.popOpen = false; loadPlaces(); return; }
  if (d.fav) {
    e.preventDefault();
    if (!requireLogin(location.hash)) return;
    const favs = getFavs(); const i = favs.indexOf(d.fav);
    if (i >= 0) favs.splice(i, 1); else { favs.push(d.fav); const p = findPlace(d.fav); if (p) persistPlace(p); }
    store.set('cs_favs', favs); route(); return;
  }
  switch (d.action) {
    case 'pop': state.popOpen = !state.popOpen; refresh(); break;
    case 'locate': state.popOpen = false; if (await locate()) loadPlaces(); else refresh(); break;
    case 'retry': loadPlaces(); break;
    case 'reload': route(); break;
    case 'hide-geo': state.geoMsg = ''; refresh(); break;
    case 'more': state.shown += 24; renderFeed(); enrichFeedAddresses(); break;
    case 'search': state.searchOpen = !state.searchOpen; if (!state.searchOpen) state.q = ''; renderFeed(); break;
    case 'back': if (navDepth > 0) history.back(); else location.hash = '#/feed'; break;
    case 'share': {
      const url = location.href;
      const copy = async () => {
        try { await navigator.clipboard.writeText(url); }
        catch {
          const ta = document.createElement('textarea'); ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
        }
        toast(t('copied'));
      };
      const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (touch && navigator.share) {
        try { await navigator.share({ url, title: 'CrumbSave' }); } catch (err) { if (err && err.name !== 'AbortError') await copy(); }
      } else await copy();
      break;
    }
    case 'book': if (requireLogin(`#/checkout/${d.id}`)) location.hash = `#/checkout/${d.id}`; break;
    case 'kaspi': openKaspi(); break;
    case 'help': openHelp(); break;
    case 'confirm-qr': { const dr = sess.get('cs_draft', null); if (dr) markPaid(dr); break; }
    case 'logout': store.del('cs_user'); route(); break;
    case 'theme': store.set('cs_dark', !store.get('cs_dark', false)); applyTheme(); route(); break;
    default: break;
  }
});
root.addEventListener('input', (e) => {
  if (e.target.id === 'q') { state.q = e.target.value; renderFeed(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.popOpen) { state.popOpen = false; refresh(); } });
window.addEventListener('hashchange', () => { navDepth += 1; route(); });

route();
