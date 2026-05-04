/**
 * WineMap Phase 2 — 仏ワイン AOC 全土テロワールマップ（Champagne 除く）
 *
 * 機能:
 *   - 背景地図切替（OSM / IGN BDORTHO / IGN Plan V2 / OpenTopoMap）
 *   - 陰影起伏 overlay（IGN ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW、最大 z15）
 *   - 5 階層カラーリング: Grand Cru / Premier Cru / Régionale / Village / AOC
 *   - 階層フィルタ（凡例クリックで表示切替）
 *   - 検索バー: 1,277 denom を fuzzy match、結果クリックで該当 AOC へ fly
 *   - ポップアップ: app / denom / hierarchy / dt / dept
 *
 * データ:
 *   - data/france/inao_france_detail.geojson: GC/PC/Village 1,003 features（denom 単位、約 1 MB）
 *   - data/france/search-index.json:          1,277 denom のメタデータ + WGS84 centroid
 *
 * 注: Régionale/AOC（Bordeaux 全体・Loire 全体等）の広域ポリゴン表示は
 *     ファイルサイズが配信不可（dissolve + tolerance 500m でも 33 MB）のため、
 *     現状は検索インデックス経由でのみ到達可能（fly to centroid）。
 *     ベクトルタイル化で解決予定（Phase 2 ステップ 5+）。
 *
 * スコープ注: INAO delim-parcellaire 対象 355 AOC。Champagne・Coteaux Champenois・
 *             Rosé des Riceys は元データに未収録のため白地表示（Phase 2.5 で別ソース調査予定）。
 */

// === 1. 地図初期化（仏全土を表示） ===
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
  'Régionale':   { color: '#2a4a8a', fillColor: '#4a6cbd', weight: 0.8, fillOpacity: 0.20, label: 'レジョナル', cls: 'regionale' },
  'Village':     { color: '#3a6aa0', fillColor: '#87b1de', weight: 0.8, fillOpacity: 0.40, label: 'ヴィラージュ', cls: 'village' },
  'AOC':         { color: '#666',    fillColor: '#b0b0b0', weight: 0.5, fillOpacity: 0.30, label: 'AOC（その他）', cls: 'aoc' },
};
const HIDDEN_STYLE = { opacity: 0, fillOpacity: 0, weight: 0, interactive: false };

const state = {
  filter: { 'Grand Cru': true, 'Premier Cru': true, 'Régionale': true, 'Village': true, 'AOC': true },
  hillshadeOn: false,
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

// === 6. データ読込 + レイヤ構築 ===
let detailLayer = null;
let searchIndex = [];
const spinner = document.getElementById('loading-spinner');

function fetchJson(path) {
  return fetch(path).then(res => {
    if (!res.ok) throw new Error(`${path} 読込失敗: ${res.status}`);
    return res.json();
  });
}

function bindFeature(feature, lyr) {
  lyr.bindPopup(popupHTML(feature.properties), { maxWidth: 340 });
  lyr.on('mouseover', () => {
    if (state.filter[feature.properties.hierarchy]) lyr.setStyle({ weight: 2.5 });
  });
  lyr.on('mouseout', () => lyr.setStyle(styleFor(feature)));
}

Promise.all([
  fetchJson('data/france/inao_france_detail.geojson'),
  fetchJson('data/france/search-index.json'),
]).then(([detailGeo, idx]) => {
  // 凡例カウントは search-index の denom 単位件数（検索結果数の感覚）
  for (const e of idx) {
    if (e.hierarchy in hierarchyCounts) hierarchyCounts[e.hierarchy]++;
  }

  detailLayer = L.geoJSON(detailGeo, {
    style: styleFor,
    onEachFeature: bindFeature,
  }).addTo(map);

  searchIndex = idx;

  console.log(`detail: ${detailGeo.features.length} features, search index: ${idx.length} entries`);

  renderLegend();
  spinner.classList.remove('visible');
}).catch(err => {
  console.error(err);
  spinner.classList.remove('visible');
  alert(`データ読込エラー: ${err.message}\nブラウザの開発者ツール（Console）を確認してください。`);
});

// === 7. 階層フィルタ（凡例クリック） ===
function restyleAll() {
  if (detailLayer) detailLayer.eachLayer(lyr => lyr.setStyle(styleFor(lyr.feature)));
}

legendBody.addEventListener('click', e => {
  const row = e.target.closest('.legend-row');
  if (!row) return;
  const key = row.dataset.hier;
  state.filter[key] = !state.filter[key];
  restyleAll();
  renderLegend();
});

// === 8. 陰影起伏 overlay 連動 ===
map.on('overlayadd', e => {
  if (e.name === HILLSHADE_OVERLAY_NAME) { state.hillshadeOn = true; restyleAll(); }
});
map.on('overlayremove', e => {
  if (e.name === HILLSHADE_OVERLAY_NAME) { state.hillshadeOn = false; restyleAll(); }
});

// === 9. 検索バー ===
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

function normalizeStr(s) {
  // 大文字小文字 + アクセント記号を除去して比較
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function searchEntries(query, max = 20) {
  const q = normalizeStr(query);
  if (q.length < 2) return [];
  const results = [];
  for (const e of searchIndex) {
    const appN = normalizeStr(e.app);
    const denomN = normalizeStr(e.denom);
    if (appN.includes(q) || denomN.includes(q)) {
      // ランキング: 完全一致 > 先頭一致 > 含有一致、hierarchy 重要度も考慮
      let score = 0;
      if (appN === q || denomN === q) score = 100;
      else if (appN.startsWith(q) || denomN.startsWith(q)) score = 50;
      else score = 10;
      const hOrder = { 'Grand Cru': 4, 'Premier Cru': 3, 'Régionale': 2, 'Village': 1, 'AOC': 0 };
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
    renderSearchResults(searchEntries(searchInput.value));
  }, 80);
});

searchResults.addEventListener('click', e => {
  const li = e.target.closest('li');
  if (!li) return;
  const idx = parseInt(li.dataset.idx, 10);
  const entry = searchResults._entries[idx];
  if (!entry) return;
  flyToEntry(entry);
});

// 入力欄外クリックで結果を閉じる
document.addEventListener('click', e => {
  if (!e.target.closest('#search-box')) {
    searchResults.classList.remove('visible');
  }
});

// 検索結果クリック時に表示するアクティブマーカー（centroid 表示で「ここが検索した AOC」を可視化）
let activeMarker = null;

function flyToEntry(entry) {
  // hierarchy が detail 系なら zoom 13、overview 系なら zoom 9 程度
  const isDetail = ['Grand Cru', 'Premier Cru', 'Village'].includes(entry.hierarchy);
  const targetZoom = isDetail ? 13 : 9;
  map.flyTo([entry.lat, entry.lng], targetZoom, { duration: 0.9 });
  searchResults.classList.remove('visible');
  searchInput.value = `${entry.app}${entry.denom !== entry.app ? ' / ' + entry.denom : ''}`;

  // centroid に marker を置く（AOC 階層は detail layer に乗らないため、視覚的なアンカーとして必要）
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
  activeMarker.bindPopup(`<h3 class="popup-title">${entry.app}<span class="popup-hier ${hierMeta.cls}">${hierMeta.label}</span></h3>
    ${denomLine}
    <div class="popup-section">
      <span class="popup-section-title">地方: </span>${entry.dt || '—'}
      &nbsp;&nbsp;<span class="popup-section-title">県: </span>${entry.dept || '—'}
    </div>`, { maxWidth: 320 }).openPopup();
}
