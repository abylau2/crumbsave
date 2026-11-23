"""Полный аудит CrumbSave: статика, все страницы (RU/EN/KZ, светлая/тёмная), клик по каждой кнопке, сценарии.
Запуск: python3 audit.py [base_url]
"""
import json, re, sys, time, base64, urllib.parse, os, subprocess, collections
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765/index.html"
SRC = "/home/claude/build/crumbsave-v2"
RESULTS = []          # (group, name, ok, detail)
def rec(group, name, ok, detail=""):
    RESULTS.append((group, name, bool(ok), str(detail)[:700]))

# ---------- моковые данные ----------
def mk_places(n, lat0, lng0, latin=True):
    els = []
    kinds = [("amenity", "restaurant"), ("amenity", "cafe"), ("amenity", "fast_food"), ("shop", "bakery"), ("shop", "supermarket"), ("shop", "confectionery")]
    for i in range(n):
        k, v = kinds[i % len(kinds)]
        tags = {k: v, "name": f"Place {i}" if latin else f"Место {i}"}
        if i % 2: tags.update({"addr:street": "Abay Ave", "addr:housenumber": str(100 + i)})
        if i % 7 == 0: tags["phone"] = "+7 727 000 00 00"
        if i % 11 == 0: tags["website"] = "https://example.com"
        if i == 3: tags["name"] = "Coffee <b>Boom</b> & \"Co\""
        if i == 5: tags["website"] = "javascript:alert(1)"
        els.append({"type": "node", "id": 7000 + i, "lat": lat0 + ((i % 20) - 10) * 0.0009, "lon": lng0 + ((i // 20) - 10) * 0.0012, "tags": tags})
    return els

class Mock:
    def __init__(self):
        self.overpass_down = False
        self.slow = 0
        self.ip_ok = True
        self.ov_calls = 0
    def install(self, ctx):
        def ov(route):
            self.ov_calls += 1
            if self.overpass_down: return route.fulfill(status=503, body="down")
            q = urllib.parse.unquote(route.request.post_data or "")
            if self.slow: time.sleep(self.slow); self.slow = 0  # медленный только первый ответ (sync-мок блокирует остальные)
            if "housenumber" in q and "amenity" not in q:
                return route.fulfill(status=200, content_type="application/json", body=json.dumps({"elements": [
                    {"type": "way", "id": 1, "center": {"lat": 43.2390, "lon": 76.8891}, "tags": {"addr:street": "Abay Ave", "addr:housenumber": "159B"}}]}))
            m = re.search(r"\((node|way)\((\d+)\)", q) or re.search(r"(node|way|nwr)\(id:(\d+)\)", q)
            if m:
                pid = int(m.group(2))
                return route.fulfill(status=200, content_type="application/json", body=json.dumps({"elements": [e for e in mk_places(200, 43.2389, 76.8897) if e["id"] == pid]}))
            mm = re.search(r"around:(\d+),([\d.]+),([\d.]+)", q)
            rad, la, lo = int(mm.group(1)), float(mm.group(2)), float(mm.group(3))
            n = {1000: 60, 1500: 120, 2000: 200, 3000: 400, 5000: 700}.get(rad, 100)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"elements": mk_places(n, la, lo)}))
        ctx.route("**/overpass*/**", ov)
        ctx.route("**/ipwho.is/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"},
                  body=json.dumps({"success": True, "city": "Almaty", "latitude": 43.2525, "longitude": 76.9115}) if self.ip_ok else '{"success":false}'))
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
        ctx.route("**/images.unsplash.com/**", lambda r: r.fulfill(status=200, content_type="image/png", body=png))
        ctx.route("**/tile.openstreetmap.org/**", lambda r: r.fulfill(status=200, content_type="image/png", body=png))
        ctx.route("**/fonts.g*/**", lambda r: r.fulfill(status=200, content_type="text/css", body=""))
        ctx.route("**/2gis.kz/**", lambda r: r.fulfill(status=200, content_type="text/html", body="<title>2gis</title>"))
        ctx.route("**/example.com/**", lambda r: r.fulfill(status=200, content_type="text/html", body="ok"))

