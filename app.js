import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const SUPABASE_URL = 'https://fhaudosioofozmdmcmqm.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_TDyTWs5gCEBbjENCmG1S-A_cqhLLSr8';
const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const PAGE_SIZE = 40;
const SETTINGS_KEY = 'marketplace-v1';
const REFETCH_DELAY_MS = 450;
const NEW_LISTING_DAYS = 3;
const CITIES = ['Limassol', 'Larnaca', 'Paphos', 'Nicosia', 'Famagusta'];
const FOUR_OR_MORE = '4';
const FOUR_OR_MORE_BEDROOMS = [4, 5, 6, 7, 8, 9, 10, 11, 12];
const BEDROOM_CHOICES = [['0', 'студия'], ['1', '1'], ['2', '2'], ['3', '3'], [FOUR_OR_MORE, '4+']];
const VAT_ON_TOP = ['plus', 'likely_plus'];
const VAT_NONE = ['included', 'likely_none'];
const PHOTO_REJECTED = ['off_plan', 'removed', 'old'];

const DEFAULT_FILTERS = {
  segment: 'apartment', deal: 'buy', cities: [], district: '', sea: '',
  pmin: '', pmax: '', smin: '', smax: '', beds: [], condition: 'any', year: '',
  pv: 'any', vat: 'any', photosReady: false, hideRejected: true, days: '', sort: 'newest',
};
const DEFAULT_CALC = { down: 30, rate: 5, term: 25, costs: 20, vatRate: '0' };

const COLUMNS = [
  'id', 'title', 'segment', 'listing_type', 'property_type', 'price', 'sqm', 'price_per_sqm', 'bedrooms',
  'city', 'district', 'url', 'lat', 'lng', 'photo_url', 'first_seen_at',
  'est_rent', 'est_rent_low', 'est_rent_high', 'est_basis', 'est_yield',
  'sea_km', 'build_year', 'age_verdict', 'photo_verdict', 'is_new_build', 'vat', 'pv',
].join(',');

const $ = (id) => document.getElementById(id);
const eur = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const count = new Intl.NumberFormat('ru-RU');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return { filters: { ...DEFAULT_FILTERS, ...saved.filters }, calc: { ...DEFAULT_CALC, ...saved.calc } };
  } catch {
    return { filters: { ...DEFAULT_FILTERS }, calc: { ...DEFAULT_CALC } };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ filters, calc }));
  } catch {
    return;
  }
}
let { filters, calc } = loadSettings();
let loaded = [];
let total = 0;
let requestId = 0;
let map = null;
let markers = null;

function monthlyPayment(principal, ratePct, years) {
  const months = years * 12;
  const monthlyRate = ratePct / 100 / 12;
  return monthlyRate === 0 ? principal / months : (principal * monthlyRate) / (1 - (1 + monthlyRate) ** -months);
}

function purchasePrice(listing) {
  const vatRate = Number(calc.vatRate);
  return VAT_ON_TOP.includes(listing.vat) ? listing.price * (1 + vatRate / 100) : listing.price;
}

function mortgage(listing) {
  const price = purchasePrice(listing);
  const payment = monthlyPayment(price * (1 - calc.down / 100), calc.rate, calc.term);
  const surplus = listing.est_rent * (1 - calc.costs / 100) - payment;
  return { price, payment, surplus, yieldPct: (listing.est_rent * 1200) / price };
}

