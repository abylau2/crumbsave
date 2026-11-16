import {
  CATS, ALMATY, esc, fmtDist, fmtKzt, luhn, validExpiry, hash32, OVERPASS_ENDPOINTS,
  overpassQuery, parseElements, twoGisUrl, osmUrl, demoOffer, newOrderId, newPin,
  b64urlEncode, b64urlDecode, packOrder, unpackOrder,
} from './lib.js';

const CFG = window.CRUMBSAVE_CONFIG || {};
const app = document.getElementById('app');
const noticeEl = document.getElementById('notice');

// ---------- хранилище (всё локально, на устройстве) ----------
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
const sess = {
  get(k, fb) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const getOrders = () => store.get('cs_orders', []);
const getSold = () => store.get('cs_sold', {});

// ---------- состояние ----------
const state = {
  loc: sess.get('cs_loc', null),
  source: sess.get('cs_src', 'default'), // 'gps' | 'default'
  radius: sess.get('cs_radius', 2000),
  cat: 'all',
  places: [],
  status: 'idle', // idle | loading | ready | error
  error: '',
  geoMsg: '',
  geoBusy: false,
  initDone: false,
};
let loadToken = 0;
let mapInst = null;

const placeCache = new Map(sess.get('cs_places', []).map((p) => [p.id, p]));
function rememberPlaces(list) {
  list.forEach((p) => placeCache.set(p.id, p));
  sess.set('cs_places', [...placeCache.values()].slice(-300));
}

// Перерисовываем только ленту/карту: другие экраны (например, форма карты) трогать нельзя.
function refresh() {
  const v = (location.hash || '#/feed').replace(/^#\/?/, '').split('/')[0] || 'feed';
  if (v === 'feed' || v === 'map') route();
}

// ---------- геолокация ----------
function geoErrorText(err) {
  if (!err) return 'Не удалось определить местоположение.';
  if (err.code === 1) return 'Доступ к геолокации запрещён. Разрешите его в настройках браузера для этого сайта или выберите район вручную.';
  if (err.code === 2) return 'Устройство не смогло определить положение. Проверьте GPS/интернет и попробуйте ещё раз.';
  if (err.code === 3) return 'Определение положения заняло слишком много времени. Попробуйте ещё раз.';
  return 'Не удалось определить местоположение.';
}

function locate() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      state.geoMsg = 'Этот браузер не поддерживает геолокацию.';
      return resolve(false);
    }
    state.geoBusy = true;
    state.geoMsg = '';
    refresh();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.source = 'gps';
        sess.set('cs_loc', state.loc);
        sess.set('cs_src', 'gps');
        state.geoBusy = false;
        resolve(true);
      },
      (err) => {
        state.geoMsg = geoErrorText(err);
        state.geoBusy = false;
        resolve(false);
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
    );
  });
}

// ---------- реальные заведения (OpenStreetMap / Overpass) ----------
async function fetchOverpass(loc, radius) {
  const key = `cs_ov_${loc.lat.toFixed(3)}_${loc.lng.toFixed(3)}_${radius}`;
  const cached = sess.get(key, null);
  if (cached && Date.now() - cached.t < 10 * 60 * 1000) return cached.els;
  const body = `data=${encodeURIComponent(overpassQuery(loc.lat, loc.lng, radius))}`;
  let lastErr;
  for (const ep of OVERPASS_ENDPOINTS) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 14000);
    try {
      const res = await fetch(ep, {
        method: 'POST', body, signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      sess.set(key, { t: Date.now(), els: json.elements || [] });
      return json.elements || [];
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(to);
    }
  }
  throw lastErr || new Error('overpass');
}

async function loadPlaces() {
  const token = ++loadToken;
  state.status = 'loading';
  state.error = '';
  refresh();
  try {
    const els = await fetchOverpass(state.loc, state.radius);
    if (token !== loadToken) return;
    state.places = parseElements(els, state.loc);
    rememberPlaces(state.places);
    state.status = 'ready';
  } catch {
    if (token !== loadToken) return;
    state.status = 'error';
    state.error = 'Не удалось загрузить заведения рядом. Сервис карт временно недоступен — попробуйте ещё раз.';
  }
  refresh();
}

