import {
  ALMATY, DISTRICTS, esc, fmtDist, fmtKzt, luhn, validExpiry, OVERPASS_ENDPOINTS, overpassQuery,
  parseElements, twoGisUrl, osmUrl, demoOffer, newOrderId, newPin, b64urlEncode, b64urlDecode,
  packOrder, unpackOrder, photoFor, logoText,
} from './lib.js?v=20261116c';
import { DICT } from './i18n.js?v=20261116c';

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
function locate() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { state.geoMsg = t('geo.unsupported'); return resolve(false); }
    state.geoBusy = true; state.geoMsg = ''; refresh();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.source = 'gps'; state.district = '';
        sess.set('cs_loc', state.loc); sess.set('cs_src', 'gps'); sess.set('cs_district', '');
        state.geoBusy = false; resolve(true);
      },
      (err) => { state.geoMsg = geoErrorText(err); state.geoBusy = false; resolve(false); },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
    );
  });
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
function fetchOverpass(loc, radius) {
  const body = `data=${encodeURIComponent(overpassQuery(loc.lat, loc.lng, radius))}`;
  const pre = window.__csPrefetch;
  const ctls = [];
  const one = (ep, delay) => new Promise((resolve, reject) => {
    const ctl = new AbortController(); ctls.push(ctl);
    const start = setTimeout(async () => {
      const to = setTimeout(() => ctl.abort(), 15000);
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
  if (pre && pre.body === body) racers.unshift(pre.promise.then((els) => els || Promise.reject(new Error('prefetch'))));
  return Promise.any(racers).then((els) => {
    ctls.forEach((c) => c.abort());
    const trimmed = els.map((e) => ({ type: e.type, id: e.id, lat: e.lat, lon: e.lon, center: e.center, tags: e.tags }));
    store.set(ovKey(loc, radius), { t: Date.now(), els: trimmed });
    return trimmed;
  });
}
async function loadPlaces() {
  const token = ++loadToken;
  const cached = cachedOverpass(state.loc, state.radius);
  if (cached) {
    // мгновенно показываем кэш, затем тихо обновляем
    state.places = parseElements(cached, state.loc); rememberPlaces(state.places); state.status = 'ready'; refresh();
  } else { state.status = 'loading'; refresh(); }
  try {
    const els = await fetchOverpass(state.loc, state.radius);
    if (token !== loadToken) return;
    state.places = parseElements(els, state.loc);
    rememberPlaces(state.places);
    state.status = 'ready';
  } catch {
    if (token !== loadToken) return;
    if (!cached) state.status = 'error';
  }
  refresh();
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

function headerHtml(active) {
  const nav = [['feed', 'compass', 'nav.feed'], ['map', 'map', 'nav.map'], ['favorites', 'heart', 'nav.fav'], ['orders', 'bag', 'nav.orders']];
  const user = getUser();
  return `<header class="hidden md:block sticky top-0 z-30 h-16 border-b border-line bg-surface/90 backdrop-blur-xl">
    <div class="max-w-6xl mx-auto h-full px-6 flex items-center gap-8">
      <a class="flex items-center gap-2 font-extrabold text-lg text-ink" href="#/feed"><img alt="" class="w-9 h-9" src="logo.svg" width="36" height="36">CrumbSave</a>
      <nav class="flex items-center gap-1 flex-1">
        ${nav.map(([k, ic, key]) => `<a ${active === k ? 'aria-current="page"' : ''} class="relative flex items-center gap-2 h-10 px-4 rounded-full text-sm font-semibold transition ${active === k ? 'bg-brand-soft text-brand dark:text-emerald-300' : 'text-sub hover:text-ink hover:bg-muted'}" href="#/${k}">${icon(ic, 'w-[18px] h-[18px]')}${t(key)}</a>`).join('')}
      </nav>
      ${langSwitch()}
      <div class="flex items-center gap-2">
        <a class="h-10 px-4 rounded-full text-sm font-semibold text-sub hover:text-ink flex items-center" href="#/profile">${t('settings')}</a>
        ${user
    ? `<a class="h-10 px-5 rounded-full bg-brand hover:bg-brand-hover text-white text-sm font-bold flex items-center" href="#/profile">${esc(user.name || user.email.split('@')[0])}</a>`
    : `<a class="h-10 px-5 rounded-full bg-brand hover:bg-brand-hover text-white text-sm font-bold flex items-center" href="#/login">${t('login')}</a>`}
      </div>
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

function placeCard(p, eager) {
  const o = offerFor(p);
  const lowCls = o.left <= 1 ? 'bg-urgent-soft text-urgent' : 'bg-surface/95 text-ink';
  const fav = isFav(p.id);
  return `<div class="relative bg-surface rounded-[18px] border border-line card-shadow overflow-hidden md:hover:-translate-y-0.5 md:hover:shadow-lg transition">
    <a class="block" href="#/place/${esc(p.id)}">
      <div class="relative aspect-[16/10] bg-muted">
        <img alt="${esc(o.title)}" class="w-full h-full object-cover" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" width="640" height="400" src="${esc(photoFor(p))}">
        <span class="absolute left-3 bottom-3 px-2.5 py-1 rounded-full text-[11px] font-bold ${lowCls}">${esc(leftText(o.left))}</span>
        <span class="absolute left-3 top-2 mt-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-ink text-canvas">${t('demo')}</span>
      </div>
      <div class="p-4 space-y-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 shrink-0 rounded-full bg-brand-soft text-brand dark:text-emerald-300 text-[10px] font-extrabold flex items-center justify-center">${esc(logoText(p.name))}</div>
          <div class="min-w-0">
            <div class="flex items-center gap-2"><h4 class="font-bold text-[15px] text-ink truncate">${esc(p.name)}</h4>
              ${p.distance != null ? `<span class="flex items-center gap-0.5 text-xs font-semibold text-ink shrink-0">${icon('pin', 'w-3 h-3')} ${esc(fmtDist(p.distance))}</span>` : ''}</div>
            <p class="text-xs text-sub truncate">${esc(p.kind)}${p.address ? ` · ${esc(p.address)}` : ''}</p>
          </div>
        </div>
        <p class="text-sm text-ink">${esc(o.title)}</p>
        <div class="flex items-end justify-between">
          <div class="flex items-center gap-1.5 text-xs text-sub">${icon('clock', 'w-3.5 h-3.5')}<span class="numeric">${esc(o.window)}</span></div>
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
  if (state.source === 'district') return state.district;
  return t('city');
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
    ${DISTRICTS.map((d) => `<button data-district="${esc(d.id)}">${icon('pin', 'w-4 h-4 text-sub')}<span>${d.id === 'center' ? t('geo.center') : esc(d.id)}</span></button>`).join('')}
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
  const list = state.places.filter((p) => (state.cat === 'all' || p.cat === state.cat) && (!q || p.name.toLowerCase().includes(q)));
  let body;
  if (state.status === 'loading' || state.status === 'idle') body = `<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 md:gap-5">${skeletonCards()}</div>`;
  else if (state.status === 'error') body = `<div class="bg-urgent-soft text-urgent rounded-[18px] p-4 text-sm font-semibold flex items-center justify-between gap-3" role="alert"><span>${t('load.error')}</span><button class="h-9 px-4 rounded-full bg-surface text-ink border border-line" data-action="retry">${t('retry')}</button></div>`;
  else if (!list.length) body = `<div class="text-center space-y-2 pt-10"><h3 class="text-xl font-bold text-ink">${t('empty.title')}</h3><p class="text-sm text-sub">${t('empty.text')}</p></div>`;
  else body = `<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 md:gap-5">${list.slice(0, 60).map((p, i) => placeCard(p, i < 3)).join('')}</div>`;
  shell(`
    ${cityRow(true)}
    ${state.searchOpen ? `<div class="px-4 pb-2"><input id="q" class="input" placeholder="${t('searchPh')}" value="${esc(state.q)}" aria-label="${t('search')}"></div>` : ''}
    ${state.geoMsg ? `<div class="px-4 pb-2"><div class="bg-urgent-soft text-urgent rounded-[14px] px-4 py-2 text-sm font-semibold" role="alert">${esc(state.geoMsg)}</div></div>` : ''}
    <div class="flex gap-2 px-4 py-2 overflow-x-auto no-scrollbar">
      ${cats.map((c) => `<button aria-pressed="${state.cat === c}" data-cat="${c}" class="shrink-0 h-9 px-4 rounded-full text-[13px] font-semibold border transition ${state.cat === c ? 'bg-ink text-canvas border-ink' : 'bg-surface text-ink border-line'}">${t(`cat.${c}`)}</button>`).join('')}
    </div>
    <div class="px-4 pb-6 md:pb-12 space-y-4">
      <div class="flex items-baseline justify-between pt-2"><h3 class="text-lg md:text-2xl font-bold text-ink">${t('feed.today')}</h3><span class="text-xs md:text-sm text-sub">${t('feed.until')}</span></div>
      ${body}
    </div>`, 'feed');
  const qi = document.getElementById('q');
  if (qi && state.searchOpen) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
}

const INSIDE = { bakery: 'l.insideText.bakery', ready: 'l.insideText.ready', groceries: 'l.insideText.groceries' };
function renderPlace(id) {
  const p = findPlace(id);
  if (!p) { location.hash = '#/feed'; return; }
  const o = offerFor(p);
  const phone = p.phone ? p.phone.replace(/[^\d+]/g, '') : '';
  const fav = isFav(p.id);
  root.innerHTML = `<main class="mx-auto max-w-[430px] md:max-w-none min-h-dvh bg-canvas relative shadow-2xl md:shadow-none">
    ${headerHtml('feed')}
    <div class="min-h-dvh md:min-h-0 flex flex-col md:grid md:grid-cols-[1.1fr_1fr] md:gap-10 md:items-start md:max-w-6xl md:mx-auto md:px-6 md:py-8">
      <div class="relative h-[260px] md:h-[520px] bg-muted md:rounded-[28px] md:overflow-hidden md:sticky md:top-24">
        <img alt="${esc(o.title)}" class="w-full h-full object-cover" fetchpriority="high" decoding="async" src="${esc(photoFor(p, 1000))}">
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
            <div class="flex items-center gap-1.5 text-sm text-sub"><span class="font-semibold text-ink">${esc(p.name)}</span>·<span>${esc(p.kind)}</span>${p.distance != null ? `·<span class="flex items-center gap-0.5">${icon('pin', 'w-3 h-3')} ${esc(fmtDist(p.distance))}</span>` : ''}</div>
            <h2 class="text-2xl md:text-4xl font-extrabold text-ink">${esc(o.title)}</h2>
            <p class="flex items-center gap-1 text-sm text-sub">${icon('pin', 'w-4 h-4 shrink-0')} ${p.address ? esc(p.address) : esc(t('l.noAddress'))}</p>
            <p class="text-sm font-semibold text-sub">${esc(leftText(o.left))} · <span class="text-urgent">${t('demo')}</span></p>
          </div>
          <div class="flex items-center justify-between p-4 rounded-[18px] bg-brand-soft">
            <div><span class="text-xs font-semibold uppercase tracking-wide text-brand dark:text-emerald-300">${t('l.pickup')}</span>
              <p class="text-lg font-bold text-ink numeric">${esc(o.window.replace(' ', ', '))}</p><p class="text-xs text-sub">${t('l.pickupHint')}</p></div>
            ${icon('clock', 'w-7 h-7 text-brand dark:text-emerald-300')}
          </div>
          <div><h4 class="font-bold text-ink mb-1">${t('l.inside')}</h4><p class="text-sm text-sub leading-relaxed">${t(INSIDE[p.cat] || INSIDE.ready)}</p></div>
          ${p.hours ? `<p class="text-sm"><span class="font-semibold text-ink">${t('l.hours')}</span><span class="text-sub">${esc(p.hours)}</span></p>` : ''}
          <p class="text-sm"><span class="font-semibold text-ink">${t('l.allergens')}</span><span class="text-sub">${t('l.allergensVal')}</span></p>
          <p class="text-sm"><span class="font-semibold text-ink">${t('l.cancel')}</span><span class="text-sub">${t('l.cancelVal')}</span></p>
          <p class="text-xs text-sub">${t('l.demoNote')}</p>
          <div class="flex items-center justify-between pt-4 border-t border-line gap-3">
            <div class="min-w-0"><p class="text-sm font-semibold text-ink">${p.address ? esc(p.address) : '—'}</p><p class="text-xs text-sub">${esc(p.name)}</p></div>
            <a href="${esc(twoGisUrl(p.name, p.lat, p.lng))}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-1.5 text-sm font-bold text-brand dark:text-emerald-300 min-h-[44px] shrink-0">${icon('nav', 'w-4 h-4')} ${t('l.route')}</a>
          </div>
          <div class="flex items-center gap-4 text-sm font-semibold text-brand dark:text-emerald-300 flex-wrap">
            <a class="min-h-[44px] flex items-center" href="${esc(osmUrl(p.id, p.lat, p.lng))}" target="_blank" rel="noopener noreferrer">${t('l.osm')}</a>
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
    ${state.geoMsg ? `<div class="px-4 pb-2"><div class="bg-urgent-soft text-urgent rounded-[14px] px-4 py-2 text-sm font-semibold" role="alert">${esc(state.geoMsg)}</div></div>` : ''}
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
  mapInst = L.map(el).setView([c.lat, c.lng], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(mapInst);
  const pts = [[c.lat, c.lng]];
  if (state.source === 'gps') {
    L.circleMarker([c.lat, c.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(mapInst).bindTooltip(t('near'));
  }
  state.places.slice(0, 120).forEach((p) => {
    const o = offerFor(p);
    const pill = document.createElement('div');
    pill.style.cssText = 'display:inline-flex;width:max-content;align-items:center;gap:4px;padding:3px 8px 3px 3px;border-radius:999px;background:var(--surface);border:1px solid var(--border);box-shadow:0 2px 8px rgb(0 0 0 / 15%);font:700 11px system-ui;color:var(--text)';
    const img = document.createElement('img'); img.alt = ''; img.src = photoFor(p, 80); img.loading = 'lazy';
    img.style.cssText = 'width:22px;height:22px;border-radius:999px;object-fit:cover';
    const cnt = document.createElement('span'); cnt.style.color = 'var(--brand)'; cnt.textContent = String(o.left);
    pill.append(img, document.createTextNode(p.name.length > 22 ? `${p.name.slice(0, 21)}…` : p.name), cnt);
    const marker = L.marker([p.lat, p.lng], { icon: L.divIcon({ html: pill, className: '', iconSize: null, iconAnchor: [14, 14] }) }).addTo(mapInst);
    const box = document.createElement('div'); box.className = 'space-y-1 min-w-[180px]';
    const a = document.createElement('a'); a.className = 'font-bold'; a.href = `#/place/${p.id}`; a.textContent = p.name;
    const ad = document.createElement('div'); ad.className = 'text-xs'; ad.textContent = p.address || p.kind;
    const ol = document.createElement('a'); ol.className = 'block text-xs'; ol.href = `#/place/${p.id}`;
    ol.append(document.createTextNode(`${o.title} — `)); const b = document.createElement('b'); b.textContent = fmtKzt(o.price); ol.append(b);
    box.append(a, ad, ol);
    marker.bindPopup(box);
    pts.push([p.lat, p.lng]);
  });
  if (pts.length > 1) mapInst.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
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
  root.innerHTML = `<main class="mx-auto max-w-[430px] md:max-w-none min-h-dvh bg-canvas relative shadow-2xl md:shadow-none">
    ${headerHtml('')}
    <div class="min-h-dvh md:min-h-0 p-5 space-y-6 md:max-w-md md:mx-auto md:mt-12 md:p-8 md:bg-surface md:border md:border-line md:rounded-[28px] md:card-shadow">
      <button aria-label="${t('back')}" data-action="back" class="w-11 h-11 rounded-full bg-surface border border-line flex items-center justify-center text-ink">${icon('back', 'w-5 h-5')}</button>
      <div><h1 class="text-[28px] font-extrabold text-ink">${t(isLogin ? 'a.login' : 'a.register')}</h1><p class="text-sm text-sub">${t(isLogin ? 'a.loginSub' : 'a.registerSub')}</p></div>
      <form class="space-y-3" id="auth">
        ${isLogin ? '' : `<input class="input" name="name" required placeholder="${t('a.name')}" autocomplete="name">`}
        <input class="input" name="email" type="email" required placeholder="${t('a.email')}" autocomplete="email">
        <input class="input" name="pw" type="password" required placeholder="${t('a.password')}" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
        <button type="submit" class="${BTN_PRIMARY}">${t(isLogin ? 'a.submitLogin' : 'a.submitRegister')}</button>
      </form>
      <p class="text-xs text-sub">${t('a.demo')}</p>
      <p class="text-sm text-sub text-center">${t(isLogin ? 'a.noAccount' : 'a.haveAccount')} <a class="font-bold text-brand dark:text-emerald-300" href="#/${isLogin ? 'register' : 'login'}">${t(isLogin ? 'a.toRegister' : 'a.toLogin')}</a></p>
    </div></main>`;
  document.getElementById('auth').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim();
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
        <div class="flex items-center justify-between"><h4 class="font-bold text-ink">${esc(o.placeName)}</h4><span class="text-xs font-bold text-brand dark:text-emerald-300">${t('t.paid')}</span></div>
        <p class="text-sm text-ink">${esc(o.title)}</p>
        <p class="text-xs text-sub numeric">${esc(o.window)} · ${fmtKzt(o.price + o.fee)}</p></a>`).join('')}</div>`
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

async function renderCheckout(id) {
  const p = findPlace(id);
  if (!p) { location.hash = '#/feed'; return; }
  if (!requireLogin(`#/checkout/${id}`)) return;
  const o = offerFor(p);
  let order = getDraft(id);
  if (!order || Date.now() - order.createdAt > HOLD_MS) {
    if (!o.left) { location.hash = `#/place/${id}`; return; }
    order = makeDraft(p);
  }
  sess.set('cs_draft', order);
  const total = order.price + order.fee;
  const payUrl = `${location.origin}${location.pathname}#/pay/${b64urlEncode(packOrder(order))}`;
  const method = sess.get('cs_paytab', 'qr');
  const test = (method === 'qr' ? CFG.kaspiQrUrl : CFG.paymentLinkBase) ? '' : `<div class="rounded-[14px] bg-urgent-soft text-urgent text-xs font-semibold p-3">${t('c.test')}</div>`;
  const opt = (m, title, sub) => `<button data-tab="${m}" role="radio" aria-checked="${method === m}" class="w-full flex items-center justify-between gap-3 p-4 rounded-[14px] border text-left transition ${method === m ? 'border-brand bg-brand-soft' : 'border-line bg-surface'}"><span><span class="block text-sm font-bold text-ink">${title}</span><span class="block text-xs text-sub">${sub}</span></span><span class="text-xs font-bold text-brand dark:text-emerald-300">${t('c.zeroFee')}</span></button>`;
  root.innerHTML = `<main class="mx-auto max-w-[430px] md:max-w-none min-h-dvh bg-canvas relative shadow-2xl md:shadow-none">${headerHtml('feed')}
    <div class="min-h-dvh md:min-h-0 p-5 space-y-5 md:max-w-2xl md:mx-auto md:py-8">
      <div class="flex items-center gap-3"><button aria-label="${t('back')}" data-action="back" class="w-11 h-11 rounded-full bg-surface border border-line flex items-center justify-center text-ink">${icon('back', 'w-5 h-5')}</button>
        <h1 class="text-2xl font-extrabold text-ink flex-1">${t('c.title')}</h1></div>
      <div class="flex items-center justify-between rounded-[18px] bg-brand-soft p-4"><div><span class="text-xs font-semibold uppercase tracking-wide text-brand dark:text-emerald-300">${t('c.held')}</span><p class="text-lg font-bold text-ink numeric" id="hold">10:00</p></div>${icon('clock', 'w-7 h-7 text-brand dark:text-emerald-300')}</div>
      <div class="bg-surface border border-line rounded-[18px] p-4 space-y-3 card-shadow">
        <div><h3 class="font-bold text-ink">${esc(order.placeName)}</h3><p class="text-sm text-ink">${esc(order.title)}</p><p class="text-xs text-sub">${esc(t('c.pickupAt', { window: order.window }))}</p></div>
        <div class="space-y-2 text-sm border-t border-line pt-3">
          <div class="flex justify-between"><span class="text-sub">${t('c.subtotal')}</span><span class="numeric text-ink">${fmtKzt(order.price)}</span></div>
          <div class="flex justify-between"><span class="text-sub">${t('c.fee')}</span><span class="numeric text-ink">${fmtKzt(order.fee)}</span></div>
          ${order.ref ? `<div class="flex justify-between"><span class="text-sub">${t('c.saving')}</span><span class="numeric text-brand dark:text-emerald-300 font-semibold">${fmtKzt(order.ref - order.price)}</span></div>` : ''}
          <div class="flex justify-between font-extrabold text-base border-t border-line pt-2"><span class="text-ink">${t('c.total')}</span><span class="numeric text-ink">${fmtKzt(total)}</span></div></div></div>
      <div class="space-y-3"><h3 class="font-bold text-ink">${t('c.method')}</h3><div role="radiogroup" class="space-y-2">${opt('qr', CFG.kaspiQrUrl ? 'Kaspi QR' : t('c.qr'), CFG.kaspiQrUrl ? t('c.kaspiSub') : t('c.qrSub'))}${opt('card', t('c.card'), t('c.cardSub'))}</div></div>
      ${test}
      <div id="pay-body" class="space-y-3"></div>
      <p class="text-[11px] text-sub text-center">${t('c.offer')}</p>
    </div></main>`;
  const tick = () => {
    const left = HOLD_MS - (Date.now() - order.createdAt);
    const el = document.getElementById('hold');
    if (!el) return;
    if (left <= 0) {
      clearInterval(timer);
      sess.del('cs_draft');
      document.getElementById('pay-body').innerHTML = `<div class="rounded-[14px] bg-urgent-soft text-urgent text-sm font-semibold p-3">${t('c.expired')}</div><a class="${BTN_PRIMARY}" href="#/place/${esc(id)}">${t('c.toListing')}</a>`;
      el.textContent = '00:00';
      return;
    }
    el.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  };
  clearInterval(timer); tick(); timer = setInterval(tick, 1000);
  const body = document.getElementById('pay-body');
  if (method === 'qr' && CFG.kaspiQrUrl) {
    body.innerHTML = `<div class="bg-surface border border-line rounded-[18px] card-shadow p-5 space-y-4 text-center">
        <div class="flex items-center justify-center gap-2"><span class="w-7 h-7 rounded-md flex items-center justify-center text-white text-xs font-extrabold" style="background:#f14635">K</span><span class="font-bold text-ink">Kaspi QR · ${esc(CFG.kaspiMerchant || '')}</span></div>
        <div class="bg-white rounded-[18px] border border-line p-3 mx-auto qr" style="max-width:260px" id="qr" aria-label="Kaspi QR">…</div>
        <div><p class="text-xs text-sub">${t('c.kaspiAmount')}</p><p class="text-3xl font-extrabold text-ink numeric">${fmtKzt(total)}</p>
          <p class="text-xs text-sub numeric">${esc(t('c.kaspiComment', { n: order.id }))}</p></div>
        <ol class="text-left text-sm text-sub space-y-1" style="list-style:decimal;padding-left:20px"><li>${t('c.kaspi1')}</li><li>${t('c.kaspi2', { sum: fmtKzt(total) })}</li><li>${t('c.kaspi3')}</li></ol>
        <a class="${BTN_PRIMARY}" style="background:#f14635" href="${esc(CFG.kaspiQrUrl)}" target="_blank" rel="noopener noreferrer">${t('c.kaspiOpen')}</a>
      </div>
      <button class="w-full min-h-[50px] rounded-[14px] border border-line bg-surface text-ink font-bold text-sm" data-action="confirm-qr">${t('c.payQr')}</button>
      <p class="text-[11px] text-sub text-center">${t('c.kaspiNote')}</p>`;
    try { document.getElementById('qr').innerHTML = await qrSvg(CFG.kaspiQrUrl, 'M'); }
    catch { const q = document.getElementById('qr'); if (q) q.textContent = CFG.kaspiQrUrl; }
  } else if (method === 'qr') {
    body.innerHTML = `<p class="text-xs text-sub">${t('c.qrHint')}</p>
      <div class="bg-white rounded-[18px] border border-line p-3 mx-auto qr" style="max-width:280px" id="qr" aria-label="QR">…</div>
      <p class="text-xs text-sub text-center numeric">${esc(t('t.order', { n: order.id }))}</p>
      <button class="${BTN_PRIMARY}" data-action="confirm-qr">${t('c.payQr')}</button>`;
    try { document.getElementById('qr').innerHTML = await qrSvg(payUrl, 'L'); }
    catch { const q = document.getElementById('qr'); if (q) q.textContent = 'QR недоступен'; }
  } else {
    body.innerHTML = `<form id="card" novalidate autocomplete="on" class="space-y-3">
      <div><input class="input" id="cn" name="cn" inputmode="numeric" autocomplete="cc-number" placeholder="${t('c.cardNum')}" aria-label="${t('c.cardNum')}" maxlength="23"><p class="text-xs text-error mt-1" id="e-cn"></p></div>
      <div class="grid gap-3" style="grid-template-columns:1fr 1fr">
        <div><input class="input" id="ce" name="ce" inputmode="numeric" autocomplete="cc-exp" placeholder="${t('c.exp')}" aria-label="${t('c.exp')}" maxlength="5"><p class="text-xs text-error mt-1" id="e-ce"></p></div>
        <div><input class="input" id="cv" name="cv" inputmode="numeric" autocomplete="cc-csc" type="password" placeholder="${t('c.cvc')}" aria-label="${t('c.cvc')}" maxlength="4"><p class="text-xs text-error mt-1" id="e-cv"></p></div></div>
      <div><input class="input" id="cm" name="cm" autocomplete="cc-name" placeholder="${t('c.name')}" aria-label="${t('c.name')}"><p class="text-xs text-error mt-1" id="e-cm"></p></div>
      <button class="${BTN_PRIMARY}" type="submit">${t('c.payCard')} · ${fmtKzt(total)}</button>
      <p class="text-xs text-sub">${t('c.local')}</p></form>`;
    const cn = document.getElementById('cn'); const ce = document.getElementById('ce');
    cn.addEventListener('input', () => { cn.value = cn.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim(); });
    ce.addEventListener('input', () => { const d = ce.value.replace(/\D/g, '').slice(0, 4); ce.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; });
    document.getElementById('card').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const checks = [['cn', luhn(f.cn.value), 'c.badNum'], ['ce', validExpiry(f.ce.value), 'c.badExp'], ['cv', /^\d{3,4}$/.test(f.cv.value), 'c.badCvc'], ['cm', f.cm.value.trim().length >= 3, 'c.badName']];
      let ok = true;
      for (const [k, valid, msg] of checks) {
        document.getElementById(`e-${k}`).textContent = valid ? '' : t(msg);
        f[k].setAttribute('aria-invalid', String(!valid));
        if (!valid) ok = false;
      }
      if (!ok) return;
      f.cn.value = ''; f.cv.value = '';
      if (CFG.paymentLinkBase) {
        const u = new URL(CFG.paymentLinkBase); u.searchParams.set('client_reference_id', order.id); location.href = u.href; return;
      }
      markPaid(order);
    });
  }
}

function markPaid(order) {
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
  const steps = [t('t.paid'), t('t.ready'), t('t.done')];
  shell(`<div class="px-4 pt-6 pb-6 md:pt-10 space-y-5">
    <div class="flex items-center gap-3"><button aria-label="${t('back')}" data-action="back" class="w-11 h-11 rounded-full bg-surface border border-line flex items-center justify-center text-ink">${icon('back', 'w-5 h-5')}</button><h2 class="text-2xl font-extrabold text-ink">${t('t.title')}</h2></div>
    <div class="bg-surface border border-line rounded-[18px] card-shadow p-6 text-center space-y-4">
      <p class="text-xs font-bold tracking-wide text-sub numeric">${esc(t('t.order', { n: o.id }))}</p>
      <div class="bg-white rounded-[18px] p-3 mx-auto qr" style="max-width:260px" id="tqr" aria-label="QR">…</div>
      <p class="text-xs text-sub">${t('t.staff')}</p><p class="text-4xl font-extrabold text-ink numeric" style="letter-spacing:.3em;padding-left:.3em" aria-label="${esc(o.pin)}">${esc(o.pin)}</p>
      <p class="text-xs text-sub">${t('t.show')}</p>
      <div class="flex items-center justify-center gap-2 text-xs font-bold">${steps.map((s, i) => `<span class="px-2.5 py-1 rounded-full ${i === 0 ? 'bg-brand text-white' : 'bg-muted text-sub'}">${s}</span>`).join('')}</div></div>
    <div class="bg-surface border border-line rounded-[18px] p-4 space-y-1">
      <h3 class="font-bold text-ink">${esc(o.placeName)}</h3><p class="text-sm text-sub">${esc(o.address || '—')} · ${esc(t('city'))}</p>
      <p class="text-sm text-ink">${esc(o.title)}</p><p class="text-sm text-sub numeric">${esc(t('t.window', { w: o.window }))}</p>
      <a class="flex items-center gap-1.5 text-sm font-bold text-brand dark:text-emerald-300 min-h-[44px]" target="_blank" rel="noopener noreferrer" href="${esc(twoGisUrl(o.placeName, o.lat, o.lng))}">${icon('nav', 'w-4 h-4')} ${t('l.route')}</a></div></div>`, 'orders', { maxw: 'md:max-w-2xl' });
  try { const q = await qrSvg(`CRUMBSAVE|${o.id}|${o.pin}`); const el = document.getElementById('tqr'); if (el) el.innerHTML = q; }
  catch { const el = document.getElementById('tqr'); if (el) el.textContent = o.pin; }
}

function renderPay(payload) {
  try {
    const o = unpackOrder(b64urlDecode(payload));
    if (!getOrders().some((x) => x.id === o.id)) store.set('cs_orders', [o, ...getOrders()].slice(0, 50));
    location.replace(`#/ticket/${o.id}`);
  } catch {
    shell(`<div class="px-6 pt-16 space-y-4"><p class="text-sm text-error">Ссылка на оплату повреждена или устарела.</p><a class="${LOGIN_BTN}" href="#/feed">${t('nav.feed')}</a></div>`, 'feed');
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
function route() {
  renderGen += 1;
  const hash = location.hash || '#/feed';
  const [name, arg] = hash.replace(/^#\/?/, '').split('/');
  const view = name || 'feed';
  if (mapInst) { mapInst.remove(); mapInst = null; }
  if (view !== 'checkout') clearInterval(timer);
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
  const tEl = e.target.closest('[data-action],[data-cat],[data-tab],[data-fav],[data-lang],[data-radius],[data-district],[data-next]');
  if (!tEl) {
    if (state.popOpen && !e.target.closest('.geo-pop')) { state.popOpen = false; refresh(); }
    return;
  }
  const d = tEl.dataset;
  if (d.next) { sess.set('cs_next', d.next); return; }
  if (d.cat) { state.cat = d.cat; renderFeed(); return; }
  if (d.tab) { sess.set('cs_paytab', d.tab); route(); return; }
  if (d.lang) { setLang(d.lang); return; }
  if (d.radius) { state.radius = Number(d.radius); sess.set('cs_radius', state.radius); state.popOpen = false; loadPlaces(); return; }
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
    case 'search': state.searchOpen = !state.searchOpen; if (!state.searchOpen) state.q = ''; renderFeed(); break;
    case 'back': if (history.length > 1) history.back(); else location.hash = '#/feed'; break;
    case 'share': {
      const url = location.href;
      try { if (navigator.share) await navigator.share({ url, title: 'CrumbSave' }); else { await navigator.clipboard.writeText(url); toast(t('copied')); } } catch { /* отмена */ }
      break;
    }
    case 'book': if (requireLogin(`#/checkout/${d.id}`)) location.hash = `#/checkout/${d.id}`; break;
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
window.addEventListener('hashchange', route);

route();
