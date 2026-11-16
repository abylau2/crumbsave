// Чистая логика без DOM: легко тестируется в Node (см. tests/lib.test.js)

export const CATS = {
  all: 'Все',
  bakery: 'Выпечка',
  ready: 'Готовая еда',
  groceries: 'Продукты',
};

export const ALMATY = { lat: 43.238949, lng: 76.889709 };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function haversine(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function fmtDist(m) {
  if (m == null || Number.isNaN(m)) return '';
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} м`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} км`;
}

export function fmtKzt(n) {
  return `${Math.round(n).toLocaleString('ru-RU').replace(/ | /g, ' ')} ₸`;
}

export function luhn(num) {
  const d = String(num).replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function validExpiry(str, now = new Date()) {
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(str.trim());
  if (!m) return false;
  const mm = Number(m[1]);
  const yy = 2000 + Number(m[2]);
  if (mm < 1 || mm > 12) return false;
  // карта действует до конца указанного месяца
  return new Date(yy, mm, 1) > now;
}

export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ---------- OpenStreetMap / Overpass ----------

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function overpassQuery(lat, lng, radius) {
  const around = `(around:${Math.round(radius)},${lat},${lng})`;
  return `[out:json][timeout:20];(`
    + `nwr["amenity"~"^(cafe|restaurant|fast_food)$"]["name"]${around};`
    + `nwr["shop"~"^(bakery|pastry|confectionery|supermarket|convenience|greengrocer)$"]["name"]${around};`
    + `);out center 250;`;
}

const SHOP_KIND = {
  bakery: ['bakery', 'Пекарня'],
  pastry: ['bakery', 'Кондитерская'],
  confectionery: ['bakery', 'Кондитерская'],
  supermarket: ['groceries', 'Супермаркет'],
  convenience: ['groceries', 'Магазин у дома'],
  greengrocer: ['groceries', 'Овощи и фрукты'],
};
const AMENITY_KIND = {
  cafe: ['ready', 'Кафе'],
  restaurant: ['ready', 'Ресторан'],
  fast_food: ['ready', 'Фастфуд'],
};

export function classify(tags = {}) {
  const hit = SHOP_KIND[tags.shop] || AMENITY_KIND[tags.amenity];
  if (!hit) return null;
  let [cat, kind] = hit;
  if (tags.amenity === 'cafe' && /coffee|кофе/i.test(`${tags.cuisine || ''} ${tags.name || ''}`)) {
    kind = 'Кофейня';
  }
  return { cat, kind };
}

export function parseElements(elements, origin) {
  const seen = new Set();
  const out = [];
  for (const el of elements || []) {
    const tags = el.tags || {};
    const name = tags['name:ru'] || tags.name;
    const c = classify(tags);
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (!name || !c || lat == null || lng == null) continue;
    const id = `${el.type[0]}${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const street = tags['addr:street'];
    const num = tags['addr:housenumber'];
    out.push({
      id,
      name,
      cat: c.cat,
      kind: c.kind,
      lat,
      lng,
      address: street ? (num ? `${street}, ${num}` : street) : '',
      phone: tags.phone || tags['contact:phone'] || '',
      website: safeUrl(tags.website || tags['contact:website'] || ''),
      hours: tags.opening_hours || '',
      distance: origin ? haversine(origin, { lat, lng }) : null,
    });
  }
  out.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  return out;
}

export function safeUrl(u) {
  if (!u) return '';
  const s = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}

// Поиск по названию рядом с точкой: 2ГИС открывает карточку реального заведения,
// а не просто точку на карте.
export function twoGisUrl(name, lat, lng) {
  return `https://2gis.kz/search/${encodeURIComponent(name)}?m=${lng.toFixed(6)},${lat.toFixed(6)}/17`;
}

export function osmUrl(id, lat, lng) {
  const type = { n: 'node', w: 'way', r: 'relation' }[id[0]];
  return type ? `https://www.openstreetmap.org/${type}/${id.slice(1)}` : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}`;
}

// ---------- Демо-предложение ----------
// Партнёрств с заведениями пока нет, поэтому набор и цена — демонстрационные
// и всегда помечаются в интерфейсе. Детерминированы по id заведения.

const TIERS = {
  bakery: [
    ['Сюрприз-набор выпечки', 4500, 1490],
    ['Сладкий набор', 3600, 1190],
    ['Хлебная корзина', 3000, 990],
  ],
  ready: [
    ['Вечерний гастро-набор', 4400, 1850],
    ['Набор готовых блюд', 3800, 1390],
    ['Кофейный набор: десерты и сэндвичи', 3800, 1290],
  ],
  groceries: [
    ['Овощи и фрукты дня', 3200, 990],
    ['Набор продуктов', 4000, 1390],
    ['Молочный набор', 3400, 1190],
  ],
};

export const SERVICE_FEE = 90;

export function demoOffer(place, now = new Date(), sold = 0) {
  const h = hash32(place.id);
  const tiers = TIERS[place.cat] || TIERS.ready;
  const [title, ref, price] = tiers[h % tiers.length];
  const startMin = 17 * 60 + 30 + (((h >>> 3) % 7) * 30); // 17:30 … 20:30
  const mk = (addDays) => {
    const s = new Date(now);
    s.setHours(0, 0, 0, 0);
    s.setDate(s.getDate() + addDays);
    s.setMinutes(startMin);
    const e = new Date(s.getTime() + 75 * 60000);
    return { s, e };
  };
  let { s, e } = mk(0);
  let day = 'Сегодня';
  if (e <= now) { ({ s, e } = mk(1)); day = 'Завтра'; }
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const total = 1 + ((h >>> 9) % 5);
  const left = Math.max(0, total - sold);
  return {
    title,
    ref,
    price,
    fee: SERVICE_FEE,
    discount: Math.round((1 - price / ref) * 100),
    left,
    day,
    window: `${day} ${hhmm(s)}–${hhmm(e)}`,
    start: s.toISOString(),
    end: e.toISOString(),
    demo: true,
  };
}

// ---------- Заказ / ссылка на оплату ----------

export function newOrderId() {
  return `CS${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

export function newPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function b64urlEncode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Компактный вид заказа для QR-ссылки (чтобы QR оставался сканируемым)
export function packOrder(o) {
  return {
    i: o.id, p: o.pin, pid: o.placeId, n: o.placeName, la: Math.round(o.lat * 1e5) / 1e5, lo: Math.round(o.lng * 1e5) / 1e5,
    t: o.title, w: o.window, f: o.price, s: o.fee, c: o.cat,
  };
}

export function unpackOrder(x) {
  if (!x || typeof x.i !== 'string' || typeof x.n !== 'string') throw new Error('bad order');
  return {
    id: String(x.i).slice(0, 24),
    pin: String(x.p).replace(/\D/g, '').slice(0, 4),
    placeId: String(x.pid || ''),
    placeName: String(x.n).slice(0, 120),
    address: String(x.a || '').slice(0, 200),
    lat: Number(x.la) || 0,
    lng: Number(x.lo) || 0,
    title: String(x.t || '').slice(0, 120),
    window: String(x.w || '').slice(0, 60),
    price: Math.max(0, Number(x.f) || 0),
    fee: Math.max(0, Number(x.s) || 0),
    cat: String(x.c || 'ready'),
    status: 'paid',
    createdAt: Date.now(),
  };
}

// ---------- Фото и подписи ----------
// Фото — стоковые иллюстрации категории (как в первой версии сайта), а не снимки заведения.
const PHOTO_IDS = {
  bakery: ['1509440159596-0249088772ff', '1517433670267-08bbd4be890f', '1555507036-ab1f4038808a'],
  ready: ['1540420773420-3366772f4999', '1501339847302-ac426a4a7cbb'],
  groceries: ['1542838132-92c53300491e'],
};
export function photoFor(place, w = 640) {
  const ids = PHOTO_IDS[place.cat] || PHOTO_IDS.ready;
  const id = ids[hash32(place.id) % ids.length];
  return `https://images.unsplash.com/photo-${id}?w=${w}&auto=format&fit=crop&q=70`;
}

export function logoText(name) {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

export const DISTRICTS = [
  { id: 'center', lat: 43.238949, lng: 76.889709 },
  { id: 'Медеуский', lat: 43.2386, lng: 76.9617 },
  { id: 'Бостандыкский', lat: 43.2166, lng: 76.9187 },
  { id: 'Ауэзовский', lat: 43.2310, lng: 76.8473 },
  { id: 'Алмалинский', lat: 43.2563, lng: 76.9137 },
  { id: 'Жетысуский', lat: 43.2829, lng: 76.9234 },
  { id: 'Турксибский', lat: 43.3170, lng: 76.9570 },
  { id: 'Наурызбайский', lat: 43.2000, lng: 76.7800 },
  { id: 'Алатауский', lat: 43.2800, lng: 76.8600 },
];
