/**
 * WineMap Phase 2 ステップ 5 — SPA + オンデマンドロード版
 *
 * 起動時は仏全土の地図 + 検索バー（+ 約 220 KB の search-index.json）のみ。
 * 検索クリック時に該当 region GeoJSON（data/france/regions/<slug>.geojson）を
 * オンデマンドで fetch → flyTo + 描画。
 * URL `?denom=xxx` でリンク共有可、リロードで状態復元。
 *
 * データ:
 *   - data/france/search-index.json:    1,277 denom × WGS84 centroid + region slug
 *   - data/france/regions/<slug>.geojson: dt 14 区分の地域別ポリゴン（C+ 案）
 *
 * スコープ注: INAO delim-parcellaire 対象 355 AOC（Champagne 除く）。
 *             Phase 2.5 で Champagne 補完予定。
 */

// === 1. 地図初期化（仏全土） ===
const FRANCE_BOUNDS = L.latLngBounds([41.0, -5.5], [51.5, 10.5]);
const map = L.map('map', {
  zoomControl: true,
  minZoom: 5,
  maxBounds: FRANCE_BOUNDS,
  maxBoundsViscosity: 0.6,
}).setView([46.5, 2.5], 6);

// === 2. 背景タイル ===
const IGN_WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
                 '&LAYER={layer}&STYLE=normal&FORMAT={fmt}' +
                 '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
const IGN_ATTRIB = '© <a href="https://geoservices.ign.fr/">IGN-F/Géoportail</a>';
const TILE_COMMON = { minZoom: 5 };

const baseLayers = {
  '標準地図（OSM）': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    ...TILE_COMMON, maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }),
  '衛星画像（IGN BDORTHO）': L.tileLayer(
    IGN_WMTS.replace('{layer}', 'ORTHOIMAGERY.ORTHOPHOTOS').replace('{fmt}', 'image/jpeg'),
    { ...TILE_COMMON, maxZoom: 19, attribution: `${IGN_ATTRIB} — BD ORTHO®` }
  ),
  '道路地図（IGN Plan V2）': L.tileLayer(
    IGN_WMTS.replace('{layer}', 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2').replace('{fmt}', 'image/png'),
    { ...TILE_COMMON, maxZoom: 19, attribution: `${IGN_ATTRIB} — Plan IGN V2` }
  ),
  '地形図（OpenTopoMap）': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    ...TILE_COMMON, maxZoom: 17,
    attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> / SRTM — Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
  }),
};
baseLayers['標準地図（OSM）'].addTo(map);

// 陰影起伏 overlay（zoom 15 まで）
map.createPane('hillshade');
map.getPane('hillshade').style.zIndex = 450;
map.getPane('hillshade').style.mixBlendMode = 'multiply';

const IGN_SHADOW_URL = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  '&LAYER=ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW&STYLE=estompage_grayscale&FORMAT=image/png' +
  '&TILEMATRIXSET=PM_0_15&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

const HILLSHADE_OVERLAY_NAME = '陰影起伏（IGN）';
const overlayLayers = {
  [HILLSHADE_OVERLAY_NAME]: L.tileLayer(IGN_SHADOW_URL, {
    minZoom: 5, maxZoom: 15, opacity: 0.85, pane: 'hillshade',
    attribution: `${IGN_ATTRIB} — Estompage (BD Alti®)`
  }),
};
L.control.layers(baseLayers, overlayLayers, { position: 'topleft', collapsed: true }).addTo(map);

// === 3. 5 階層スタイル定義 ===
const HIER_STYLE = {
  'Grand Cru':   { color: '#5a0000', fillColor: '#8b0000', weight: 1.5, fillOpacity: 0.55, label: 'グラン・クリュ', cls: 'grand-cru' },
  'Premier Cru': { color: '#7a2a2a', fillColor: '#c45a5a', weight: 1.0, fillOpacity: 0.45, label: 'プルミエ・クリュ', cls: 'premier-cru' },
  'Village':     { color: '#2a4a8a', fillColor: '#4a6cbd', weight: 0.8, fillOpacity: 0.40, label: 'ヴィラージュ', cls: 'village' },
  'Régionale':   { color: '#3a6aa0', fillColor: '#87b1de', weight: 0.8, fillOpacity: 0.20, label: 'レジョナル', cls: 'regionale' },
  'AOC':         { color: '#666',    fillColor: '#b0b0b0', weight: 0.5, fillOpacity: 0.30, label: 'AOC（その他）', cls: 'aoc' },
};
const HIDDEN_STYLE = { opacity: 0, fillOpacity: 0, weight: 0, interactive: false };