function buildQuery(offset) {
  const f = filters;
  let q = db
    .from('residential_listings')
    .select(COLUMNS, { count: 'exact' })
    .eq('status', 'active')
    .eq('segment', f.segment)
    .eq('listing_type', f.deal);
  if (f.cities.length) q = q.in('city', f.cities);
  if (f.district.trim()) q = q.ilike('district', `%${f.district.trim()}%`);
  if (f.sea !== '') q = q.lte('sea_km', Number(f.sea));
  if (f.pmin !== '') q = q.gte('price', Number(f.pmin));
  if (f.pmax !== '') q = q.lte('price', Number(f.pmax));
  if (f.smin !== '') q = q.gte('sqm', Number(f.smin));
  if (f.smax !== '') q = q.lte('sqm', Number(f.smax));
  if (f.beds.length) q = q.in('bedrooms', f.beds.flatMap((b) => (b === FOUR_OR_MORE ? FOUR_OR_MORE_BEDROOMS : [Number(b)])));
  if (f.condition === 'new_build') q = q.eq('is_new_build', true).neq('age_verdict', 'off_plan');
  if (f.condition === 'resale') q = q.eq('is_new_build', false).neq('age_verdict', 'off_plan');
  if (f.condition === 'off_plan') q = q.eq('age_verdict', 'off_plan');
  if (f.year !== '') q = q.gte('build_year', Number(f.year));
  if (f.pv === 'yes') q = q.eq('pv', 'yes');
  if (f.pv === 'yes_or_provision') q = q.in('pv', ['yes', 'provision']);
  if (f.deal === 'buy' && f.vat === 'plus') q = q.in('vat', VAT_ON_TOP);
  if (f.deal === 'buy' && f.vat === 'none') q = q.in('vat', VAT_NONE);
  if (f.photosReady) q = q.eq('photo_verdict', 'ready');
  else if (f.hideRejected) q = q.or(`photo_verdict.is.null,photo_verdict.not.in.(${PHOTO_REJECTED.join(',')})`);
  if (f.days !== '') q = q.gte('first_seen_at', new Date(Date.now() - Number(f.days) * 86_400_000).toISOString());

  const order = {
    newest: ['first_seen_at', { ascending: false }],
    price_asc: ['price', { ascending: true }],
    price_desc: ['price', { ascending: false }],
    ppsqm: ['price_per_sqm', { ascending: true, nullsFirst: false }],
    sea: ['sea_km', { ascending: true, nullsFirst: false }],
    yield: ['est_yield', { ascending: false, nullsFirst: false }],
  }[f.sort];
  return q.order(...order).order('id').range(offset, offset + PAGE_SIZE - 1);
}

async function fetchPage(reset) {
  const id = ++requestId;
  if (reset) {
    loaded = [];
    $('list').innerHTML = '';
  }
  $('count').textContent = 'Загрузка…';
  $('more').hidden = true;
  const { data, error, count: found } = await buildQuery(loaded.length);
  if (id !== requestId) return;
  if (error) {
    $('count').textContent = `Не удалось загрузить: ${error.message}`;
    return;
  }
  total = found ?? 0;
  loaded.push(...data.map((l) => ({ ...l, price: Number(l.price), est_rent: l.est_rent === null ? null : Number(l.est_rent) })));
  render();
}

let refetchTimer = null;
function refetchSoon() {
  saveSettings();
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(() => fetchPage(true), REFETCH_DELAY_MS);
}

async function priceHistory(listingId) {
  const { data, error } = await db
    .from('residential_price_history')
    .select('price,seen_at')
    .eq('listing_id', listingId)
    .order('seen_at');
  if (error) return `не удалось загрузить: ${esc(error.message)}`;
  if (data.length <= 1) return 'цена не менялась';
  return data.map((h) => `${eur.format(h.price)} (${new Date(h.seen_at).toLocaleDateString('ru-RU')})`).join(' → ');
}

const isRent = (l) => l.listing_type === 'rent';
const isOffPlan = (l) => l.age_verdict === 'off_plan' || l.photo_verdict === 'off_plan';
const isFresh = (l) => l.first_seen_at && Date.now() - Date.parse(l.first_seen_at) < NEW_LISTING_DAYS * 86_400_000;
const seaText = (km) => (km === null ? '' : km < 1 ? `${Math.round(km * 10) * 100} м до моря` : `${String(Number(km).toFixed(1)).replace('.', ',')} км до моря`);
const roomsText = (l) => (l.bedrooms === null ? '' : l.bedrooms === 0 ? 'студия' : `${l.bedrooms} спал.`);

