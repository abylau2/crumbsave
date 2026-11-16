import test from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, haversine, fmtDist, luhn, validExpiry, classify, parseElements, demoOffer,
  twoGisUrl, overpassQuery, b64urlEncode, b64urlDecode, packOrder, unpackOrder, safeUrl, ALMATY,
} from '../js/lib.js';

test('esc экранирует HTML', () => {
  assert.equal(esc('<img src=x onerror="a()">'), '&lt;img src=x onerror=&quot;a()&quot;&gt;');
});

test('haversine: Алматы центр → Достык/Абая ~ 1-3 км', () => {
  const d = haversine(ALMATY, { lat: 43.2445, lng: 76.9575 });
  assert.ok(d > 5000 && d < 6000, String(d));
  assert.equal(haversine(ALMATY, ALMATY), 0);
});

test('fmtDist', () => {
  assert.equal(fmtDist(84), '80 м');
  assert.equal(fmtDist(1540), '1,5 км');
});

test('luhn: тестовые номера', () => {
  assert.equal(luhn('4242 4242 4242 4242'), true);
  assert.equal(luhn('4242 4242 4242 4241'), false);
  assert.equal(luhn('1234'), false);
});

test('validExpiry', () => {
  const now = new Date(2026, 10, 16);
  assert.equal(validExpiry('12/27', now), true);
  assert.equal(validExpiry('11/26', now), true);
  assert.equal(validExpiry('10/26', now), false);
  assert.equal(validExpiry('13/30', now), false);
  assert.equal(validExpiry('abc', now), false);
});

test('classify', () => {
  assert.deepEqual(classify({ shop: 'bakery' }), { cat: 'bakery', kind: 'Пекарня' });
  assert.equal(classify({ amenity: 'cafe', name: 'Coffee Boom' }).kind, 'Кофейня');
  assert.equal(classify({ amenity: 'bank' }), null);
});

test('parseElements: имя обязательно, дедупликация, сортировка по расстоянию', () => {
  const els = [
    { type: 'node', id: 1, lat: 43.30, lon: 76.9, tags: { amenity: 'cafe', name: 'Далеко' } },
    { type: 'node', id: 2, lat: 43.2390, lon: 76.8897, tags: { amenity: 'restaurant', name: 'Близко', 'addr:street': 'Абая', 'addr:housenumber': '1' } },
    { type: 'node', id: 2, lat: 43.2390, lon: 76.8897, tags: { amenity: 'restaurant', name: 'Близко' } },
    { type: 'way', id: 3, center: { lat: 43.24, lon: 76.89 }, tags: { shop: 'bakery' } },
    { type: 'way', id: 4, center: { lat: 43.2395, lon: 76.8899 }, tags: { shop: 'bakery', name: 'Пекарня', website: 'javascript:alert(1)' } },
  ];
  const r = parseElements(els, ALMATY);
  assert.equal(r[0].name, 'Близко');
  assert.equal(r[2].name, 'Далеко');
  assert.equal(r.length, 3);
  assert.equal(r[0].address, 'Абая, 1');
  assert.equal(r.find((p) => p.name === 'Пекарня').website, '');
  assert.ok(r[0].distance <= r[1].distance && r[1].distance <= r[2].distance);
});

test('safeUrl', () => {
  assert.equal(safeUrl('example.kz'), 'https://example.kz/');
  assert.equal(safeUrl('javascript:alert(1)'), '');
});

test('demoOffer детерминирован и окно в будущем', () => {
  const p = { id: 'n42', cat: 'bakery' };
  const now = new Date(2026, 10, 16, 18, 51);
  const a = demoOffer(p, now);
  const b = demoOffer(p, now);
  assert.deepEqual(a, b);
  assert.ok(new Date(a.end) > now);
  assert.ok(a.price < a.ref && a.discount > 0);
  const late = demoOffer(p, new Date(2026, 10, 16, 23, 30));
  assert.equal(late.day, 'Завтра');
  assert.equal(demoOffer(p, now, 99).left, 0);
});

