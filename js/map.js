/**
 * コルトン丘テロワールマップ — Phase 5 S3
 *
 * 機能:
 *   - 背景地図切替（OSM / IGN BDORTHO / IGN Plan V2 / OpenTopoMap）
 *   - 陰影起伏 overlay（IGN ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW）
 *   - 表示モード切替（階層 / 標高 / 方位 / 地質）— 相互排他
 *   - 階層フィルタ（GC / PC / Village 表示トグル）— 全モードに適用
 *   - リセットボタン（コルトン周辺に戻す）
 *   - 属性ポップアップ（階層/標高/方位モード: 畑情報 / 地質モード: 畑×地質情報）
 *
 * 注: 畑ラベル（denom 名の常時表示）は 2026-04-23 に試作したが、Leaflet 標準に
 *     衝突回避機構がなく小さい畑で重なるため、一旦撤去。後日 LabelTextCollision
 *     プラグイン等を検討予定。
 */

// === 1. 地図の初期化 ===
// コート・ドール銘醸地帯（ジュヴレ〜サントネーの帯）を表示範囲とする
const COTE_DOR_BOUNDS = L.latLngBounds([46.90, 4.65], [47.35, 5.05]);
const map = L.map('map', {
  zoomControl: true,
  minZoom: 11,
  maxBounds: COTE_DOR_BOUNDS,
  maxBoundsViscosity: 0.8,
}).setView([47.073, 4.865], 14);

// === 2. 背景タイル（4種切替） ===
const IGN_WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
                 '&LAYER={layer}&STYLE=normal&FORMAT={fmt}' +
                 '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
const IGN_ATTRIB = '© <a href="https://geoservices.ign.fr/">IGN-F/Géoportail</a>';
const TILE_COMMON = { bounds: COTE_DOR_BOUNDS, minZoom: 11 };

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

// === 2.5 オーバーレイレイヤ ===
// Leaflet の pane z-index 設計:
//   tilePane=200 / overlayPane=400（畑ポリゴン） / geology=420 / hillshade=450(multiply) / markerPane=600
// geology は畑の上・hillshade の下。地質 ON 時は畑の fillOpacity を薄くして地質色を見せる。
map.createPane('geology');
map.getPane('geology').style.zIndex = 420;

map.createPane('hillshade');
map.getPane('hillshade').style.zIndex = 450;
map.getPane('hillshade').style.mixBlendMode = 'multiply';

// SHADOW は共通テンプレートと違い STYLE=estompage_grayscale / TILEMATRIXSET=PM_0_15（最大 z15）
const IGN_SHADOW_URL = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  '&LAYER=ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW&STYLE=estompage_grayscale&FORMAT=image/png' +
  '&TILEMATRIXSET=PM_0_15&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

const HILLSHADE_OVERLAY_NAME = '陰影起伏（IGN）';

const overlayLayers = {
  [HILLSHADE_OVERLAY_NAME]: L.tileLayer(IGN_SHADOW_URL, {
    ...TILE_COMMON, maxZoom: 15, opacity: 0.85, pane: 'hillshade',
    attribution: `${IGN_ATTRIB} — Estompage (BD Alti®)`
  }),
};
L.control.layers(baseLayers, overlayLayers, { position: 'topleft', collapsed: false }).addTo(map);

// === 3. 表示モードの状態 ===
const state = {
  viewMode: 'hierarchy',  // hierarchy / elevation / aspect / geology の相互排他
  hierarchyFilter: { 'Grand Cru': true, 'Premier Cru': true, 'Village': true },
  hillshadeOn: false,
};

// 陰影起伏 ON 時に畑の塗りを薄くする係数（地形を透過させる）
const HILLSHADE_FILL_FACTOR = 0.45;

// id_denom → hierarchy 対応表（地質レイヤで階層フィルタを効かせるため）
const hierarchyByIdDenom = {};