function stateTags(l) {
  const tags = [];
  if (isOffPlan(l)) tags.push(['warn', 'строится']);
  else if (l.is_new_build) tags.push(['good', 'новостройка']);
  else if (l.is_new_build === false) tags.push(['', 'вторичка']);
  if (l.photo_verdict === 'ready') tags.push(['good', 'фото: готовая']);
  if (l.photo_verdict === 'removed') tags.push(['warn', 'снято']);
  if (l.photo_verdict === 'old') tags.push(['warn', 'фото: старая']);
  if (l.pv === 'yes') tags.push(['good', '☀️ фотовольтаика']);
  if (l.pv === 'provision') tags.push(['', '☀️ подготовка под фотовольтаику']);
  if (isFresh(l)) tags.push(['good', 'новое объявление']);
  return tags.map(([kind, text]) => `<span class="tag ${kind}">${text}</span>`).join('');
}

function priceBlock(l) {
  if (isRent(l)) return `<span class="price">${eur.format(l.price)}<small>/мес</small></span>`;
  if (!VAT_ON_TOP.includes(l.vat)) {
    const note = l.vat === 'included' ? 'НДС включён / не взимается' : l.vat === 'likely_none' ? 'вероятно без НДС' : '';
    return `<span class="price">${eur.format(l.price)}</span>${note ? `<span class="vat-note">${note}</span>` : ''}`;
  }
  const label = l.vat === 'plus' ? 'НДС сверху' : 'вероятно НДС сверху';
  return `<span class="price">${eur.format(l.price)}</span>
    <span class="vat-prices"><span class="vat-note">${label}:</span>
      <span>с 5% <b class="num">${eur.format(l.price * 1.05)}</b></span>
      <span>с 19% <b class="num">${eur.format(l.price * 1.19)}</b></span></span>`;
}

function mortgageBlock(l) {
  if (isRent(l) || l.segment !== 'apartment' || l.est_rent === null) return '';
  const m = mortgage(l);
  const priceNote = m.price !== l.price ? ` от ${eur.format(m.price)}` : '';
  return `<div class="money">
    <span class="pill ${m.surplus >= 0 ? 'good' : 'bad'}">${m.surplus >= 0 ? '+' : '−'}${eur.format(Math.abs(m.surplus))}/мес</span>
    <span>аренда ≈ <span class="num">${eur.format(l.est_rent)}</span> (${eur.format(l.est_rent_low)}–${eur.format(l.est_rent_high)}${l.est_basis === 'city' ? ', по городу' : ''})</span>
    <span>платёж <span class="num">${eur.format(m.payment)}</span>${priceNote}</span>
    <span>доходность ${m.yieldPct.toFixed(1).replace('.', ',')}%</span>
  </div>`;
}

