/**
 * コルトン丘テロワールマップ — Leaflet 最小実装 (Phase 1)
 *
 * 機能:
 *   - OSM ベースタイル表示
 *   - inao_corton_terroir GeoJSON を hierarchy で3色分け描画
 *   - クリックで属性ポップアップ (denom_ja / 階層 / 標高・斜度 / 名前の由来 / notes)
 */

// === 1. 地図の初期化 ===
const map = L.map('map').setView([47.073, 4.865], 14);

// === 2. 背景タイル (OpenStreetMap) ===
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

// === 3. 階層別スタイル定義 ===
const HIER_STYLE = {
  'Grand Cru':   { color: '#5a0000', fillColor: '#8b0000', weight: 1.2, fillOpacity: 0.45, label: 'グラン・クリュ', cls: 'grand-cru' },
  'Premier Cru': { color: '#7a2a2a', fillColor: '#c45a5a', weight: 1.0, fillOpacity: 0.35, label: 'プルミエ・クリュ', cls: 'premier-cru' },
  'Village':     { color: '#888888', fillColor: '#dfa0a0', weight: 0.8, fillOpacity: 0.25, label: 'ヴィラージュ', cls: 'village' },
};
const DEFAULT_STYLE = { color: '#666', fillColor: '#ccc', weight: 0.8, fillOpacity: 0.2, label: '—', cls: 'village' };

function styleFor(feature) {
  return HIER_STYLE[feature.properties.hierarchy] || DEFAULT_STYLE;
}

// === 4. 方位（度）→ 日本語ラベル変換 ===
function aspectLabel(deg) {
  if (deg == null || isNaN(deg)) return '—';
  const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return `${dirs[idx]} (${Math.round(deg)}°)`;
}

// === 5. ポップアップ HTML 生成 ===
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

// === 6. GeoJSON 読み込み + 描画 ===
fetch('data/bourgogne/corton_terroir.geojson')
  .then(res => {
    if (!res.ok) throw new Error(`GeoJSON 読込失敗: ${res.status}`);
    return res.json();
  })
  .then(geojson => {
    const layer = L.geoJSON(geojson, {
      style: styleFor,
      onEachFeature: (feature, lyr) => {
        lyr.bindPopup(popupHTML(feature.properties), { maxWidth: 340 });
        lyr.on('mouseover', () => lyr.setStyle({ weight: 2.5 }));
        lyr.on('mouseout',  () => lyr.setStyle({ weight: styleFor(feature).weight }));
      }
    }).addTo(map);

    // レイヤ全体にフィット
    map.fitBounds(layer.getBounds(), { padding: [20, 20] });
    console.log(`GeoJSON 読込完了: ${geojson.features.length} features`);
  })
  .catch(err => {
    console.error(err);
    alert(`GeoJSON 読込エラー: ${err.message}`);
  });