const state = {
  filter: { 'Grand Cru': true, 'Premier Cru': true, 'Régionale': true, 'Village': true, 'AOC': true },
  hillshadeOn: false,
  currentRegion: null,
};
const HILLSHADE_FILL_FACTOR = 0.55;
const hierarchyCounts = { 'Grand Cru': 0, 'Premier Cru': 0, 'Régionale': 0, 'Village': 0, 'AOC': 0 };

function styleFor(feature) {
  const h = feature.properties.hierarchy;
  if (!state.filter[h]) return HIDDEN_STYLE;
  const s = HIER_STYLE[h] || HIER_STYLE['AOC'];
  if (state.hillshadeOn) return { ...s, fillOpacity: s.fillOpacity * HILLSHADE_FILL_FACTOR };
  return s;
}

// === 4. ポップアップ ===
function popupHTML(props) {
  const hierMeta = HIER_STYLE[props.hierarchy] || HIER_STYLE['AOC'];
  const denomLine = (props.denom && props.denom !== props.app)
    ? `<div class="popup-section"><span class="popup-section-title">climat: </span>${props.denom}</div>`
    : '';
  return `<h3 class="popup-title">${props.app || '(unnamed)'}<span class="popup-hier ${hierMeta.cls}">${hierMeta.label}</span></h3>
    ${denomLine}
    <div class="popup-section">
      <span class="popup-section-title">地方: </span>${props.dt || '—'}
      &nbsp;&nbsp;<span class="popup-section-title">県: </span>${props.dept || '—'}
    </div>`;
}

// === 5. 凡例 ===
const legendBody = document.getElementById('legend-body');
const legendHint = document.getElementById('legend-hint');

function renderLegend() {
  legendBody.innerHTML = Object.entries(HIER_STYLE).map(([key, s]) => {
    const active = state.filter[key];
    const count = hierarchyCounts[key];
    return `<div class="legend-row${active ? '' : ' inactive'}" data-hier="${key}">
      <span class="swatch ${s.cls}"></span>${s.label}
      <span class="legend-count">${count.toLocaleString()}</span>
    </div>`;
  }).join('');
  const allOff = Object.values(state.filter).every(v => !v);
  legendHint.textContent = allOff ? 'すべて非表示中。凡例をクリックして階層を表示してください' : '';
}

// === 6. オンデマンドロード ===
const regionCache = new Map();   // slug -> GeoJSON object（重複 fetch 防止）
const regionLayers = new Map();  // slug -> L.GeoJSON layer
let searchIndex = [];
const spinner = document.getElementById('loading-spinner');
const spinnerText = spinner.querySelector('.spinner-text');

function fetchJson(path) {
  return fetch(path).then(res => {
    if (!res.ok) throw new Error(`${path} 読込失敗: ${res.status}`);
    return res.json();
  });
}

function bindFeature(feature, lyr) {
  lyr.on('click', e => {
    L.DomEvent.stopPropagation(e);
    const html = popupHTML(feature.properties);
    if (isMobile()) {
      showBottomSheet(html);
    } else {
      lyr.bindPopup(html, { maxWidth: 340 }).openPopup();
    }
  });
  lyr.on('mouseover', () => {
    if (state.filter[feature.properties.hierarchy]) lyr.setStyle({ weight: 2.5 });
  });
  lyr.on('mouseout', () => lyr.setStyle(styleFor(feature)));
}

// hierarchy 描画順序（前から呼ぶほど bringToFront で背面 → 前面、最後の Grand Cru が最前）
const HIER_FRONT_ORDER = ['AOC', 'Régionale', 'Village', 'Premier Cru', 'Grand Cru'];

function applyHierarchyOrder(layer) {
  for (const h of HIER_FRONT_ORDER) {
    layer.eachLayer(lyr => {
      if (lyr.feature.properties.hierarchy === h) lyr.bringToFront();
    });
  }
}

async function ensureRegionDisplayed(slug) {
  if (state.currentRegion === slug && regionLayers.has(slug) && map.hasLayer(regionLayers.get(slug))) {
    return;
  }
  spinner.classList.add('visible');
  spinnerText.textContent = `${slug} の畑データを読み込み中…`;
  try {
    if (!regionLayers.has(slug)) {
      let data = regionCache.get(slug);
      if (!data) {
        data = await fetchJson(`data/france/regions/${slug}.geojson`);
        regionCache.set(slug, data);
      }
      const layer = L.geoJSON(data, { style: styleFor, onEachFeature: bindFeature });
      regionLayers.set(slug, layer);
    }
    // 他 region は地図から外す（cache は保持。再訪問時に即時表示）
    for (const [s, lyr] of regionLayers) {
      if (s !== slug && map.hasLayer(lyr)) map.removeLayer(lyr);
    }
    const layer = regionLayers.get(slug);
    if (!map.hasLayer(layer)) layer.addTo(map);
    applyHierarchyOrder(layer);
    state.currentRegion = slug;
  } finally {
    spinner.classList.remove('visible');
    spinnerText.textContent = 'データを読み込み中…';
  }
}