def new_ctx(b, *, w=1440, h=900, user=False, lang="ru", dark=False, geo=None, mock=None, storage=None):
    perms = ["geolocation"] if geo else []
    ctx = b.new_context(viewport={"width": w, "height": h}, permissions=perms, geolocation=geo, timezone_id="Asia/Almaty", locale="ru-RU")
    mock = mock or Mock(); mock.install(ctx)
    init = {"cs_lang": lang, "cs_dark": dark}
    if user: init["cs_user"] = {"email": "prep@mail.kz", "name": "Test Teacher"}
    if storage: init.update(storage)
    ctx.add_init_script("(function(s){try{if(sessionStorage.getItem('__init'))return;sessionStorage.setItem('__init','1');for(const k in s)localStorage.setItem(k,JSON.stringify(s[k]));}catch(e){}})(%s)" % json.dumps(init))
    page = ctx.new_page()
    page._errs = []
    page.on("pageerror", lambda e: page._errs.append("pageerror: " + str(e)))
    page.on("console", lambda m: page._errs.append("console: " + m.text) if m.type == "error" and "Failed to load resource" not in m.text and "net::ERR" not in m.text and "vibrate" not in m.text else None)
    return ctx, page, mock

def goto(page, hash_, wait="#root > *"):
    page.goto("about:blank")
    page.goto(BASE + hash_)
    page.wait_for_selector(wait, timeout=20000)
    page.wait_for_timeout(500)

def wait_feed(page):
    page.wait_for_function("document.querySelectorAll('h4').length>0 || document.querySelector('[data-action=retry]')", timeout=30000)
    page.wait_for_timeout(300)

# ---------- проверки страницы ----------
PAGE_CHECK_JS = r"""
() => {
  const out = {overflow: 0, noName: [], noAlt: [], inputsNoLabel: [], lowContrast: [], keys: [], cyr: 0, emptyLinks: [], brokenImg: 0};
  out.overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  for (const el of document.querySelectorAll('button, a[href]')) {
    if (!vis(el)) continue;
    const name = (el.getAttribute('aria-label') || el.innerText || el.title || '').trim();
    if (!name && !el.querySelector('img[alt]:not([alt=""])')) out.noName.push(el.outerHTML.slice(0, 120));
    if (el.tagName === 'A' && !el.closest('.leaflet-control')) { const h = el.getAttribute('href'); if (!h || h === '#' || h === 'javascript:void(0)') out.emptyLinks.push(el.outerHTML.slice(0, 120)); if (/^javascript:/i.test(h)) out.emptyLinks.push('JS-HREF ' + h); }
  }
  for (const img of document.querySelectorAll('img')) { if (!img.hasAttribute('alt')) out.noAlt.push(img.outerHTML.slice(0, 100)); if (img.complete && img.naturalWidth === 0 && img.src && vis(img)) out.brokenImg++; }
  for (const inp of document.querySelectorAll('input, select, textarea')) {
    if (inp.type === 'hidden' || !vis(inp)) continue;
    const id = inp.id; const lab = inp.closest('label') || (id && document.querySelector(`label[for="${id}"]`));
    if (!lab && !inp.getAttribute('aria-label') && !inp.getAttribute('aria-labelledby')) out.inputsNoLabel.push(inp.outerHTML.slice(0, 100));
  }
  const parse = (c) => { const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { let stack = []; for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage && s.backgroundImage !== 'none' && !/gradient/.test(s.backgroundImage)) return null; const c = parse(s.backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 0.99) break; } } let base = [255, 255, 255]; for (let i = stack.length - 1; i >= 0; i--) { const c = stack[i]; base = [0, 1, 2].map((k) => c[k] * c[3] + base[k] * (1 - c[3])); } return base; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set(); let n;
  while ((n = walker.nextNode())) {
    const txt = n.textContent.trim(); if (!txt) continue;
    const el = n.parentElement; if (!el || seen.has(el) || !vis(el)) continue; seen.add(el);
    if (el.closest('.leaflet-container, svg, [aria-hidden=true]')) continue;
    const s = getComputedStyle(el); const fg = parse(s.color); const bg = bgOf(el); if (!fg || !bg) continue;
    const fgc = [0, 1, 2].map((k) => fg[k] * fg[3] + bg[k] * (1 - fg[3]));
    const L1 = lum(fgc), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(s.fontSize); const bold = +s.fontWeight >= 700; const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    if (ratio < need - 0.3 && el.closest('[disabled]') === null) out.lowContrast.push(`${ratio.toFixed(2)} "${txt.slice(0, 40)}" ${s.color} on rgb(${bg.map(Math.round)})`);
    if (/^[a-z]{1,8}\.[a-zA-Z.]{2,}$/.test(txt)) out.keys.push(txt);
  }
  out.cyrText = (document.body.innerText.match(/[А-Яа-яЁёҚқҢңҒғҮүҰұӨөҺһІі]{3,}/g) || []).filter((w) => !/^(Абай|Алматы)$/.test(w));
  out.lowContrast = out.lowContrast.slice(0, 8);
  return out;
}
"""