// === 3.5 地質 Categorized 配色（QGIS add_parcel_geology_layer.py と同じ色） ===
// 12分類。notation 順は CSV（geology-ja-mapping.csv）に準拠
const GEOLOGY_CATEGORIES = [
  { notation: 'j3a',  label: 'j3a コンブランシアン石灰岩',      color: '#a8d8c0' },
  { notation: 'j4a',  label: 'j4a ダル・ナクレ',               color: '#7ec097' },
  { notation: 'j5',   label: 'j5 鉄質魚卵状石灰岩',            color: '#4e9b70' },
  { notation: 'j5a',  label: 'j5a 水硬性石灰岩',              color: '#b89ec0' },
  { notation: 'j5b',  label: 'j5b マール・泥灰質石灰岩',        color: '#8a6494' },
  { notation: 'Fu',   label: 'Fu サン・コーム層（マール）',      color: '#e6a95a' },
  { notation: 'C',    label: 'C 斜面崩積物',                  color: '#d4b896' },
  { notation: 'GP',   label: 'GP 周氷河性角礫',                color: '#c19a6b' },
  { notation: 'p-IV', label: 'p-IV ヴィラフランキアン',          color: '#f0e68c' },
  { notation: 'Fz',   label: 'Fz 新期沖積層',                 color: '#fbc687' },
  { notation: 'Fy',   label: 'Fy サン・ユザージュ段丘',          color: '#f4a582' },
  { notation: 'X',    label: 'X 人工堆積物・盛土',              color: '#999999' },
];
const GEOLOGY_COLOR_BY_NOTATION = Object.fromEntries(
  GEOLOGY_CATEGORIES.map(c => [c.notation, c.color])
);
const GEOLOGY_DEFAULT_COLOR = '#cccccc';

function styleByGeology(feature) {
  const h = hierarchyByIdDenom[feature.properties.id_denom];
  if (h && !state.hierarchyFilter[h]) return HIDDEN_STYLE;
  const color = GEOLOGY_COLOR_BY_NOTATION[feature.properties.notation] || GEOLOGY_DEFAULT_COLOR;
  // 陰影起伏 ON 時は地形を透過させるため地質を薄く
  const fillOpacity = state.hillshadeOn ? 0.55 * HILLSHADE_FILL_FACTOR : 0.55;
  return { color: '#444', fillColor: color, weight: 0.3, fillOpacity };
}

// === 4. 階層モード ===
const HIER_STYLE = {
  'Grand Cru':   { color: '#5a0000', fillColor: '#8b0000', weight: 1.8, fillOpacity: 0.45, label: 'グラン・クリュ', cls: 'grand-cru' },
  'Premier Cru': { color: '#7a2a2a', fillColor: '#c45a5a', weight: 1.3, fillOpacity: 0.35, label: 'プルミエ・クリュ', cls: 'premier-cru' },
  'Village':     { color: '#888888', fillColor: '#dfa0a0', weight: 1.0, fillOpacity: 0.25, label: 'ヴィラージュ', cls: 'village' },
};
const DEFAULT_STYLE = { color: '#666', fillColor: '#ccc', weight: 0.8, fillOpacity: 0.2, label: '—', cls: 'village' };

function styleByHierarchy(feature) {
  return HIER_STYLE[feature.properties.hierarchy] || DEFAULT_STYLE;
}

// === 5. 標高モード（4段階のシーケンシャルカラー） ===
const ELEV_BUCKETS = [
  { max: 250, color: '#fef0d9', label: '〜250m' },
  { max: 280, color: '#fdcc8a', label: '250〜280m' },
  { max: 310, color: '#fc8d59', label: '280〜310m' },
  { max: Infinity, color: '#d7301f', label: '310m〜' },
];

function styleByElevation(feature) {
  const e = feature.properties.elev_mean;
  const bucket = ELEV_BUCKETS.find(b => e != null && e < b.max) || ELEV_BUCKETS[ELEV_BUCKETS.length - 1];
  return { color: '#555', fillColor: bucket.color, weight: 0.8, fillOpacity: 0.55 };
}