// === 7. 起動: search-index のみロード ===
spinner.classList.add('visible');
fetchJson('data/france/search-index.json').then(idx => {
  searchIndex = idx;
  for (const e of idx) {
    if (e.hierarchy in hierarchyCounts) hierarchyCounts[e.hierarchy]++;
  }
  renderLegend();
  spinner.classList.remove('visible');
  console.log(`search index: ${idx.length} entries`);
  restoreFromUrl();
}).catch(err => {
  console.error(err);
  spinner.classList.remove('visible');
  alert(`データ読込エラー: ${err.message}\nブラウザの開発者ツール（Console）を確認してください。`);
});

// === 8. 階層フィルタ（凡例クリック） ===
function restyleCurrent() {
  if (!state.currentRegion) return;
  const layer = regionLayers.get(state.currentRegion);
  if (layer) layer.eachLayer(lyr => lyr.setStyle(styleFor(lyr.feature)));
}

legendBody.addEventListener('click', e => {
  const row = e.target.closest('.legend-row');
  if (!row) return;
  const key = row.dataset.hier;
  state.filter[key] = !state.filter[key];
  restyleCurrent();
  renderLegend();
});

// === 9. 陰影起伏 overlay 連動 ===
map.on('overlayadd', e => {
  if (e.name === HILLSHADE_OVERLAY_NAME) { state.hillshadeOn = true; restyleCurrent(); }
});
map.on('overlayremove', e => {
  if (e.name === HILLSHADE_OVERLAY_NAME) { state.hillshadeOn = false; restyleCurrent(); }
});

// === 10. 検索バー ===
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

// 「最近見た畑」履歴（localStorage、最大 10 件）
const RECENT_KEY = 'winemap.recent.denoms';
const RECENT_MAX = 10;

function getRecentDenoms() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function pushRecentDenom(denom) {
  if (!denom) return;
  const list = getRecentDenoms().filter(d => d !== denom);
  list.unshift(denom);
  list.splice(RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {}
}

function getRecentEntries() {
  return getRecentDenoms()
    .map(d => searchIndex.find(e => e.denom === d))
    .filter(Boolean);
}

function renderRecentResults() {
  const entries = getRecentEntries();
  if (!entries.length) {
    searchResults.classList.remove('visible');
    searchResults.innerHTML = '';
    return;
  }
  const items = entries.map((e, i) => {
    const hierMeta = HIER_STYLE[e.hierarchy] || HIER_STYLE['AOC'];
    const climat = (e.denom !== e.app) ? `<span class="sr-meta">→ ${e.denom}</span>` : '';
    return `<li data-idx="${i}">
      <span class="sr-hier ${hierMeta.cls}">${hierMeta.label}</span>
      <span class="sr-name">${e.app}</span>
      ${climat}
      <span class="sr-meta">${e.dt || ''}</span>
    </li>`;
  }).join('');
  searchResults.innerHTML = `<li class="sr-section">最近見た畑</li>${items}`;
  searchResults.classList.add('visible');
  searchResults._entries = entries;
}

function normalizeStr(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function searchEntries(query, max = 20) {
  const q = normalizeStr(query);
  if (q.length < 2) return [];
  const results = [];
  for (const e of searchIndex) {
    const appN = normalizeStr(e.app);
    const denomN = normalizeStr(e.denom);
    if (appN.includes(q) || denomN.includes(q)) {
      let score = 0;
      if (appN === q || denomN === q) score = 100;
      else if (appN.startsWith(q) || denomN.startsWith(q)) score = 50;
      else score = 10;
      const hOrder = { 'Grand Cru': 4, 'Premier Cru': 3, 'Village': 2, 'Régionale': 1, 'AOC': 0 };
      score += (hOrder[e.hierarchy] || 0);
      results.push({ entry: e, score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, max).map(r => r.entry);
}

function renderSearchResults(entries) {
  if (!entries.length) {
    searchResults.classList.remove('visible');
    searchResults.innerHTML = '';
    return;
  }
  searchResults.innerHTML = entries.map((e, i) => {
    const hierMeta = HIER_STYLE[e.hierarchy] || HIER_STYLE['AOC'];
    const climat = (e.denom !== e.app) ? `<span class="sr-meta">→ ${e.denom}</span>` : '';
    return `<li data-idx="${i}">
      <span class="sr-hier ${hierMeta.cls}">${hierMeta.label}</span>
      <span class="sr-name">${e.app}</span>
      ${climat}
      <span class="sr-meta">${e.dt || ''}</span>
    </li>`;
  }).join('');
  searchResults.classList.add('visible');
  searchResults._entries = entries;
}

let searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    const q = searchInput.value.trim();
    if (q.length < 2) {
      renderRecentResults();
    } else {
      renderSearchResults(searchEntries(q));
    }
  }, 80);
});

searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim().length < 2) renderRecentResults();
});

