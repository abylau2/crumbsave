// Чистая логика без DOM: легко тестируется в Node (см. tests/lib.test.js)

export const CATS = {
  all: 'Все',
  bakery: 'Выпечка',
  ready: 'Готовая еда',
  groceries: 'Продукты',
};

// Города, где работает сервис (центр и радиус).
export const CITIES = [
  { id: 'almaty', lat: 43.2389, lng: 76.8897, r: 40000 },
  { id: 'astana', lat: 51.1282, lng: 71.4304, r: 35000 },
];
export function cityAt(loc) {
  if (!loc || loc.lat == null) return null;
  for (const c of CITIES) if (haversine(loc, c) <= c.r) return c.id;
  return null;
}
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
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function overpassQuery(lat, lng, radius, limit = 1500) {
  const around = `(around:${Math.round(radius)},${lat},${lng})`;
  return `[out:json][timeout:40];(`
    + `nwr["amenity"~"^(cafe|restaurant|fast_food)$"]["name"]${around};`
    + `nwr["shop"~"^(bakery|pastry|confectionery|supermarket|convenience|greengrocer)$"]["name"]${around};`
    + `);out center ${limit};`;
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
      cuisine: String(tags.cuisine || '').toLowerCase(),
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

// Улица без типа («Абай даңғылы, 159Б» → «Абай 159Б») — так 2ГИС находит конкретный филиал.
const STREET_WORDS = /(^|\s)(улица|ул\.?|проспект|пр-т|пр\.|микрорайон|мкр\.?|переулок|пер\.|бульвар|шоссе|площадь|көшесі|даңғылы|шағын ауданы|тұйық|тұйығы|алаңы)(?=\s|,|$)/giu;
export function streetCore(address) {
  return String(address || '').replace(STREET_WORDS, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

// 2ГИС: поиск «название, улица номер» у точки заведения. С полным адресом 2ГИС
// показывает ровно этот филиал; без адреса — карту с центром на нужной точке.
export function twoGisUrl(name, lat, lng, address = '') {
  const q = /\d/.test(address) ? `${name}, ${streetCore(address)}` : name;
  return `https://2gis.kz/search/${encodeURIComponent(q)}?m=${lng.toFixed(6)},${lat.toFixed(6)}/18`;
}

// Адреса из соседних зданий OSM (у заведений адрес часто не заполнен).
export function addressQuery(points, radius = 50) {
  return `[out:json][timeout:25];(${points.map((p) => `nwr["addr:housenumber"]["addr:street"](around:${radius},${p.lat.toFixed(6)},${p.lng.toFixed(6)});`).join('')});out center tags qt;`;
}
export function nearestAddress(elements, point, maxM = 60) {
  let best = null; let bestD = Infinity;
  for (const e of elements || []) {
    const t = e.tags || {};
    const lat = e.lat ?? e.center?.lat; const lng = e.lon ?? e.center?.lon;
    if (!t['addr:street'] || !t['addr:housenumber'] || lat == null) continue;
    const d = haversine(point, { lat, lng });
    if (d < bestD) { bestD = d; best = `${t['addr:street']}, ${t['addr:housenumber']}`; }
  }
  return bestD <= maxM ? best : null;
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
  // Закрытие: по умолчанию 23:00, примерно у 40% заведений — 22:00.
  // Выдача — последние 60–90 минут перед закрытием.
  const closeMin = ((h >>> 5) % 5) < 2 ? 22 * 60 : 23 * 60;
  const startMin = closeMin - ((h >>> 7) % 2 ? 90 : 60);
  const mk = (addDays) => {
    const s = new Date(now);
    s.setHours(0, 0, 0, 0);
    s.setDate(s.getDate() + addDays);
    s.setMinutes(startMin);
    const e = new Date(s.getTime() + (closeMin - startMin) * 60000);
    return { s, e };
  };
  let { s, e } = mk(0);
  let day = 'Сегодня';
  if (e <= now) { ({ s, e } = mk(1)); day = 'Завтра'; }
  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const minsLeft = day === 'Сегодня' ? Math.max(0, Math.round((e - now) / 60000)) : null;
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
    closes: hhmm(e),
    minsLeft,
    open: day === 'Сегодня' && now >= s,
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
// Стоковые фото по типу кухни заведения (из тега cuisine/названия OSM), а не снимки самого места.
const PHOTO_IDS = {
  coffee: ['1495474472287-4d71bcdd2085', '1509042239860-f550ce710b93', '1501339847302-ac426a4a7cbb'],
  burger: ['1568901346375-23c9450c58cd', '1550547660-d9450f859349', '1550617931-e17a7b70dce2'],
  pizza: ['1513104890138-7c749659a591', '1565299624946-b28f40a0ae38'],
  sushi: ['1579871494447-9811cf80d66c', '1553621042-f6e147245754', '1569718212165-3a8278d5f624'],
  korean: ['1590301157890-4810ed352733', '1498654896293-37aacf113fd9'],
  asian: ['1534422298391-e4f8c172dddb', '1585032226651-759b368d7246', '1563245372-f21724e3856d'],
  kebab: ['1529006557810-274b9b2fc783', '1626700051175-6818013e1d4f', '1599487488170-d11ec9c172f0', '1619096252214-ef06c45683e3'],
  central: ['1561043433-aaf687c4cf04', '1619096252214-ef06c45683e3', '1599487488170-d11ec9c172f0'],
  grill: ['1561651823-34feb02250e4', '1544025162-d76694265947'],
  italian: ['1621996346565-e3dbc646d9a9', '1565299624946-b28f40a0ae38'],
  dessert: ['1488477181946-6428a0291777', '1551024601-bec78aea704b', '1565958011703-44f9829ba187', '1578985545062-69928b1d9587'],
  healthy: ['1512621776951-a57141f2eefd', '1540420773420-3366772f4999', '1606491956689-2ea866880c84'],
  sandwich: ['1555939594-58d7cb561ad1', '1626700051175-6818013e1d4f'],
  restaurant: ['1517248135467-4c7edcad34c4', '1414235077428-338989a2e8c0', '1555396273-367ea4eb4db5', '1559339352-11d035aa65de', '1504674900247-0877df9cc836'],
  bakery: ['1509440159596-0249088772ff', '1517433670267-08bbd4be890f', '1555507036-ab1f4038808a', '1600891964599-f61ba0e24092'],
  groceries: ['1542838132-92c53300491e', '1604719312566-8912e9227c6a', '1534723452862-4c874018d66d'],
};
const THEMES = [
  ['coffee', /coffee|кофе|coffee_shop|tea|чай/],
  ['pizza', /pizz|пицц/],
  ['sushi', /sushi|суши|japanese|япон|ramen|рамен|роллы/],
  ['korean', /korean|корей|кым|ким|кукси/],
  ['asian', /chinese|китай|asian|азиат|thai|vietnam|вьет|wok|вок|лапш|noodle|dumpling|uyghur|уйгур|лагман/],
  ['kebab', /kebab|кебаб|doner|döner|донер|шаурм|shawarma|turkish|турец|degirmen|gyro/],
  ['central', /uzbek|узбек|kazakh|казах|plov|плов|манты|beshbarmak|бешбармак|central_asian|кавказ|georgian|грузин/],
  ['grill', /steak|стейк|grill|гриль|bbq|barbecue|шашлык|мясо|meat/],
  ['burger', /burger|бургер|kfc|mcdonald|hot.?dog|chicken|курин/],
  ['italian', /ital|итал|pasta|паст/],
  ['dessert', /dessert|десерт|ice.?cream|морожен|cake|торт|donut|пончик|confection|кондитер|pastry/],
  ['healthy', /salad|салат|vegan|vegetarian|веган|healthy|poke|поке|bowl/],
  ['sandwich', /sandwich|сэндвич|сендвич|subway|бутер/],
];
export function photoTheme(place) {
  if (place.cat === 'groceries') return 'groceries';
  const hay = `${place.cuisine || ''} ${place.name || ''}`.toLowerCase();
  for (const [theme, re] of THEMES) if (re.test(hay)) return theme;
  if (place.cat === 'bakery') return /кондитер/i.test(place.kind || '') ? 'dessert' : 'bakery';
  if (/кофейн/i.test(place.kind || '')) return 'coffee';
  if (/фастфуд/i.test(place.kind || '')) return 'burger';
  if (/кафе/i.test(place.kind || '')) return hash32(place.id || '') % 2 ? 'restaurant' : 'coffee';
  return 'restaurant';
}
export function photoFor(place, w = 640) {
  const ids = PHOTO_IDS[photoTheme(place)];
  const id = ids[hash32(place.id || '') % ids.length];
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
