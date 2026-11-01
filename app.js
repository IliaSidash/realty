// Apartments for buy-to-let on Cyprus, read from the scraper's Supabase database.
// Rent estimates, sea distance and building age come precomputed from the scraper;
// the mortgage maths runs here so parameters can be changed on the fly.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const SUPABASE_URL = 'https://fhaudosioofozmdmcmqm.supabase.co';
// Publishable key: safe in a browser; without a signed-in, allowed e-mail it reads nothing.
const SUPABASE_KEY = 'sb_publishable_TDyTWs5gCEBbjENCmG1S-A_cqhLLSr8';
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

const DEFAULTS = {
  down: 30, rate: 5, term: 25, costs: 20, pmin: 150000, pmax: 300000, sea: '', minSurplus: -100,
  cities: null, beds: [], onlyCovered: true, hideOffplan: true, likely: true, onlyReady: false, onlyBrandNew: true, sort: 'surplus',
};
const PAGE = 40;
const SETTINGS_KEY = 'settings-v2';
const BRAND_NEW = '10';
const COLUMNS =
  'id,title,price,sqm,bedrooms,city,district,url,lat,lng,est_rent,est_rent_low,est_rent_high,est_basis,' +
  'sea_km,build_year,age_verdict,photo_verdict,first_seen_at,condition:attrs->>attrs__condition';

const $ = (id) => document.getElementById(id);
const eur = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}
const settings = loadSettings();
let listings = [];
let shown = PAGE;
let map = null;
let markers = null;

// --- Money ---------------------------------------------------------------------------

function monthlyPayment(principal, ratePct, years) {
  const n = years * 12, r = ratePct / 100 / 12;
  return r === 0 ? principal / n : (principal * r) / (1 - (1 + r) ** -n);
}

function evaluate(l) {
  const loan = l.price * (1 - settings.down / 100);
  const payment = monthlyPayment(loan, settings.rate, settings.term);
  const netRent = l.est_rent * (1 - settings.costs / 100);
  return { loan, payment, netRent, surplus: netRent - payment, yieldPct: (l.est_rent * 1200) / l.price };
}

// --- Data ------------------------------------------------------------------------------

async function fetchListings() {
  $('count').textContent = 'Загрузка…';
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('residential_listings')
      .select(COLUMNS)
      .eq('status', 'active')
      .eq('listing_type', 'buy')
      .eq('segment', 'apartment')
      .gte('price', settings.pmin || 0)
      .lte('price', settings.pmax || 1e9)
      .not('est_rent', 'is', null)
      .in('age_verdict', ['young', 'likely_young'])
      .order('id')
      .range(from, from + 999);
    if (error) {
      $('count').textContent = `Не удалось загрузить: ${error.message}`;
      return;
    }
    rows.push(...data);
    if (data.length < 1000) break;
  }
  listings = rows.map((l) => ({ ...l, price: +l.price, est_rent: +l.est_rent, sea_km: l.sea_km === null ? null : +l.sea_km }));
  if (rows.length === 0) {
    $('count').textContent = 'Нет данных. Если вы только вошли, проверьте, что ваша почта добавлена в app_users.';
  }
  renderChips();
  render();
}

async function priceHistory(id) {
  const { data, error } = await db.from('residential_price_history').select('price,seen_at').eq('listing_id', id).order('seen_at');
  if (error) return `не удалось загрузить: ${esc(error.message)}`;
  if (data.length <= 1) return 'цена не менялась';
  return data.map((h) => `${eur.format(h.price)} (${new Date(h.seen_at).toLocaleDateString('ru-RU')})`).join(' → ');
}

// --- Filters ---------------------------------------------------------------------------