async function init() {
  if (state.initDone) return;
  state.initDone = true;
  if (!state.loc) { state.loc = { ...ALMATY }; state.source = 'default'; }
  // Если разрешение уже выдано раньше — определяем место сразу, без лишних кликов.
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    if (p && p.state === 'granted' && state.source !== 'gps') await locate();
  } catch { /* Permissions API недоступен */ }
  loadPlaces();
}

// ---------- утилиты UI ----------
const PALETTE = ['#1f4d3f', '#8a5a2b', '#a23e48', '#3d5a80', '#6b4e9b', '#2f7f79', '#9a6b00', '#5b6b2e'];
const logoColor = (id) => PALETTE[hash32(id) % PALETTE.length];
const initials = (name) => {
  const w = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '?') + (w[1]?.[0] || '')).toUpperCase();
};
const offerFor = (p) => demoOffer(p, new Date(), getSold()[p.id] || 0);
const leftText = (n) => (n === 1 ? 'Остался 1 набор' : n >= 2 && n <= 4 ? `Осталось ${n} набора` : `Осталось ${n} наборов`);
const findPlace = (id) => state.places.find((p) => p.id === id) || placeCache.get(id);

const loadedScripts = {};
function loadScript(src) {
  if (!loadedScripts[src]) {
    loadedScripts[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error(`load ${src}`));
      document.head.appendChild(s);
    });
  }
  return loadedScripts[src];
}
function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}
async function qrSvg(text, level = 'M') {
  await loadScript('vendor/qrcode.js');
  const qr = window.qrcode(0, level);
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function placeCard(p) {
  const o = offerFor(p);
  return `<a class="card" href="#/place/${esc(p.id)}">
    <div class="head">
      <div class="logo" style="background:${logoColor(p.id)}" aria-hidden="true">${esc(initials(p.name))}</div>
      <div><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.kind)}${p.address ? ` · ${esc(p.address)}` : ''}</div></div>
    </div>
    <div class="title">${esc(o.title)}</div>
    <div class="tags">
      ${p.distance != null ? `<span class="tag dist">${esc(fmtDist(p.distance))}</span>` : ''}
      <span class="tag ${o.left <= 1 ? 'low' : ''}">${o.left ? esc(leftText(o.left)) : 'Разобрали'}</span>
      <span class="tag demo">демо-набор</span>
    </div>
    <div class="price"><b>${fmtKzt(o.price)}</b><s>${fmtKzt(o.ref)}</s><span class="off">−${o.discount}%</span></div>
    <div class="sub">Забрать: ${esc(o.window)}</div>
  </a>`;
}

// ---------- экраны ----------
function renderFeed() {
  const where = state.source === 'gps' ? 'Рядом с вами' : 'Алматы, центр города';
  const list = state.places.filter((p) => state.cat === 'all' || p.cat === state.cat);
  let body;
  if (state.status === 'loading' || state.status === 'idle') {
    body = '<div class="skeletons" aria-hidden="true"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>';
  } else if (state.status === 'error') {
    body = `<div class="err" role="alert">${esc(state.error)} <button class="btn ghost" data-action="retry">Повторить</button></div>`;
  } else if (!list.length) {
    body = `<div class="empty"><p><b>Рядом ничего не нашлось.</b></p><p>Увеличьте радиус поиска или выберите другую категорию.</p></div>`;
  } else {
    body = `<div class="grid">${list.slice(0, 60).map(placeCard).join('')}</div>`;
  }
  const geoCard = state.source !== 'gps' ? `<section class="geo-card" aria-labelledby="gc">
      <h2 id="gc">Показать заведения рядом с вами</h2>
      <p>Браузер спросит разрешение на доступ к местоположению. Координаты остаются на вашем устройстве и нужны только для поиска ближайших мест.</p>
      <div class="row"><button class="btn" data-action="locate" ${state.geoBusy ? 'disabled' : ''}>${state.geoBusy ? 'Определяем…' : 'Определить местоположение'}</button></div>
      ${state.geoMsg ? `<p class="small" role="alert" style="margin:10px 0 0;color:var(--red)">${esc(state.geoMsg)}</p>` : ''}
    </section>` : '';
  app.innerHTML = `
    <h1>Забрать сегодня</h1>
    <div class="locbar">
      <div class="where"><span aria-hidden="true">📍</span> ${esc(where)}
        ${state.source === 'gps' ? '<button class="btn ghost" style="min-height:36px;padding:6px 12px" data-action="locate">Обновить</button>' : ''}</div>
      <label class="small muted">Радиус
        <select id="radius" aria-label="Радиус поиска">
          ${[1000, 2000, 3000, 5000].map((r) => `<option value="${r}" ${r === state.radius ? 'selected' : ''}>${r / 1000} км</option>`).join('')}
        </select>
      </label>
    </div>
    ${geoCard}
    <div class="chips" role="group" aria-label="Категории">
      ${Object.entries(CATS).map(([k, v]) => `<button class="chip" data-cat="${k}" aria-pressed="${state.cat === k}">${esc(v)}</button>`).join('')}
    </div>
    ${body}`;
}

function renderPlace(id) {
  const p = findPlace(id);
  if (!p) { location.hash = '#/feed'; return; }
  const o = offerFor(p);
  const phone = p.phone ? p.phone.replace(/[^\d+]/g, '') : '';
  app.innerHTML = `
    <a class="back" href="#/feed">← К списку</a>
    <div class="panel">
      <div class="head" style="display:flex;gap:12px;align-items:center">
        <div class="logo" style="background:${logoColor(p.id)}" aria-hidden="true">${esc(initials(p.name))}</div>
        <div><h1 style="margin:0">${esc(p.name)}</h1><div class="sub muted">${esc(p.kind)}</div></div>
      </div>
      <p>${p.address ? esc(p.address) : '<span class="muted">Адрес в OpenStreetMap не указан — смотрите точку на карте.</span>'}
        ${p.distance != null ? `<span class="tag dist">${esc(fmtDist(p.distance))}</span>` : ''}</p>
      ${p.hours ? `<p class="small muted">Часы работы: ${esc(p.hours)}</p>` : ''}
      <div class="links">
        <a class="btn ghost" href="${esc(twoGisUrl(p.name, p.lat, p.lng))}" target="_blank" rel="noopener">Открыть в 2ГИС</a>
        <a class="btn ghost" href="${esc(osmUrl(p.id, p.lat, p.lng))}" target="_blank" rel="noopener">OpenStreetMap</a>
        ${phone ? `<a class="btn ghost" href="tel:${esc(phone)}">Позвонить</a>` : ''}
        ${p.website ? `<a class="btn ghost" href="${esc(p.website)}" target="_blank" rel="noopener nofollow">Сайт</a>` : ''}
      </div>
    </div>
    <div class="panel">
      <div class="tags" style="margin-bottom:8px"><span class="tag demo">демо-набор</span>
        <span class="tag ${o.left <= 1 ? 'low' : ''}">${o.left ? esc(leftText(o.left)) : 'Разобрали'}</span></div>
      <h2 style="margin-top:0">${esc(o.title)}</h2>
      <p class="muted">Сюрприз-набор из того, что не продалось за день. Состав заранее не известен. Аллергены уточняйте у заведения.</p>
      <div class="price"><b>${fmtKzt(o.price)}</b><s>${fmtKzt(o.ref)}</s><span class="off">−${o.discount}%</span></div>
      <p class="small muted">+ ${fmtKzt(o.fee)} сервисный сбор</p>
      <p><b>Самовывоз:</b> ${esc(o.window)}</p>
      <p class="small muted">Заведение пока не подключено к CrumbSave: набор и цена показаны для демонстрации.</p>
      <button class="btn block" data-action="book" data-id="${esc(p.id)}" ${o.left ? '' : 'disabled'}>${o.left ? 'Забронировать' : 'Наборы разобрали'}</button>
    </div>`;
}

function makeDraft(p) {
  const o = offerFor(p);
  return {
    id: newOrderId(), pin: newPin(), placeId: p.id, placeName: p.name, address: p.address,
    lat: p.lat, lng: p.lng, cat: p.cat, title: o.title, window: o.window, price: o.price, fee: o.fee,
    status: 'pending', createdAt: Date.now(),
  };
}
const getDraft = (placeId) => {
  const d = sess.get('cs_draft', null);
  return d && d.placeId === placeId ? d : null;
};

async function renderCheckout(id) {
  const p = findPlace(id);
  if (!p) { location.hash = '#/feed'; return; }
  const o = offerFor(p);
  if (!o.left) { location.hash = `#/place/${id}`; return; }
  const order = getDraft(id) || makeDraft(p);
  sess.set('cs_draft', order);
  const total = order.price + order.fee;
  const payUrl = `${location.origin}${location.pathname}#/pay/${b64urlEncode(packOrder(order))}`;
  const tab = sess.get('cs_paytab', 'qr');
  app.innerHTML = `
    <a class="back" href="#/place/${esc(id)}">← Назад</a>
    <h1>Оформление заказа</h1>
    <div class="panel">
      <div><b>${esc(order.placeName)}</b></div>
      <div class="muted small">${esc(order.title)} · ${esc(order.window)}</div>
      <div class="kv" style="margin-top:10px">
        <span>Набор</span><span>${fmtKzt(order.price)}</span>
        <span>Сервисный сбор</span><span>${fmtKzt(order.fee)}</span>
        <div class="total"><span>Итого</span><span>${fmtKzt(total)}</span></div>
      </div>
    </div>
    <div class="panel">
      <div class="tabs" role="tablist" aria-label="Способ оплаты">
        <button class="tab" role="tab" data-tab="qr" aria-selected="${tab === 'qr'}">По QR-коду</button>
        <button class="tab" role="tab" data-tab="card" aria-selected="${tab === 'card'}">Банковская карта</button>
      </div>
      <div id="pay-body"></div>
    </div>`;
  const body = document.getElementById('pay-body');
  const testBanner = CFG.paymentLinkBase ? '' : '<div class="banner-test"><b>Тест-режим:</b> деньги не списываются. Реальный приём платежей включается ссылкой провайдера в <code>config.js</code>.</div>';
  if (tab === 'qr') {
    body.innerHTML = `${testBanner}
      <p class="muted small">Отсканируйте код камерой телефона — откроется страница подтверждения оплаты заказа.</p>
      <div class="qrbox" id="qr" aria-label="QR-код для оплаты заказа">Генерируем QR…</div>
      <p class="small muted" style="text-align:center">Заказ ${esc(order.id)}</p>
      <button class="btn block" data-action="confirm-qr">Я оплатил — показать билет</button>`;
    try { document.getElementById('qr').innerHTML = await qrSvg(payUrl, 'L'); }
    catch { document.getElementById('qr').textContent = 'Не удалось построить QR. Оплатите картой.'; }
  } else {
    body.innerHTML = `${testBanner}
      <form id="card" novalidate autocomplete="on">
        <div class="field"><label for="cn">Номер карты</label>
          <input id="cn" name="cc-number" inputmode="numeric" autocomplete="cc-number" placeholder="0000 0000 0000 0000" maxlength="23">
          <div class="e" id="e-cn"></div></div>
        <div class="two">
          <div class="field"><label for="ce">Срок (ММ/ГГ)</label>
            <input id="ce" name="cc-exp" inputmode="numeric" autocomplete="cc-exp" placeholder="ММ/ГГ" maxlength="5"><div class="e" id="e-ce"></div></div>
          <div class="field"><label for="cv">CVC</label>
            <input id="cv" name="cc-csc" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" type="password"><div class="e" id="e-cv"></div></div>
        </div>
        <div class="field"><label for="cm">Имя на карте</label>
          <input id="cm" name="cc-name" autocomplete="cc-name" placeholder="IVAN IVANOV"><div class="e" id="e-cm"></div></div>
        <button class="btn block" type="submit">Оплатить ${fmtKzt(total)}</button>
        <p class="small muted">Данные карты проверяются только в вашем браузере и не сохраняются.</p>
      </form>`;
    const cn = document.getElementById('cn');
    const ce = document.getElementById('ce');
    cn.addEventListener('input', () => { cn.value = cn.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim(); });
    ce.addEventListener('input', () => {
      const d = ce.value.replace(/\D/g, '').slice(0, 4);
      ce.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    });
    document.getElementById('card').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const checks = [
        ['cn', luhn(f.cn.value), 'Проверьте номер карты'],
        ['ce', validExpiry(f.ce.value), 'Неверный срок действия'],
        ['cv', /^\d{3,4}$/.test(f.cv.value), 'Введите 3–4 цифры'],
        ['cm', f.cm.value.trim().length >= 3, 'Введите имя как на карте'],
      ];
      let ok = true;
      for (const [k, valid, msg] of checks) {
        document.getElementById(`e-${k}`).textContent = valid ? '' : msg;
        f[k].setAttribute('aria-invalid', String(!valid));
        if (!valid) ok = false;
      }
      if (!ok) return;
      f.cn.value = ''; f.cv.value = '';
      if (CFG.paymentLinkBase) {
        const u = new URL(CFG.paymentLinkBase);
        u.searchParams.set('client_reference_id', order.id);
        location.href = u.href;
        return;
      }
      markPaid(order);
    });
  }
}