searchResults.addEventListener('click', e => {
  const li = e.target.closest('li[data-idx]');
  if (!li) return;
  const idx = parseInt(li.dataset.idx, 10);
  const entry = searchResults._entries[idx];
  if (!entry) return;
  flyToEntry(entry);
});

document.addEventListener('click', e => {
  if (!e.target.closest('#search-box')) {
    searchResults.classList.remove('visible');
  }
});

// === 11. flyToEntry: region をロード → 飛んで marker + popup ===
let activeMarker = null;

async function flyToEntry(entry) {
  await ensureRegionDisplayed(entry.region);

  const isDetail = ['Grand Cru', 'Premier Cru', 'Village'].includes(entry.hierarchy);
  const targetZoom = isDetail ? 13 : 9;
  map.flyTo([entry.lat, entry.lng], targetZoom, { duration: 0.9 });
  searchResults.classList.remove('visible');
  searchInput.value = `${entry.app}${entry.denom !== entry.app ? ' / ' + entry.denom : ''}`;

  if (activeMarker) map.removeLayer(activeMarker);
  const hierMeta = HIER_STYLE[entry.hierarchy] || HIER_STYLE['AOC'];
  activeMarker = L.circleMarker([entry.lat, entry.lng], {
    radius: 9,
    color: '#fff',
    weight: 2,
    fillColor: hierMeta.fillColor,
    fillOpacity: 0.9,
  }).addTo(map);
  const denomLine = (entry.denom !== entry.app)
    ? `<div class="popup-section"><span class="popup-section-title">climat: </span>${entry.denom}</div>`
    : '';
  const infoHtml = `<h3 class="popup-title">${entry.app}<span class="popup-hier ${hierMeta.cls}">${hierMeta.label}</span></h3>
    ${denomLine}
    <div class="popup-section">
      <span class="popup-section-title">地方: </span>${entry.dt || '—'}
      &nbsp;&nbsp;<span class="popup-section-title">県: </span>${entry.dept || '—'}
    </div>`;
  if (isMobile()) {
    showBottomSheet(infoHtml);
  } else {
    activeMarker.bindPopup(infoHtml, { maxWidth: 320 }).openPopup();
  }

  pushRecentDenom(entry.denom);
  updateUrl(entry);
}

// === 12. URL 状態同期 ===
function updateUrl(entry) {
  const params = new URLSearchParams();
  params.set('denom', entry.denom);
  history.replaceState(null, '', location.pathname + '?' + params.toString());
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const denom = params.get('denom');
  if (!denom) return;
  const entry = searchIndex.find(e => e.denom === denom);
  if (entry) flyToEntry(entry);
}

// === 13. ボトムシート（モバイル）===
const bottomSheet = document.getElementById('bottom-sheet');
const bottomSheetContent = document.getElementById('bottom-sheet-content');
const bottomSheetHandle = document.getElementById('bottom-sheet-handle');
const isMobile = () => window.matchMedia('(max-width: 600px)').matches;

function showBottomSheet(html) {
  bottomSheetContent.innerHTML = html;
  bottomSheet.classList.add('shown');
  bottomSheet.setAttribute('aria-hidden', 'false');
}

function hideBottomSheet() {
  bottomSheet.classList.remove('shown');
  bottomSheet.setAttribute('aria-hidden', 'true');
}

bottomSheetHandle.addEventListener('click', hideBottomSheet);

// 下スワイプで閉じる（内部スクロール先頭にいるときのみ）
let bsTouchStartY = null;
bottomSheet.addEventListener('touchstart', e => {
  bsTouchStartY = e.touches[0].clientY;
}, { passive: true });
bottomSheet.addEventListener('touchmove', e => {
  if (bsTouchStartY === null) return;
  const dy = e.touches[0].clientY - bsTouchStartY;
  if (dy > 60 && bottomSheet.scrollTop === 0) {
    hideBottomSheet();
    bsTouchStartY = null;
  }
}, { passive: true });
bottomSheet.addEventListener('touchend', () => { bsTouchStartY = null; }, { passive: true });

// 地図クリック（ポリゴン外）で閉じる
map.on('click', () => hideBottomSheet());