function card(l) {
  const photo = l.photo_url
    ? `<img src="${esc(l.photo_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<div class="no-photo">нет фото</div>';
  const meta = [
    `${esc(l.city)}${l.district ? `, ${esc(l.district)}` : ''}`,
    esc(l.property_type ?? ''),
    roomsText(l),
    l.sqm ? `${Math.round(l.sqm)} м²` : '',
    !isRent(l) && l.price_per_sqm ? `${eur.format(l.price_per_sqm)}/м²` : '',
    l.build_year ? `${l.build_year} г.` : '',
    seaText(l.sea_km),
  ].filter(Boolean).map((s) => `<span>${s}</span>`).join('');
  return `<article class="card">
    <a class="thumb" href="${esc(l.url)}" target="_blank" rel="noopener">${photo}</a>
    <div class="card-body">
      <div class="card-head">
        <a class="title" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
        <div class="prices">${priceBlock(l)}</div>
      </div>
      <div class="meta">${meta}</div>
      <div class="tags">${stateTags(l)}</div>
      ${mortgageBlock(l)}
      <div><button type="button" class="link" data-history="${l.id}">история цены</button></div>
      <div class="history" id="h-${l.id}"></div>
    </div>
  </article>`;
}

function render() {
  $('count').textContent = `Найдено ${count.format(total)}, показано ${count.format(loaded.length)}`;
  $('list').innerHTML = loaded.length
    ? loaded.map(card).join('')
    : '<div class="empty">Ничего не найдено. Ослабьте фильтры.</div>';
  $('more').hidden = loaded.length >= total;
  if (map && !$('map').hidden) renderMap();
}

function renderMap() {
  markers.clearLayers();
  const points = [];
  for (const l of loaded) {
    if (l.lat === null || l.lng === null) continue;
    points.push([l.lat, l.lng]);
    L.circleMarker([l.lat, l.lng], { radius: 6, weight: 1, color: l.is_new_build ? '#1d7a3b' : '#0d6b66', fillOpacity: 0.7 })
      .bindPopup(`<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a><br>${eur.format(l.price)}`)
      .addTo(markers);
  }
  if (points.length) map.fitBounds(points, { padding: [20, 20], maxZoom: 14 });
}

function chipGroup(el, options, isOn, onToggle) {
  el.innerHTML = '';
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(isOn(value)));
    b.addEventListener('click', () => {
      onToggle(value);
      renderChips();
      refetchSoon();
    });
    el.appendChild(b);
  }
}

const toggleIn = (list, value) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

function renderChips() {
  chipGroup($('segment'), [['apartment', 'Квартиры'], ['house', 'Дома']], (v) => filters.segment === v, (v) => { filters.segment = v; });
  chipGroup($('deal'), [['buy', 'Продажа'], ['rent', 'Аренда']], (v) => filters.deal === v, (v) => { filters.deal = v; });
  chipGroup($('cities'), CITIES.map((c) => [c, c]), (c) => filters.cities.includes(c), (c) => { filters.cities = toggleIn(filters.cities, c); });
  chipGroup($('beds'), BEDROOM_CHOICES, (b) => filters.beds.includes(b), (b) => { filters.beds = toggleIn(filters.beds, b); });
  $('vat').disabled = filters.deal === 'rent';
}

const FILTER_INPUTS = { district: 'district', sea: 'sea', pmin: 'pmin', pmax: 'pmax', smin: 'smin', smax: 'smax', year: 'year', days: 'days' };
const FILTER_SELECTS = { condition: 'condition', pv: 'pv', vat: 'vat', sort: 'sort' };
const FILTER_CHECKS = { 'photos-ready': 'photosReady', 'hide-rejected': 'hideRejected' };
const CALC_INPUTS = { down: 'down', rate: 'rate', term: 'term', costs: 'costs', 'vat-rate': 'vatRate' };

function fillControls() {
  for (const [id, key] of Object.entries({ ...FILTER_INPUTS, ...FILTER_SELECTS })) $(id).value = filters[key];
  for (const [id, key] of Object.entries(FILTER_CHECKS)) $(id).checked = filters[key];
  for (const [id, key] of Object.entries(CALC_INPUTS)) $(id).value = calc[key];
  renderChips();
}

function bindControls() {
  for (const [id, key] of Object.entries({ ...FILTER_INPUTS, ...FILTER_SELECTS })) {
    $(id).addEventListener('input', () => { filters[key] = $(id).value; refetchSoon(); });
  }
  for (const [id, key] of Object.entries(FILTER_CHECKS)) {
    $(id).addEventListener('change', () => { filters[key] = $(id).checked; refetchSoon(); });
  }
  for (const [id, key] of Object.entries(CALC_INPUTS)) {
    $(id).addEventListener('input', () => {
      calc[key] = key === 'vatRate' ? $(id).value : Number($(id).value);
      saveSettings();
      render();
    });
  }
  $('reset').addEventListener('click', () => {
    filters = { ...DEFAULT_FILTERS };
    fillControls();
    refetchSoon();
  });
  $('more').addEventListener('click', () => fetchPage(false));
  $('list').addEventListener('click', async (e) => {
    const listingId = e.target?.dataset?.history;
    if (listingId) $(`h-${listingId}`).innerHTML = await priceHistory(listingId);
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
  fillControls();
  bindControls();
  fetchPage(true);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-msg').textContent = 'Отправляем…';
  const { error } = await db.auth.signInWithOtp({
    email: $('email').value.trim(),
    options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true },
  });
  $('login-msg').textContent = error ? `Не получилось: ${error.message}` : 'Ссылка отправлена. Откройте письмо на этом устройстве.';
});
$('logout').addEventListener('click', async () => { await db.auth.signOut(); location.reload(); });
db.auth.onAuthStateChange((event) => { if (event === 'SIGNED_IN' && $('app').hidden) start(); });
start();