function markPaid(order) {
  const orders = getOrders().filter((o) => o.id !== order.id);
  orders.unshift({ ...order, status: 'paid' });
  store.set('cs_orders', orders.slice(0, 50));
  const sold = getSold();
  sold[order.placeId] = (sold[order.placeId] || 0) + 1;
  store.set('cs_sold', sold);
  try { sessionStorage.removeItem('cs_draft'); } catch { /* ignore */ }
  location.hash = `#/ticket/${order.id}`;
}

async function renderTicket(id) {
  const o = getOrders().find((x) => x.id === id);
  if (!o) { app.innerHTML = '<div class="empty"><p>Заказ не найден на этом устройстве.</p><a class="btn" href="#/feed">К заведениям</a></div>'; return; }
  app.innerHTML = `
    <a class="back" href="#/orders">← Заказы</a>
    <h1>Ваш билет</h1>
    <div class="panel" style="text-align:center">
      <p class="ok">Заказ оплачен</p>
      <div class="qrbox" id="tqr" aria-label="QR-код билета">…</div>
      <p class="muted small" style="margin:10px 0 0">Покажите QR или назовите код при выдаче</p>
      <div class="pin" aria-label="Код выдачи ${esc(o.pin)}">${esc(o.pin)}</div>
    </div>
    <div class="panel">
      <b>${esc(o.placeName)}</b>
      <div class="muted">${esc(o.address || 'Адрес не указан')}</div>
      <p style="margin:8px 0">${esc(o.title)}<br><span class="muted">Забрать: ${esc(o.window)}</span></p>
      <div class="muted small">Заказ ${esc(o.id)} · ${fmtKzt(o.price + o.fee)}</div>
      <div class="links"><a class="btn ghost" target="_blank" rel="noopener" href="${esc(twoGisUrl(o.placeName, o.lat, o.lng))}">Маршрут в 2ГИС</a></div>
    </div>`;
  try { document.getElementById('tqr').innerHTML = await qrSvg(`CRUMBSAVE|${o.id}|${o.pin}`); }
  catch { document.getElementById('tqr').textContent = 'QR недоступен — назовите код.'; }
}