def check_page(page, group, name, lang="ru"):
    r = page.evaluate(PAGE_CHECK_JS)
    probs = []
    if r["overflow"] > 1: probs.append(f"горизонтальный скролл {r['overflow']}px")
    if r["noName"]: probs.append(f"кнопки без названия: {r['noName'][:3]}")
    if r["noAlt"]: probs.append(f"img без alt: {r['noAlt'][:2]}")
    if r["inputsNoLabel"]: probs.append(f"поля без подписи: {r['inputsNoLabel'][:2]}")
    if r["lowContrast"]: probs.append(f"низкий контраст: {r['lowContrast'][:4]}")
    if r["keys"]: probs.append(f"ключи перевода на экране: {r['keys'][:5]}")
    if r["emptyLinks"]: probs.append(f"пустые ссылки: {r['emptyLinks'][:3]}")
    if r["brokenImg"]: probs.append(f"битые картинки: {r['brokenImg']}")
    if lang == "en" and r["cyrText"]: probs.append(f"русский текст в EN: {sorted(set(r['cyrText']))[:12]}")
    if page._errs: probs.append(f"ошибки JS: {page._errs[:3]}")
    rec(group, name, not probs, "; ".join(probs))
    page._errs.clear()

# ---------- статические проверки ----------
def static_checks():
    app = open(f"{SRC}/js/app.js").read()
    lib = open(f"{SRC}/js/lib.js").read()
    keys = set(re.findall(r"\bt\('([A-Za-z0-9_.]+)'", app))
    for m in re.finditer(r"'((?:nav|l|a|c|t|f|o|p|geo|cat|left|feed|time|h|near)\.[A-Za-z0-9.]+)'", app): keys.add(m.group(1))
    dump = subprocess.run(["node", "-e", f"import('{SRC}/js/i18n.js').then(m=>console.log(JSON.stringify(Object.fromEntries(Object.entries(m.DICT).map(([k,v])=>[k,Object.keys(v)])))))"], capture_output=True, text=True).stdout
    d = json.loads(dump)
    for lang in ["ru", "en", "kk"]:
        miss = sorted(k for k in keys if k not in d[lang])
        rec("Статика", f"переводы {lang}: все ключи есть", not miss, miss[:30])
    # Русский текст прямо в коде интерфейса (мимо переводов)
    lines = []
    for i, line in enumerate(app.splitlines(), 1):
        s = line.strip()
        if s.startswith("//") or "console." in s: continue
        code = re.sub(r"//.*$", "", s)
        if re.search(r"['`\"][^'`\"]*[А-Яа-яЁё]{3,}[^'`\"]*['`\"]", code) and "'Русский'" not in code:
            lines.append(f"app.js:{i}: {s[:110]}")
    rec("Статика", "нет русского текста в обход переводов (app.js)", not lines, lines[:12])
    libd = json.loads(subprocess.run(["node", "-e", f"import('{SRC}/js/i18n.js').then(m=>console.log(JSON.stringify(m.LIB||{{}})))"], capture_output=True, text=True).stdout or "{}")
    lits = set()
    for i, l in enumerate(lib.splitlines(), 1):
        if l.strip().startswith("//") or re.search(r"/[^/']*[А-Яа-я][^/']*/[gimsuy]*", l) or i <= 8: continue
        lits.update(re.findall(r"'([^']*[А-Яа-яЁё]{3,}[^']*)'", l))
    for lang in ["en", "kk"]:
        miss = sorted(x for x in lits if x not in libd.get(lang, {}))
        rec("Статика", f"тексты lib.js переведены ({lang})", not miss, miss)
    # локальные файлы
    refs = set(re.findall(r"""['"]((?:vendor|css|js)/[^'"?#]+)""", app + open(f"{SRC}/index.html").read()))
    missing = [r for r in refs if not os.path.exists(f"{SRC}/{r}")]
    rec("Статика", "все локальные файлы на месте", not missing, missing)
    cc = subprocess.run(["python3", "/tmp/classcheck.py"], capture_output=True, text=True, cwd=SRC).stdout.strip()
    m = re.search(r"missing: (\[.*\])", cc)
    miss = [x for x in (eval(m.group(1)) if m else []) if re.fullmatch(r"[a-z][a-z0-9:\[\]./%_-]*", x) and x not in ("auth-err", "return", "hide-geo") and not re.search(r"data-|aria|application|password|pay-body|vendor|var\(|confirm|modal|geo-pop|close|paid|kaspi|cs-|pulse|ticket|qr|toast|skel|input|leaflet|pay-", x)]
    rec("Статика", "у всех CSS-классов есть стили", not miss, miss[:20])