// === 6. 方位モード（8方位カテゴリカラー） ===
const ASPECT_DIRS = [
  { label: '北',   cls: 'aspect-n',  color: '#9e9e9e' },
  { label: '北東', cls: 'aspect-ne', color: '#c6b34b' },
  { label: '東',   cls: 'aspect-e',  color: '#e89c3a' },
  { label: '南東', cls: 'aspect-se', color: '#e06a3a' },
  { label: '南',   cls: 'aspect-s',  color: '#c23b3b' },
  { label: '南西', cls: 'aspect-sw', color: '#8e4a9a' },
  { label: '西',   cls: 'aspect-w',  color: '#4a6cbd' },
  { label: '北西', cls: 'aspect-nw', color: '#5a9ab8' },
];

function aspectIndex(deg) {
  if (deg == null || isNaN(deg)) return -1;
  return Math.round(((deg % 360) + 360) % 360 / 45) % 8;
}

function styleByAspect(feature) {
  const i = aspectIndex(feature.properties.aspect_deg);
  const c = (i >= 0) ? ASPECT_DIRS[i].color : '#ccc';
  return { color: '#555', fillColor: c, weight: 0.8, fillOpacity: 0.55 };
}

// === 7. 統合スタイル関数（フィルタ + モード） ===
const HIDDEN_STYLE = { opacity: 0, fillOpacity: 0, weight: 0, interactive: false };

function currentStyle(feature) {
  // 地質モードでは畑ポリゴン自体は透明化（下の地質レイヤを見せる）
  if (state.viewMode === 'geology') return HIDDEN_STYLE;
  if (!state.hierarchyFilter[feature.properties.hierarchy]) return HIDDEN_STYLE;
  let s;
  switch (state.viewMode) {
    case 'elevation': s = styleByElevation(feature); break;
    case 'aspect':    s = styleByAspect(feature); break;
    default:          s = styleByHierarchy(feature);
  }
  if (state.hillshadeOn) s = { ...s, fillOpacity: s.fillOpacity * HILLSHADE_FILL_FACTOR };
  return s;
}

// === 8. 方位ラベル変換（ポップアップ用） ===
function aspectLabel(deg) {
  if (deg == null || isNaN(deg)) return '—';
  return `${ASPECT_DIRS[aspectIndex(deg)].label} (${Math.round(deg)}°)`;
}

// === 9. ポップアップ HTML ===
function popupHTML(props) {
  const name = props.denom_ja || props.denom || '(unnamed)';
  const hierMeta = HIER_STYLE[props.hierarchy] || DEFAULT_STYLE;
  const elev = (props.elev_mean != null) ? `標高 ${Math.round(props.elev_mean)}m` : '';
  const slope = (props.slope_mean != null) ? `斜度 ${props.slope_mean.toFixed(1)}°` : '';
  const aspect = `方位 ${aspectLabel(props.aspect_deg)}`;

  let html = `<h3 class="popup-title">${name}<span class="popup-hier ${hierMeta.cls}">${hierMeta.label}</span></h3>`;
  html += `<div class="popup-section"><div class="popup-section-title">テロワール (GIS算出)</div>`;
  html += `<div class="popup-terroir"><span>${elev}</span><span>${slope}</span><span>${aspect}</span></div></div>`;

  if (props.name_origin_ja) {
    html += `<div class="popup-section"><div class="popup-section-title">名前の由来</div>`;
    html += `<p class="popup-text">${props.name_origin_ja}</p></div>`;
  }
  if (props.notes_ja) {
    html += `<div class="popup-section"><div class="popup-section-title">畑の物語</div>`;
    html += `<p class="popup-text">${props.notes_ja}</p></div>`;
  }
  return html;
}