function renderOrders() {
  const orders = getOrders();
  app.innerHTML = `<h1>Заказы</h1>${orders.length ? orders.map((o) => `
    <a class="card" style="margin-bottom:12px" href="#/ticket/${esc(o.id)}">
      <div class="name">${esc(o.placeName)}</div>
      <div class="sub">${esc(o.title)} · ${esc(o.window)}</div>
      <div class="sub">Код ${esc(o.pin)} · ${fmtKzt(o.price + o.fee)}</div>
    </a>`).join('') : '<div class="empty"><p>Заказов пока нет.</p><a class="btn" href="#/feed">Найти набор</a></div>'}`;
}

function renderPay(payload) {
  try {
    const o = unpackOrder(b64urlDecode(payload));
    if (!getOrders().some((x) => x.id === o.id)) {
      const orders = getOrders();
      orders.unshift(o);
      store.set('cs_orders', orders.slice(0, 50));
    }
    location.replace(`#/ticket/${o.id}`);
  } catch {
    app.innerHTML = '<div class="err" role="alert">Ссылка на оплату повреждена или устарела.</div><a class="btn" href="#/feed">К заведениям</a>';
  }
}

async function renderMap() {
  const gen = renderGen;
  app.innerHTML = '<h1 style="margin-bottom:8px">Карта</h1><div id="map" role="region" aria-label="Карта заведений"></div>';
  if (state.status === 'idle') init();
  try {
    loadCss('vendor/leaflet.css');
    await loadScript('vendor/leaflet.js');
  } catch {
    document.getElementById('map').innerHTML = '<div class="err">Не удалось загрузить карту.</div>';
    return;
  }
  const el = document.getElementById('map');
  if (gen !== renderGen || !el || mapInst) return; // экран уже перерисован
  const L = window.L;
  const center = state.loc || ALMATY;
  mapInst = L.map(el).setView([center.lat, center.lng], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapInst);
  const pts = [[center.lat, center.lng]];
  if (state.source === 'gps') {
    L.circleMarker([center.lat, center.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 })
      .addTo(mapInst).bindTooltip('Вы здесь');
  }
  state.places.slice(0, 120).forEach((p) => {
    const box = document.createElement('div');
    const b = document.createElement('b'); b.textContent = p.name;
    const k = document.createElement('div'); k.textContent = p.kind;
    const a = document.createElement('a'); a.href = `#/place/${p.id}`; a.textContent = 'Открыть набор';
    box.append(b, k, a);
    L.circleMarker([p.lat, p.lng], { radius: 8, color: '#fff', weight: 2, fillColor: logoColor(p.id), fillOpacity: 0.95 })
      .addTo(mapInst).bindPopup(box);
    pts.push([p.lat, p.lng]);
  });
  if (pts.length > 1) mapInst.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
}