# ---------- страницы ----------
def make_order(page):
    # оформить заказ через UI и вернуть id
    goto(page, "#/feed"); wait_feed(page)
    page.locator("h4").first.click(); page.wait_for_selector("[data-action=book]")
    page.click("[data-action=book]"); page.wait_for_selector("[data-action=kaspi]")
    page.click("[data-action=kaspi]"); page.click("[data-paid]")
    page.wait_for_selector("#tqr svg", timeout=10000)
    return page.url.split("#/ticket/")[1]

def routes_matrix(b):
    for lang in ["ru", "en", "kk"]:
        for dark in [False, True]:
            ctx, page, _ = new_ctx(b, user=True, lang=lang, dark=dark)
            tag = f"{lang}{' тёмная' if dark else ''}"
            oid = make_order(page); page._errs.clear()
            goto(page, "#/feed"); wait_feed(page); page.locator("[data-fav]").first.click(); page.wait_for_timeout(300); page._errs.clear()
            pid = "n7000"
            pages = [("Лента", "#/feed"), ("Карта", "#/map"), ("Набор", f"#/place/{pid}"), ("Оформление", f"#/checkout/{pid}"),
                     ("Билет", f"#/ticket/{oid}"), ("Заказы", "#/orders"), ("Избранное", "#/favorites"), ("Профиль", "#/profile")]
            for name, h in pages:
                goto(page, h)
                if h == "#/feed": wait_feed(page)
                if h == "#/map": page.wait_for_selector(".leaflet-container"); page.wait_for_timeout(800)
                if "ticket" in h: page.wait_for_selector("#tqr svg")
                check_page(page, f"Страницы ({tag})", name, lang)
            if not dark:
                page.click("[data-action=kaspi]") if False else None
                goto(page, f"#/checkout/{pid}"); page.click("[data-action=kaspi]"); page.wait_for_selector(".kaspi-modal img"); check_page(page, f"Страницы ({tag})", "Окно Kaspi", lang)
            ctx.close()
            ctx, page, _ = new_ctx(b, user=False, lang=lang, dark=dark)
            for name, h in [("Вход", "#/login"), ("Регистрация", "#/register"), ("Избранное (гость)", "#/favorites"), ("Заказы (гость)", "#/orders"), ("Профиль (гость)", "#/profile")]:
                goto(page, h); check_page(page, f"Страницы ({tag})", name, lang)
            ctx.close()

# ---------- клик по каждой кнопке ----------
CLICKABLES_JS = r"""
() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const sig = (el) => { const d = el.dataset; const keys = Object.keys(d).filter(k => !/id$/i.test(k) || k === 'routeId').map(k => k + '=' + (['fav','routeId','id'].includes(k) ? '*' : d[k])); const h = el.getAttribute('href') || ''; return el.tagName + '|' + keys.join(',') + '|' + h.replace(/n\d+|CS[A-Z0-9]+/g, '*').replace(/search\/[^?]+/, 'search/*') + '|' + (keys.length || h ? '' : (el.getAttribute('aria-label') || el.innerText).trim().slice(0, 30)); };
  const all = [...document.querySelectorAll('button:not([disabled]), a[href]')];
  const seen = new Set(); const out = [];
  all.forEach((el, i) => { if (!vis(el) || el.closest('.leaflet-control') || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-current') === 'page') return; const s = sig(el); if (seen.has(s)) return; seen.add(s); out.push({ i, sig: s, label: ((el.getAttribute('aria-label') || el.innerText || '').trim().replace(/\s+/g, ' ')).slice(0, 40) }); });
  return out;
}
"""
STATE_JS = "() => location.hash + '|' + document.documentElement.lang + '|' + document.querySelectorAll('.kaspi-modal,.geo-pop,.toast,#q').length + '|' + document.body.innerText.length + '|' + localStorage.length + '|' + document.documentElement.className + '|' + (document.querySelector('[aria-pressed=true]')||{}).outerHTML"

