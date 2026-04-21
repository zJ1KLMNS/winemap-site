/**
 * コルトン丘テロワールマップ — Phase 5 S3
 *
 * 機能:
 *   - 背景地図切替（OSM / 衛星 / 地形）
 *   - 表示モード切替（階層 / 標高 / 方位）
 *   - 階層フィルタ（GC / PC / Village 表示トグル）
 *   - 属性ポップアップ（denom_ja / 階層 / 標高・斜度・方位 / name_origin / notes）
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
L.control.layers(baseLayers, null, { position: 'topleft', collapsed: false }).addTo(map);

// === 3. 表示モードの状態 ===
const state = {
  viewMode: 'hierarchy',
  hierarchyFilter: { 'Grand Cru': true, 'Premier Cru': true, 'Village': true },
};

// === 4. 階層モード ===
const HIER_STYLE = {
  'Grand Cru':   { color: '#5a0000', fillColor: '#8b0000', weight: 1.2, fillOpacity: 0.45, label: 'グラン・クリュ', cls: 'grand-cru' },
  'Premier Cru': { color: '#7a2a2a', fillColor: '#c45a5a', weight: 1.0, fillOpacity: 0.35, label: 'プルミエ・クリュ', cls: 'premier-cru' },
  'Village':     { color: '#888888', fillColor: '#dfa0a0', weight: 0.8, fillOpacity: 0.25, label: 'ヴィラージュ', cls: 'village' },
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
  if (!state.hierarchyFilter[feature.properties.hierarchy]) return HIDDEN_STYLE;
  switch (state.viewMode) {
    case 'elevation': return styleByElevation(feature);
    case 'aspect':    return styleByAspect(feature);
    default:          return styleByHierarchy(feature);
  }
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
    legendHint.textContent = '';
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
  }
}

// === 11. GeoJSON 読み込み + 描画 ===
let geojsonLayer = null;

fetch('data/bourgogne/corton_terroir.geojson')
  .then(res => {
    if (!res.ok) throw new Error(`GeoJSON 読込失敗: ${res.status}`);
    return res.json();
  })
  .then(geojson => {
    geojsonLayer = L.geoJSON(geojson, {
      style: currentStyle,
      onEachFeature: (feature, lyr) => {
        lyr.bindPopup(popupHTML(feature.properties), { maxWidth: 340 });
        lyr.on('mouseover', () => {
          if (state.hierarchyFilter[feature.properties.hierarchy]) {
            lyr.setStyle({ weight: 2.5 });
          }
        });
        lyr.on('mouseout', () => {
          lyr.setStyle(currentStyle(feature));
        });
      }
    }).addTo(map);

    map.fitBounds(geojsonLayer.getBounds(), { padding: [20, 20] });
    console.log(`GeoJSON 読込完了: ${geojson.features.length} features`);
    renderLegend();
  })
  .catch(err => {
    console.error(err);
    alert(`GeoJSON 読込エラー: ${err.message}`);
  });

// === 12. スタイル再適用 ===
function restyleAll() {
  if (!geojsonLayer) return;
  geojsonLayer.eachLayer(lyr => lyr.setStyle(currentStyle(lyr.feature)));
}

// === 13. UI イベント ===
document.querySelectorAll('input[name="view"]').forEach(radio => {
  radio.addEventListener('change', e => {
    state.viewMode = e.target.value;
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