// ---------- роутер ----------
let lastHash = null;
let renderGen = 0;
function route() {
  renderGen += 1;
  const hash = location.hash || '#/feed';
  const [name, arg] = hash.replace(/^#\/?/, '').split('/');
  const view = name || 'feed';
  if (mapInst) { mapInst.remove(); mapInst = null; }
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (view === 'feed') { renderFeed(); init(); }
  else if (view === 'map') renderMap();
  else if (view === 'place') renderPlace(arg);
  else if (view === 'checkout') renderCheckout(arg);
  else if (view === 'ticket') renderTicket(arg);
  else if (view === 'orders') renderOrders();
  else if (view === 'pay') renderPay(arg || '');
  else { location.hash = '#/feed'; return; }
  if (hash !== lastHash) { window.scrollTo(0, 0); lastHash = hash; }
}

// ---------- события ----------
app.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action],[data-cat],[data-tab]');
  if (!t) return;
  if (t.dataset.cat) { state.cat = t.dataset.cat; renderFeed(); return; }
  if (t.dataset.tab) { sess.set('cs_paytab', t.dataset.tab); route(); return; }
  const act = t.dataset.action;
  if (act === 'locate') { if (await locate()) loadPlaces(); else refresh(); }
  else if (act === 'retry') loadPlaces();
  else if (act === 'book') location.hash = `#/checkout/${t.dataset.id}`;
  else if (act === 'confirm-qr') { const d = sess.get('cs_draft', null); if (d) markPaid(d); }
});
app.addEventListener('change', (e) => {
  if (e.target.id === 'radius') {
    state.radius = Number(e.target.value);
    sess.set('cs_radius', state.radius);
    loadPlaces();
  }
});
window.addEventListener('hashchange', route);

// предупреждение о демо-режиме
if (!sess.get('cs_notice_closed', false)) {
  noticeEl.hidden = false;
  noticeEl.innerHTML = '<span><b>Как это работает.</b> Заведения — реальные (данные OpenStreetMap). Наборы, цены и оплата — демонстрация: партнёрств с заведениями пока нет, деньги не списываются.</span><button aria-label="Закрыть">×</button>';
  noticeEl.querySelector('button').addEventListener('click', () => { noticeEl.hidden = true; sess.set('cs_notice_closed', true); });
}

route();