// === 9.5 地質フィーチャ用ポップアップ（畑×地質の長テーブル 1 行分） ===
function geologyPopupHTML(props) {
  const denom = props.denom || '(unnamed)';
  const geoLabel = props.geology_ja || props.notation || '—';
  const age = props.age_ja ? `<div class="popup-text" style="color:#666;font-size:11px">${props.age_ja}</div>` : '';
  const cov = (props.coverage != null)
    ? `この畑の <strong>${(props.coverage * 100).toFixed(1)}%</strong> を占める`
    : '';
  const verified = props.verified && props.verified !== 'ok'
    ? `<div class="popup-text" style="color:#b36;font-size:11px">※ ${props.verified}</div>`
    : '';
  return `<h3 class="popup-title">${denom}</h3>
    <div class="popup-section">
      <div class="popup-section-title">地質 (${props.notation || '?'})</div>
      <p class="popup-text"><strong>${geoLabel}</strong></p>
      ${age}
      <p class="popup-text" style="font-size:12px;color:#555">${cov}</p>
      ${verified}
    </div>`;
}

// === 10. 凡例の描画（モード別） ===
const legendTitle = document.getElementById('legend-title');
const legendBody  = document.getElementById('legend-body');
const legendHint  = document.getElementById('legend-hint');

function renderLegend() {
  if (state.viewMode === 'hierarchy') {
    legendTitle.textContent = '階層（クリックで表示切替）';
    legendBody.innerHTML = Object.entries(HIER_STYLE).map(([key, s]) => {
      const active = state.hierarchyFilter[key];
      return `<div class="legend-row toggle${active ? '' : ' inactive'}" data-hier="${key}">
        <span class="swatch ${s.cls}"></span>${s.label}
      </div>`;
    }).join('');
    const allOff = Object.values(state.hierarchyFilter).every(v => !v);
    legendHint.textContent = allOff ? 'すべて非表示中。凡例をクリックして階層を表示してください' : '';
  } else if (state.viewMode === 'elevation') {
    legendTitle.textContent = '標高（elev_mean）';
    legendBody.innerHTML = ELEV_BUCKETS.map(b =>
      `<div class="legend-row"><span class="swatch" style="background:${b.color}"></span>${b.label}</div>`
    ).join('');
    legendHint.textContent = 'RGE ALTI 5m DEM より算出';
  } else if (state.viewMode === 'aspect') {
    legendTitle.textContent = '方位（aspect_deg）';
    legendBody.innerHTML = ASPECT_DIRS.map(d =>
      `<div class="legend-row"><span class="swatch" style="background:${d.color}"></span>${d.label}</div>`
    ).join('');
    legendHint.textContent = '0°=北 時計回り。RGE ALTI 由来';
  } else if (state.viewMode === 'geology') {
    legendTitle.textContent = '地質（BRGM BD Charm-50）';
    legendBody.innerHTML = GEOLOGY_CATEGORIES.map(c =>
      `<div class="legend-row"><span class="swatch" style="background:${c.color}"></span>${c.label}</div>`
    ).join('');
    legendHint.textContent = '畑×地質の Spatial Join。クリックで地質ポップアップ';
  }
}

// === 11. GeoJSON 読み込み + 描画（畑 + 地質を並列fetch） ===
let geojsonLayer = null;
let geologyLayer = null;
let initialBounds = null;
const spinner = document.getElementById('loading-spinner');

function fetchJson(path, required) {
  return fetch(path).then(res => {
    if (!res.ok) {
      if (required) throw new Error(`${path} 読込失敗: ${res.status}`);
      console.warn(`${path} 読込失敗 (${res.status}) — skip`);
      return null;
    }
    return res.json();
  }).catch(err => {
    if (required) throw err;
    console.warn(`${path} 読込スキップ:`, err);
    return null;
  });
}