def click_everything(b):
    routes = [("Лента", "#/feed", True), ("Набор", "#/place/n7001", True), ("Оформление", "#/checkout/n7001", True), ("Билет", None, True),
              ("Карта", "#/map", True), ("Заказы", "#/orders", True), ("Избранное", "#/favorites", True), ("Профиль", "#/profile", True),
              ("Вход", "#/login", False), ("Лента (гость)", "#/feed", False), ("Набор (гость)", "#/place/n7001", False)]
    ctx0, p0, _ = new_ctx(b, user=True); oid = make_order(p0); orders = p0.evaluate("localStorage.getItem('cs_orders')"); ctx0.close()
    for name, h, user in routes:
        h = h or f"#/ticket/{oid}"
        ctx, page, _ = new_ctx(b, user=user, storage={"cs_orders": json.loads(orders)} if user else None)
        snap = {"v": None}
        def load():
            goto(page, h)
            if snap["v"] is None: snap["v"] = page.evaluate("JSON.stringify(localStorage)")
            else:
                page.evaluate("s => { localStorage.clear(); const o = JSON.parse(s); for (const k in o) localStorage.setItem(k, o[k]); }", snap["v"])
                goto(page, h)
            if "feed" in h: wait_feed(page)
            if "map" in h: page.wait_for_selector(".leaflet-container"); page.wait_for_timeout(700)
            if "ticket" in h: page.wait_for_selector("#tqr svg")
        load()
        items = page.evaluate(CLICKABLES_JS)
        dead, errs, okc = [], [], 0
        for it in items:
            if it["sig"].split("|")[2] == h: continue  # ссылка на текущую страницу
            load(); page._errs.clear()
            before = page.evaluate(STATE_JS)
            el = page.locator("button:not([disabled]), a[href]").nth(it["i"])
            pages_before = len(ctx.pages)
            try:
                el.scroll_into_view_if_needed(timeout=3000)
                el.click(timeout=4000, no_wait_after=True)
            except Exception as e:
                dead.append(f"{it['label']} ({it['sig']}): не нажимается — {str(e).splitlines()[0][:80]}"); continue
            page.wait_for_timeout(1300)
            try: after = page.evaluate(STATE_JS) if BASE.split('#')[0] in page.url else "navigated:" + page.url
            except Exception: after = "navigated:" + page.url
            newtab = len(ctx.pages) > pages_before
            if newtab:
                np_ = ctx.pages[-1]
                try: np_.wait_for_load_state(timeout=6000)
                except Exception: pass
                u = np_.url
                if not u.startswith("https://") and u != "about:blank": dead.append(f"{it['label']}: новая вкладка с адресом {u}")
                np_.close()
            if after.startswith("navigated:") and not after.startswith("navigated:https://"): dead.append(f"{it['label']}: ушёл на {after}")
            elif before == after and not newtab and not page._errs:
                dead.append(f"{it['label']} ({it['sig']}): ничего не происходит")
            elif page._errs:
                errs.append(f"{it['label']}: {page._errs[:2]}")
            else: okc += 1
        rec("Все кнопки", f"{name}: {len(items)} разных кнопок/ссылок", not dead and not errs, "; ".join(dead + errs))
        ctx.close()