test('2ГИС: ссылка ведёт на поиск заведения рядом с точкой', () => {
  const u = twoGisUrl('Paul Bakery', 43.2445, 76.9575);
  assert.equal(u, 'https://2gis.kz/almaty/search/Paul%20Bakery?m=76.957500,43.244500/18');
});

test('overpassQuery содержит радиус и координаты', () => {
  const q = overpassQuery(43.2, 76.9, 2000);
  assert.ok(q.includes('around:2000,43.2,76.9'));
});

test('b64url туда-обратно, включая кириллицу; упаковка заказа', () => {
  const o = { id: 'CSABC', pin: '1234', placeId: 'n1', placeName: 'Кофе «Бум»', address: 'Абая, 1', lat: 43.2, lng: 76.9, title: 'Набор', window: 'Сегодня 19:00–20:15', price: 990, fee: 90, cat: 'ready' };
  const packed = b64urlEncode(packOrder(o));
  assert.ok(!/[+/=]/.test(packed));
  const back = unpackOrder(b64urlDecode(packed));
  assert.equal(back.placeName, 'Кофе «Бум»');
  assert.equal(back.pin, '1234');
  assert.equal(back.status, 'paid');
  assert.throws(() => unpackOrder({}));
});

import { streetCore, nearestAddress, photoTheme } from '../js/lib.js';
test('2GIS link targets a specific branch by address', () => {
  assert.equal(streetCore('Абай даңғылы, 159Б'), 'Абай 159Б');
  assert.equal(streetCore('улица Брусиловского, 199'), 'Брусиловского 199');
  const u = twoGisUrl('Degirmen', 43.2388, 76.889, 'Абай даңғылы, 159Б');
  assert.ok(u.startsWith('https://2gis.kz/almaty/search/Degirmen%2C%20%D0%90%D0%B1%D0%B0%D0%B9%20159%D0%91?m=76.889000,43.238800/18'), u);
  assert.ok(twoGisUrl('X', 1, 2, 'проспект Абая').includes('/search/X?'));
});
test('nearestAddress picks closest building within limit', () => {
  const els = [{ center: { lat: 43.2390, lon: 76.8891 }, tags: { 'addr:street': 'Абай даңғылы', 'addr:housenumber': '159Б' } },
    { lat: 43.2400, lon: 76.8891, tags: { 'addr:street': 'Far', 'addr:housenumber': '1' } }];
  assert.equal(nearestAddress(els, { lat: 43.2388, lng: 76.8890 }), 'Абай даңғылы, 159Б');
  assert.equal(nearestAddress(els, { lat: 43.30, lng: 76.89 }), null);
});
test('photo theme follows cuisine and name', () => {
  assert.equal(photoTheme({ id: 'n1', cat: 'ready', kind: 'Кафе', name: 'Degirmen' }), 'kebab');
  assert.equal(photoTheme({ id: 'n1', cat: 'ready', kind: 'Ресторан', name: 'Кым Ган Сан', cuisine: '' }), 'korean');
  assert.equal(photoTheme({ id: 'n1', cat: 'ready', kind: 'Ресторан', name: 'X', cuisine: 'pizza' }), 'pizza');
  assert.equal(photoTheme({ id: 'n1', cat: 'groceries', kind: 'Супермаркет', name: 'Magnum' }), 'groceries');
});

test('окно выдачи — перед закрытием в 22:00 или 23:00', () => {
  const now = new Date(2026, 10, 16, 20, 2);
  const closes = new Set();
  for (let i = 0; i < 200; i += 1) {
    const o = demoOffer({ id: `n${i}`, cat: 'ready' }, now);
    closes.add(o.closes);
    assert.equal(o.day, 'Сегодня');
    assert.ok(o.minsLeft > 0 && o.minsLeft <= 180);
  }
  assert.deepEqual([...closes].sort(), ['22:00', '23:00']);
});