Promise.all([
  fetchJson('data/france/bourgogne/corton_terroir.geojson', true),
  fetchJson('data/france/bourgogne/corton_geology.geojson', false),
]).then(([parcelsGeo, geologyGeo]) => {
  // id_denom → hierarchy 対応表を構築（地質レイヤの階層フィルタ連動に使用）
  parcelsGeo.features.forEach(f => {
    hierarchyByIdDenom[f.properties.id_denom] = f.properties.hierarchy;
  });

  // 畑レイヤ
  geojsonLayer = L.geoJSON(parcelsGeo, {
    style: currentStyle,
    onEachFeature: (feature, lyr) => {
      lyr.bindPopup(popupHTML(feature.properties), { maxWidth: 340 });
      lyr.on('mouseover', () => {
        if (state.viewMode !== 'geology' && state.hierarchyFilter[feature.properties.hierarchy]) {
          lyr.setStyle({ weight: 2.5 });
        }
      });
      lyr.on('mouseout', () => {
        lyr.setStyle(currentStyle(feature));
      });
    }
  }).addTo(map);

  initialBounds = geojsonLayer.getBounds();
  map.fitBounds(initialBounds, { padding: [20, 20] });
  console.log(`畑 GeoJSON 読込完了: ${parcelsGeo.features.length} features`);

  // 地質レイヤ（読込成功時のみ構築、初期は map に追加しない）
  if (geologyGeo) {
    geologyLayer = L.geoJSON(geologyGeo, {
      pane: 'geology',
      style: styleByGeology,
      onEachFeature: (feature, lyr) => {
        lyr.bindPopup(geologyPopupHTML(feature.properties), { maxWidth: 300 });
      }
    });
    console.log(`地質 GeoJSON 読込完了: ${geologyGeo.features.length} features`);
  }

  applyMode();
  renderLegend();
  spinner.classList.remove('visible');
}).catch(err => {
  console.error(err);
  spinner.classList.remove('visible');
  alert(`GeoJSON 読込エラー: ${err.message}`);
});

// === 12. スタイル再適用 + モード切替（畑/地質レイヤの入替） ===
function applyMode() {
  if (!geojsonLayer) return;
  if (state.viewMode === 'geology') {
    if (geologyLayer && !map.hasLayer(geologyLayer)) geologyLayer.addTo(map);
  } else {
    if (geologyLayer && map.hasLayer(geologyLayer)) map.removeLayer(geologyLayer);
  }
}

function restyleAll() {
  if (geojsonLayer) {
    geojsonLayer.eachLayer(lyr => lyr.setStyle(currentStyle(lyr.feature)));
  }
  if (geologyLayer && map.hasLayer(geologyLayer)) {
    geologyLayer.eachLayer(lyr => lyr.setStyle(styleByGeology(lyr.feature)));
  }
}

// === 13. UI イベント ===
document.querySelectorAll('input[name="view"]').forEach(radio => {
  radio.addEventListener('change', e => {
    state.viewMode = e.target.value;
    applyMode();
    restyleAll();
    renderLegend();
  });
});

legendBody.addEventListener('click', e => {
  const row = e.target.closest('.legend-row.toggle');
  if (!row) return;
  const key = row.dataset.hier;
  state.hierarchyFilter[key] = !state.hierarchyFilter[key];
  restyleAll();
  renderLegend();
});

// 陰影起伏 overlay の ON/OFF に連動して畑の塗りを調整
map.on('overlayadd', e => {
  if (e.name === HILLSHADE_OVERLAY_NAME) { state.hillshadeOn = true; restyleAll(); }
});
map.on('overlayremove', e => {
  if (e.name === HILLSHADE_OVERLAY_NAME) { state.hillshadeOn = false; restyleAll(); }
});

// リセット: 初期ビュー + 階層フィルタ全ON + 階層モードに戻す
document.getElementById('reset-btn').addEventListener('click', () => {
  state.viewMode = 'hierarchy';
  state.hierarchyFilter = { 'Grand Cru': true, 'Premier Cru': true, 'Village': true };
  document.querySelector('input[name="view"][value="hierarchy"]').checked = true;
  if (initialBounds) map.fitBounds(initialBounds, { padding: [20, 20] });
  applyMode();
  restyleAll();
  renderLegend();
});