function visible() {
  const sea = settings.sea === '' ? null : Number(settings.sea);
  return listings
    .filter((l) => (settings.cities === null || settings.cities.includes(l.city)))
    .filter((l) => settings.beds.length === 0 || settings.beds.includes(String(Math.min(l.bedrooms ?? 0, 4))))
    .filter((l) => sea === null || (l.sea_km !== null && l.sea_km <= sea))
    .filter((l) => settings.likely || l.age_verdict === 'young')
    .filter((l) => !settings.hideOffplan || !['off_plan', 'removed', 'old'].includes(l.photo_verdict))
    .filter((l) => !settings.onlyReady || l.photo_verdict === 'ready')
    .filter((l) => !settings.onlyBrandNew || l.condition === BRAND_NEW)
    .map((l) => ({ ...l, ...evaluate(l) }))
    .filter((l) => !settings.onlyCovered || l.surplus >= settings.minSurplus)
    .sort({
      surplus: (a, b) => b.surplus - a.surplus,
      yield: (a, b) => b.yieldPct - a.yieldPct,
      price: (a, b) => a.price - b.price,
      sea: (a, b) => (a.sea_km ?? 99) - (b.sea_km ?? 99),
      new: (a, b) => (b.first_seen_at ?? '').localeCompare(a.first_seen_at ?? ''),
    }[settings.sort]);
}

function chipGroup(el, options, isOn, toggle) {
  el.innerHTML = '';
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(isOn(value)));
    b.addEventListener('click', () => { toggle(value); saveSettings(); renderChips(); shown = PAGE; render(); });
    el.appendChild(b);
  }
}