# ---------- сценарии ----------
def scenarios(b):
    G = "Сценарии"
    # 1. Ссылка «Поделиться» на набор в новом браузере
    ctx, page, _ = new_ctx(b)
    goto(page, "#/place/n7004"); page.wait_for_timeout(2500)
    rec(G, "ссылка на набор открывается в новом браузере (Поделиться)", "#/place/n7004" in page.url and page.locator("[data-action=book]").count() == 1, page.url)
    ctx.close()
    # 2. Билет по ссылке в новом браузере
    ctx, page, _ = new_ctx(b, user=True); oid = make_order(page); ctx.close()
    ctx, page, _ = new_ctx(b); goto(page, f"#/ticket/{oid}"); page.wait_for_timeout(800)
    rec(G, "чужой/неизвестный билет показывает понятное сообщение", page.locator("text=/не найден|not found/i").count() > 0, page.inner_text("#root")[:150])
    ctx.close()
    # 3. Неизвестный адрес → лента
    ctx, page, _ = new_ctx(b); goto(page, "#/abracadabra"); page.wait_for_timeout(800)
    rec(G, "неизвестный адрес ведёт на ленту", "#/feed" in page.url, page.url); ctx.close()
    # 4. Битая ссылка оплаты
    ctx, page, _ = new_ctx(b, lang="en"); goto(page, "#/pay/xxx"); page.wait_for_timeout(500)
    rec(G, "битая ссылка оплаты — сообщение на языке интерфейса", page.locator("text=/payment link|ссылка/i").count() > 0 and "Ссылка" not in page.inner_text("#root"), page.inner_text("#root")[:150]); ctx.close()
    # 5. Таймер брони истекает
    ctx, page, _ = new_ctx(b, user=True)
    page.clock.install()
    goto(page, "#/checkout/n7001"); page.wait_for_selector("[data-action=kaspi]")
    page.clock.fast_forward("10:05")
    page.wait_for_timeout(500)
    txt = page.inner_text("#root")
    rec(G, "бронь истекает через 10 минут и показывает сообщение", re.search("закончил|expired|аяқталды", txt.lower()) and page.locator("[data-action=kaspi]").count() == 0, txt[txt.find('00:'):txt.find('00:') + 80] if '00:' in txt else txt[:200])
    ctx.close()
    # 6. Двойной клик «Оплатил»
    ctx, page, _ = new_ctx(b, user=True)
    goto(page, "#/checkout/n7001"); page.click("[data-action=kaspi]"); page.wait_for_selector("[data-paid]")
    page.locator("[data-paid]").dblclick(); page.wait_for_selector("#tqr svg", timeout=10000)
    n = len(json.loads(page.evaluate("localStorage.getItem('cs_orders')")))
    rec(G, "двойное нажатие «Оплатил» создаёт один заказ", n == 1, n); ctx.close()
    # 7. Распроданный набор
    ctx, page, _ = new_ctx(b, user=True, storage={"cs_sold": {f"n{7000+i}": 9 for i in range(200)}})
    goto(page, "#/place/n7002"); page.wait_for_timeout(500)
    dis = page.locator("[data-action=book][disabled]").count()
    goto(page, "#/checkout/n7002"); page.wait_for_timeout(800)
    rec(G, "распроданный набор нельзя забронировать (и по прямой ссылке)", dis == 1 and "#/checkout" not in page.url, f"кнопка disabled={dis}, url={page.url}"); ctx.close()
    # 8. Окно выдачи прошло → билет
    ctx, page, _ = new_ctx(b, user=True); oid = make_order(page)
    page.evaluate("""() => { const o = JSON.parse(localStorage.getItem('cs_orders')); o[0].window = 'Сегодня 08:00–09:00'; o[0].createdAt = Date.now() - 86400000; localStorage.setItem('cs_orders', JSON.stringify(o)); }""")
    goto(page, f"#/ticket/{oid}"); page.wait_for_timeout(500)
    t = page.inner_text("#root")
    rec(G, "просроченный заказ не показывает «Можно забрать»", "Можно забрать" not in t, t[:160])
    goto(page, "#/orders"); page.wait_for_timeout(300)
    rec(G, "бейдж заказов не считает просроченные", page.locator(".cs-badge").count() == 0)
    ctx.close()
    # 9. Поиск без результатов + очистка
    ctx, page, _ = new_ctx(b); goto(page, "#/feed"); wait_feed(page)
    page.click("[data-action=search]"); page.fill("#q", "zzzzqqq"); page.wait_for_timeout(300)
    empty = page.locator("h4").count() == 0 and page.locator("text=/Ничего|не найдено|нет/i").count() > 0
    page.click("[data-action=search]"); page.wait_for_timeout(300)
    rec(G, "поиск без результатов → пустое состояние; закрытие поиска возвращает ленту", empty and page.locator("h4").count() > 0, page.inner_text("#root")[:200]); ctx.close()
    # 10. Сервер карт недоступен → повтор
    m = Mock(); m.overpass_down = True
    ctx, page, _ = new_ctx(b, mock=m); goto(page, "#/feed"); page.wait_for_selector("[data-action=retry]", timeout=60000)
    m.overpass_down = False; page.click("[data-action=retry]")
    try: page.wait_for_selector("h4", timeout=20000); okr = True
    except Exception: okr = False
    rec(G, "при падении сервера карт — «Повторить» восстанавливает ленту", okr); ctx.close()
    # 11. GPS разрешён
    ctx, page, _ = new_ctx(b, geo={"latitude": 43.2200, "longitude": 76.8500}); goto(page, "#/feed"); wait_feed(page)
    page.wait_for_timeout(1500)
    lbl = page.inner_text("[data-action=pop]")
    rec(G, "при разрешённой геолокации — «Рядом с вами» и места вокруг", "Рядом" in lbl, lbl); ctx.close()
    # 12. GPS запрещён и IP не работает
    m = Mock(); m.ip_ok = False
    ctx, page, _ = new_ctx(b, mock=m); goto(page, "#/feed"); wait_feed(page)
    page.click("[data-action=pop]"); page.click(".geo-pop [data-action=locate]"); page.wait_for_timeout(2500)
    msg = page.locator("[role=alert]").all_inner_texts()
    rec(G, "нет геолокации и IP — понятное сообщение, лента остаётся", bool(msg) and page.locator("h4").count() > 0, msg); ctx.close()
    # 13. Язык и тема сохраняются
    ctx, page, _ = new_ctx(b, user=True); goto(page, "#/profile")
    page.click("[data-lang=en]"); page.click("[data-action=theme]"); page.reload(); page.wait_for_timeout(800)
    rec(G, "язык и тёмная тема сохраняются после перезагрузки", "Map" in page.inner_text("body") and page.evaluate("document.documentElement.classList.contains('dark')") and page.evaluate("document.documentElement.lang") == "en")
    rec(G, "в профиле есть выбор языка", page.locator("[data-lang]").count() == 3); ctx.close()
    # 14. Выход → защищённые страницы просят вход
    ctx, page, _ = new_ctx(b, user=True); goto(page, "#/profile"); page.click("[data-action=logout]"); page.wait_for_timeout(300)
    goto(page, "#/checkout/n7001"); page.wait_for_timeout(400)
    rec(G, "после выхода оформление просит войти", "#/login" in page.url, page.url)
    page.fill("input[name=email]", "a@b.kz"); page.fill("input[name=pw]", "1234"); page.click("#auth button[type=submit]"); page.wait_for_timeout(800)
    rec(G, "после входа возвращает на оформление", "#/checkout/n7001" in page.url, page.url); ctx.close()
    # 15. Ссылка из QR оплаты в новом браузере
    ctx, page, _ = new_ctx(b, user=True); oid = make_order(page)
    payload = page.evaluate("""async () => { const m = await import('./js/lib.js'); const o = JSON.parse(localStorage.getItem('cs_orders'))[0]; return m.b64urlEncode(m.packOrder(o)); }""")
    ctx.close(); ctx, page, _ = new_ctx(b); goto(page, f"#/pay/{payload}"); page.wait_for_timeout(1500)
    rec(G, "ссылка из QR оплаты открывает билет", "#/ticket/" in page.url and page.locator("#tqr svg").count() == 1, page.url); ctx.close()
    # 16. «Назад» при прямом заходе
    ctx, page, _ = new_ctx(b); goto(page, "#/place/n7001"); page.wait_for_timeout(1500)
    if page.locator("[data-action=back]").count():
        page.click("[data-action=back]"); page.wait_for_timeout(800)
        rec(G, "«Назад» на странице набора при прямом заходе ведёт в ленту", "#/feed" in page.url and "crumbsave" in page.url or "localhost" in page.url, page.url)
    else: rec(G, "«Назад» на странице набора при прямом заходе ведёт в ленту", False, "нет страницы набора")
    ctx.close()
    # 17. Поделиться → сообщение «Ссылка скопирована»
    ctx, page, _ = new_ctx(b); ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    goto(page, "#/feed"); wait_feed(page); page.locator("h4").first.click(); page.wait_for_selector("[data-action=share]")
    page.evaluate("delete navigator.share"); page.click("[data-action=share]"); page.wait_for_timeout(400)
    rec(G, "«Поделиться» копирует ссылку и сообщает об этом", page.locator(".toast").count() == 1); ctx.close()
    # 18. Избранное: добавить/убрать на карточке и на странице
    ctx, page, _ = new_ctx(b, user=True); goto(page, "#/feed"); wait_feed(page)
    page.locator("[data-fav]").first.click(); page.wait_for_timeout(200)
    p1 = page.locator("[data-fav]").first.get_attribute("aria-pressed")
    goto(page, "#/favorites"); c1 = page.locator("h4").count()
    page.locator("[data-fav]").first.click(); page.wait_for_timeout(300); c2 = page.locator("h4").count()
    rec(G, "избранное: добавить на карточке, убрать на странице избранного", p1 == "true" and c1 == 1 and c2 == 0, f"{p1} {c1} {c2}"); ctx.close()
    # 19. Валидация входа
    ctx, page, _ = new_ctx(b); goto(page, "#/register")
    page.click("#auth button[type=submit]"); e1 = page.inner_text("#auth-err")
    page.fill("input[name=name]", "Ann"); page.fill("input[name=email]", "bad"); page.click("#auth button[type=submit]"); e2 = page.inner_text("#auth-err")
    page.fill("input[name=email]", "a@b.kz"); page.fill("input[name=pw]", "1"); page.click("#auth button[type=submit]"); e3 = page.inner_text("#auth-err")
    rec(G, "регистрация: ошибки имени, email и пароля", all([e1, e2, e3]) and len({e1, e2, e3}) == 3, [e1, e2, e3]); ctx.close()
    # 20. Карта: попап → набор
    ctx, page, _ = new_ctx(b); goto(page, "#/map"); page.wait_for_selector(".leaflet-marker-icon"); page.wait_for_timeout(800)
    page.locator(".leaflet-marker-icon").last.click(force=True); page.wait_for_timeout(500)
    ok = page.locator(".leaflet-popup a").count() > 0
    if ok: page.locator(".leaflet-popup a").first.click(); page.wait_for_timeout(800)
    rec(G, "карта: метка → всплывашка → страница набора", ok and "#/place/" in page.url, page.url); ctx.close()
    # 21. Ширины экрана
    for w in [1024, 1280, 1920]:
        ctx, page, _ = new_ctx(b, w=w, user=True)
        bad = []
        for h in ["#/feed", "#/place/n7001", "#/checkout/n7001", "#/map", "#/orders", "#/profile", "#/login"]:
            goto(page, h); page.wait_for_timeout(700)
            ov = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            if ov > 1: bad.append(f"{h}:{ov}px")
        rec(G, f"нет горизонтального скролла при ширине {w}", not bad, bad); ctx.close()
    # 22. Скорость: лента при медленном сервере
    m = Mock(); m.slow = 2
    ctx, page, _ = new_ctx(b, mock=m); t0 = time.time(); goto(page, "#/feed"); wait_feed(page)
    dt = time.time() - t0
    rec(G, "лента появляется даже при медленном сервере (<6 с)", dt < 6 and page.locator("h4").count() > 0, f"{dt:.1f}s"); ctx.close()
    # 23. Экранирование (XSS)
    ctx, page, _ = new_ctx(b); goto(page, "#/feed"); wait_feed(page)
    page.click("[data-action=search]"); page.fill("#q", "Boom"); page.wait_for_timeout(300)
    rec(G, "название с HTML показывается как текст (нет XSS)", page.locator("h4 b").count() == 0 and page.locator("h4:has-text('<b>Boom</b>')").count() == 1)
    goto(page, "#/place/n7005"); page.wait_for_timeout(800)
    rec(G, "опасная ссылка сайта заведения не выводится", page.locator("a[href^='javascript']").count() == 0); ctx.close()

def main():
    t0 = time.time()
    if "static" in os.environ.get("ONLY", "static"): static_checks()
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        sel = os.environ.get("ONLY", "static,routes,clicks,scen").split(",")
        fns = {"routes": routes_matrix, "clicks": click_everything, "scen": scenarios}
        for key, fn in fns.items():
            if key not in sel: continue
            try: fn(b)
            except Exception as e:
                import traceback; tb = traceback.format_exc().splitlines(); rec(fn.__name__, "тест упал", False, " | ".join([l.strip() for l in tb if "audit.py" in l][-2:] + [l for l in tb if "Error" in l][-1:]))
        b.close()
    ok = sum(1 for r in RESULTS if r[2]); bad = [r for r in RESULTS if not r[2]]
    print(f"\n=== {ok}/{len(RESULTS)} проверок прошло за {time.time()-t0:.0f} с ===")
    for g, n, _, d in bad: print(f"FAIL [{g}] {n}\n      {d}")
    json.dump(RESULTS, open("/home/claude/qa/results.json", "w"), ensure_ascii=False, indent=1)

if __name__ == "__main__":
    main()