function renderChips() {
  const cities = [...new Set(listings.map((l) => l.city))].sort();
  if (settings.cities === null && cities.length) settings.cities = cities.filter((c) => c !== 'Nicosia');
  chipGroup($('cities'), cities.map((c) => [c, c]), (c) => settings.cities?.includes(c), (c) => {
    settings.cities = settings.cities.includes(c) ? settings.cities.filter((x) => x !== c) : [...settings.cities, c];
  });
  chipGroup($('beds'), [['0', 'студия'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4+']], (b) => settings.beds.includes(b), (b) => {
    settings.beds = settings.beds.includes(b) ? settings.beds.filter((x) => x !== b) : [...settings.beds, b];
  });
}

// --- Rendering -------------------------------------------------------------------------

const seaText = (km) => (km === null ? '' : km < 1 ? `${Math.round(km * 10) * 100} м до моря` : `${km.toFixed(1).replace('.', ',')} км до моря`);
const ageText = (l) => (l.build_year ? `${l.build_year} г.` : 'новое, год не указан');
const photoTag = (v) =>
  ({ ready: '<span class="tag good">фото: готовая</span>', off_plan: '<span class="tag warn">фото: строится</span>',
     removed: '<span class="tag warn">снято</span>', old: '<span class="tag warn">фото: старая</span>' })[v] ??
  '<span class="tag">фото не проверены</span>';
const isNew = (l) => l.first_seen_at && Date.now() - Date.parse(l.first_seen_at) < 3 * 24 * 3600 * 1000;

function card(l) {
  const rooms = l.bedrooms === 0 ? 'студия' : `${l.bedrooms} спал.`;
  return `<article class="card">
    <div class="card-head">
      <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <span class="price">${eur.format(l.price)}</span>
    </div>
    <div class="meta">
      <span>${esc(l.city)}, ${esc(l.district ?? '')}</span><span>${rooms}, ${Math.round(l.sqm)} м²</span>
      <span>${ageText(l)}</span><span>${seaText(l.sea_km)}</span>
      ${photoTag(l.photo_verdict)}${l.condition === BRAND_NEW ? '<span class="tag good">новостройка</span>' : '<span class="tag">вторичка</span>'}${isNew(l) ? '<span class="tag good">новое</span>' : ''}
    </div>
    <div class="money">
      <span class="pill ${l.surplus >= 0 ? 'good' : 'bad'}">${l.surplus >= 0 ? '+' : ''}${eur.format(l.surplus)}/мес</span>
      <span>аренда ≈ <span class="num">${eur.format(l.est_rent)}</span> (${eur.format(l.est_rent_low)}–${eur.format(l.est_rent_high)}${l.est_basis === 'city' ? ', по городу' : ''})</span>
      <span>платёж <span class="num">${eur.format(l.payment)}</span></span>
      <span>доходность ${l.yieldPct.toFixed(1).replace('.', ',')}%</span>
      <button type="button" class="link" data-history="${l.id}">история цены</button>
    </div>
    <div class="history" id="h-${l.id}"></div>
  </article>`;
}

function render() {
  const list = visible();
  $('count').textContent = `${list.length} из ${listings.length} квартир в ценовом диапазоне`;
  $('list').innerHTML = list.length
    ? list.slice(0, shown).map(card).join('')
    : '<div class="empty">Ничего не подходит. Ослабьте фильтры или поменяйте параметры ипотеки.</div>';
  $('more').hidden = shown >= list.length;
  if (map && !$('map').hidden) renderMap(list);
}

function renderMap(list) {
  markers.clearLayers();
  for (const l of list) {
    if (l.lat === null || l.lng === null) continue;
    L.circleMarker([l.lat, l.lng], {
      radius: 6, weight: 1, color: l.surplus >= 0 ? '#1d7a3b' : '#a3361c', fillOpacity: 0.7,
    })
      .bindPopup(`<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a><br>${eur.format(l.price)} · ${l.surplus >= 0 ? '+' : ''}${eur.format(l.surplus)}/мес`)
      .addTo(markers);
  }
}

// --- Wiring ----------------------------------------------------------------------------

function bindInputs() {
  const fields = { down: 'down', rate: 'rate', term: 'term', costs: 'costs', pmin: 'pmin', pmax: 'pmax', sea: 'sea', 'min-surplus': 'minSurplus' };
  let refetch = null;
  for (const [id, key] of Object.entries(fields)) {
    $(id).value = settings[key];
    $(id).addEventListener('input', () => {
      settings[key] = id === 'sea' ? $(id).value : Number($(id).value);
      saveSettings();
      if (id === 'pmin' || id === 'pmax') {
        clearTimeout(refetch);
        refetch = setTimeout(fetchListings, 600);
      } else {
        shown = PAGE;
        render();
      }
    });
  }
  for (const [id, key] of [['only-covered', 'onlyCovered'], ['hide-offplan', 'hideOffplan'], ['likely', 'likely'], ['only-ready', 'onlyReady'], ['only-brand-new', 'onlyBrandNew']]) {
    $(id).checked = settings[key];
    $(id).addEventListener('change', () => { settings[key] = $(id).checked; saveSettings(); shown = PAGE; render(); });
  }
  $('sort').value = settings.sort;
  $('sort').addEventListener('change', () => { settings.sort = $('sort').value; saveSettings(); render(); });
  $('more').addEventListener('click', () => { shown += PAGE; render(); });
  $('list').addEventListener('click', async (e) => {
    const id = e.target?.dataset?.history;
    if (id) $(`h-${id}`).innerHTML = await priceHistory(id);
  });
  $('toggle-map').addEventListener('click', () => {
    $('map').hidden = !$('map').hidden;
    if (!$('map').hidden && !map) {
      map = L.map('map').setView([34.85, 33.2], 9);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18, attribution: '© OpenStreetMap contributors',
      }).addTo(map);
      markers = L.layerGroup().addTo(map);
    }
    render();
  });
}

let started = false;
async function start() {
  const { data } = await db.auth.getSession();
  const session = data.session;
  $('login').hidden = Boolean(session);
  $('app').hidden = !session;
  $('logout').hidden = !session;
  $('who').textContent = session?.user?.email ?? '';
  if (!session || started) return;
  started = true;
  bindInputs();
  fetchListings();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  $('login-msg').textContent = 'Отправляем…';
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true },
  });
  $('login-msg').textContent = error ? `Не получилось: ${error.message}` : 'Ссылка отправлена. Откройте письмо на этом устройстве.';
});
$('logout').addEventListener('click', async () => { await db.auth.signOut(); location.reload(); });
db.auth.onAuthStateChange((event) => { if (event === 'SIGNED_IN' && $('app').hidden) start(); });
start();
