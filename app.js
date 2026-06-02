const defaultAddresses = `Pieres 585
Pola 2222
Av. Cnel. Ramón L. Falcón 6814
Pieres 583
San Pedro 5036
Dr. Florentino Ameghino 1798
Av. Cnel. Cárdenas 2151
Ercilla 6168
Tandil 3645
Laguna 1429
Cosquín 1094
Av. Escalada 635
Cosquín 2146
García de Cossio 6230
Chamical 5112
Carlos Encina 733
Erasmo 7380`;

document.getElementById('addressInput').value = defaultAddresses;

// BBox aproximado de Comuna 9: Liniers, Mataderos y Parque Avellaneda.
const comuna9Bounds = L.latLngBounds([[-34.684, -58.535], [-34.626, -58.455]]);

// Polígono práctico para validar que el punto esté dentro de Comuna 9.
// Está pensado para evitar resultados de otros barrios al geocodificar.
const comuna9Polygon = [
  [-34.626, -58.526], [-34.625, -58.488], [-34.629, -58.464], [-34.642, -58.455],
  [-34.658, -58.456], [-34.675, -58.477], [-34.684, -58.505], [-34.681, -58.535],
  [-34.650, -58.535], [-34.626, -58.526]
];

const map = L.map('map', { zoomControl: true }).setView([-34.655, -58.500], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  crossOrigin: true,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let entries = [];
let lineLayer = L.layerGroup().addTo(map);
let clusterLayer = L.layerGroup().addTo(map);
let clusterGroups = [];

function normalizeAddress(raw) {
  return raw.trim().replace(/,$/, '').replace(/\s+/g, ' ');
}

function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = `status ${type}`.trim();
}

function stripAccents(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function parseStreetNumber(address) {
  const cleaned = stripAccents(address)
    .replace(/Av\.?/gi, 'Avenida')
    .replace(/Cnel\.?/gi, 'Coronel')
    .replace(/Dr\.?/gi, 'Doctor')
    .replace(/Ramón/gi, 'Ramon')
    .replace(/García/gi, 'Garcia');
  const m = cleaned.match(/^(.*?)[,\s]+(\d{1,5})$/);
  if (!m) return { street: cleaned, number: '' };
  return { street: m[1].trim(), number: m[2].trim() };
}

function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0], xi = polygon[i][1];
    const yj = polygon[j][0], xj = polygon[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isInsideComuna9(lat, lon) {
  return comuna9Bounds.contains([lat, lon]) && pointInPolygon(lat, lon, comuna9Polygon);
}

function scoreResult(item, address) {
  const lat = Number(item.lat), lon = Number(item.lon);
  let score = 0;
  const display = stripAccents((item.display_name || '').toLowerCase());
  const addr = stripAccents(address.toLowerCase());
  const { street, number } = parseStreetNumber(address);
  const streetLow = stripAccents(street.toLowerCase());

  if (isInsideComuna9(lat, lon)) score += 1000;
  if (display.includes('comuna 9')) score += 150;
  if (display.includes('ciudad autonoma de buenos aires')) score += 100;
  if (display.includes(streetLow)) score += 80;
  if (number && display.includes(number)) score += 50;
  if (display.includes(addr)) score += 80;
  if (item.type === 'house' || item.addresstype === 'house') score += 25;
  return score;
}

async function fetchNominatim(params) {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Error de geocodificación HTTP ${res.status}`);
  return await res.json();
}

async function geocode(address) {
  const { street, number } = parseStreetNumber(address);
  const viewbox = `${comuna9Bounds.getWest()},${comuna9Bounds.getNorth()},${comuna9Bounds.getEast()},${comuna9Bounds.getSouth()}`;
  const queries = [
    { format: 'json', limit: '8', countrycodes: 'ar', addressdetails: '1', bounded: '1', viewbox, street: `${number} ${street}`, city: 'Ciudad Autónoma de Buenos Aires', country: 'Argentina' },
    { format: 'json', limit: '8', countrycodes: 'ar', addressdetails: '1', bounded: '1', viewbox, q: `${address}, Comuna 9, Ciudad Autónoma de Buenos Aires, Argentina` },
    { format: 'json', limit: '8', countrycodes: 'ar', addressdetails: '1', bounded: '1', viewbox, q: `${stripAccents(address)}, CABA, Argentina` },
    { format: 'json', limit: '8', countrycodes: 'ar', addressdetails: '1', q: `${address}, Ciudad Autónoma de Buenos Aires, Argentina` }
  ];

  let candidates = [];
  for (const params of queries) {
    const data = await fetchNominatim(params);
    candidates = candidates.concat(data);
    if (data.length) break;
    await new Promise(r => setTimeout(r, 350));
  }
  if (!candidates.length) throw new Error(`No encontré: ${address}`);

  candidates = candidates
    .map(item => ({ ...item, _score: scoreResult(item, address) }))
    .sort((a, b) => b._score - a._score);

  const best = candidates[0];
  const lat = Number(best.lat), lon = Number(best.lon);
  if (document.getElementById('onlyComuna9').checked && !isInsideComuna9(lat, lon)) {
    throw new Error(`Fuera de Comuna 9 o resultado dudoso: ${address}`);
  }
  return [lat, lon];
}

function markerSize() {
  return Number(document.getElementById('markerSize').value) || 34;
}

function pinIcon(text, grouped = false) {
  const size = markerSize();
  return L.divIcon({
    className: '',
    html: `<div class="pin-icon ${grouped ? 'grouped' : ''}" style="--pin:${size}px" data-n="${escapeHtml(String(text))}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size]
  });
}

function labelIcon(entry) {
  const size = document.getElementById('fontSize').value;
  return L.divIcon({
    className: '',
    html: `<div class="point-label" style="font-size:${size}px"><span class="n">${entry.order}</span>${escapeHtml(entry.address)}</div>`,
    iconSize: null,
    iconAnchor: [0, 0]
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function redrawLines() {
  lineLayer.clearLayers();
  entries.forEach(e => {
    if (e.marker && e.label && map.hasLayer(e.label)) {
      L.polyline([e.marker.getLatLng(), e.label.getLatLng()], { color: '#111827', weight: 1.5, dashArray: '4,4' }).addTo(lineLayer);
    }
  });
}

function rebuildList() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  entries.forEach((e, idx) => {
    e.order = idx + 1;
    if (e.marker) e.marker.setIcon(pinIcon(e.order));
    if (e.label) e.label.setIcon(labelIcon(e));
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<span class="num">${e.order}</span><input value="${escapeHtml(e.address)}" /><button title="Subir">↑</button><button title="Bajar">↓</button>`;
    const input = div.querySelector('input');
    input.addEventListener('change', () => { e.address = input.value; e.label.setIcon(labelIcon(e)); updateClusters(); });
    div.children[2].onclick = () => moveEntry(idx, -1);
    div.children[3].onclick = () => moveEntry(idx, 1);
    list.appendChild(div);
  });
  updateClusters();
  redrawLines();
}

function moveEntry(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= entries.length) return;
  [entries[i], entries[j]] = [entries[j], entries[i]];
  rebuildList();
  arrangeLabels(false);
}

async function mapAddresses() {
  clearAll();
  const btn = document.getElementById('mapBtn');
  btn.classList.add('loading'); btn.textContent = 'Mapeando...';
  const addresses = document.getElementById('addressInput').value.split('\n').map(normalizeAddress).filter(Boolean);
  let ok = 0, failed = [];

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];
    setStatus(`Buscando ${i + 1}/${addresses.length}: ${address}`);
    try {
      const latlng = await geocode(address);
      const entry = { address, order: entries.length + 1 };
      entry.marker = L.marker(latlng, { icon: pinIcon(entry.order), draggable: true }).addTo(map);
      entry.marker.on('drag', () => { updateClusters(); redrawLines(); });
      entry.marker.on('dragend', () => arrangeLabels(false));
      entry.label = L.marker(latlng, { icon: labelIcon(entry), draggable: true, interactive: true, zIndexOffset: 1000 }).addTo(map);
      entry.label.on('drag', () => redrawLines());
      entries.push(entry);
      ok++;
      await new Promise(r => setTimeout(r, 650));
    } catch (err) {
      failed.push(err.message);
      console.warn(err.message);
    }
  }
  fitAll();
  setTimeout(() => arrangeLabels(true), 500);
  rebuildList();
  btn.classList.remove('loading'); btn.textContent = 'Mapear direcciones';
  setStatus(`Mapeadas: ${ok}. Fallidas: ${failed.length}${failed.length ? ' — ' + failed.join(' | ') : ''}`, failed.length ? 'warn' : 'ok');
}

function clearAll() {
  entries.forEach(e => { if (e.marker) map.removeLayer(e.marker); if (e.label) map.removeLayer(e.label); });
  entries = [];
  lineLayer.clearLayers();
  clusterLayer.clearLayers();
  clusterGroups = [];
  document.getElementById('list').innerHTML = '';
  setStatus('Listo.');
}

function fitAll() {
  const points = entries.flatMap(e => [e.marker?.getLatLng(), e.label?.getLatLng()]).filter(Boolean);
  if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [90, 90] });
  else map.fitBounds(comuna9Bounds, { padding: [30, 30] });
}

function rectsOverlap(a, b, pad = 8) {
  return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x || a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
}

function estimateLabelSize(text) {
  const fs = parseInt(document.getElementById('fontSize').value, 10);
  return { w: Math.max(100, text.length * fs * 0.58 + 54), h: fs + 16 };
}

function arrangeLabels(fitAfter = false) {
  const used = [];
  const zoom = map.getZoom();
  const candidates = [
    [18,-48], [18,14], [-160,-48], [-160,14], [48,-8], [-210,-8], [0,-76], [0,42], [82,-72], [-230,-72], [82,48], [-230,48],
    [130,-24], [-280,-24], [130,24], [-280,24]
  ];
  entries.forEach(e => {
    const base = map.project(e.marker.getLatLng(), zoom);
    const size = estimateLabelSize(`${e.order} ${e.address}`);
    let best = null;
    for (const c of candidates) {
      const r = { x: base.x + c[0], y: base.y + c[1], w: size.w, h: size.h, c };
      if (!used.some(u => rectsOverlap(r, u))) { best = r; break; }
    }
    if (!best) best = { x: base.x + 20, y: base.y - 55 + used.length * 22, w: size.w, h: size.h };
    used.push(best);
    e.label.setLatLng(map.unproject([best.x, best.y], zoom));
    e.label.setIcon(labelIcon(e));
  });
  updateClusters();
  redrawLines();
  if (fitAfter) fitAll();
}

function makeGroups() {
  const threshold = Number(document.getElementById('clusterPx').value) || 38;
  const zoom = map.getZoom();
  const groups = [];
  entries.forEach(e => {
    const p = map.project(e.marker.getLatLng(), zoom);
    let found = groups.find(g => g.points.some(gp => p.distanceTo(gp) <= threshold));
    if (!found) { found = { entries: [], points: [] }; groups.push(found); }
    found.entries.push(e);
    found.points.push(p);
  });
  return groups;
}

function updateClusters() {
  clusterLayer.clearLayers();
  clusterGroups = makeGroups();

  entries.forEach(e => {
    if (!map.hasLayer(e.marker)) e.marker.addTo(map);
    e.marker.setIcon(pinIcon(e.order));
  });

  clusterGroups.forEach(g => {
    if (g.entries.length <= 1) return;
    const nums = g.entries.map(e => e.order).join(',');
    const avgLat = g.entries.reduce((s, e) => s + e.marker.getLatLng().lat, 0) / g.entries.length;
    const avgLng = g.entries.reduce((s, e) => s + e.marker.getLatLng().lng, 0) / g.entries.length;
    g.entries.forEach(e => { if (map.hasLayer(e.marker)) map.removeLayer(e.marker); });
    const title = g.entries.map(e => `${e.order}. ${e.address}`).join('\n');
    L.marker([avgLat, avgLng], { icon: pinIcon(nums, true), title }).addTo(clusterLayer);
  });
  redrawLines();
}

function applyFontSize() {
  document.getElementById('fontSizeValue').textContent = document.getElementById('fontSize').value;
  entries.forEach(e => e.label.setIcon(labelIcon(e)));
  arrangeLabels(false);
}

function applyMarkerSize() {
  document.getElementById('markerSizeValue').textContent = document.getElementById('markerSize').value;
  updateClusters();
}

function applyClusterDistance() {
  document.getElementById('clusterPxValue').textContent = document.getElementById('clusterPx').value;
  updateClusters();
}

function updatePdfPreset() {
  const preset = document.getElementById('pdfPreset').value;
  const orientation = document.getElementById('orientation').value;
  const sizes = { a4: [210, 297], a3: [297, 420], letter: [216, 279], 'oficio-mx': [216, 340] };
  if (preset === 'custom') return;
  let [w, h] = sizes[preset];
  if (orientation === 'landscape') [w, h] = [h, w];
  document.getElementById('pdfW').value = w;
  document.getElementById('pdfH').value = h;
}

async function exportPdf() {
  document.getElementById('mapTitle').textContent = document.getElementById('titleInput').value || 'Mapa de direcciones';
  await new Promise(r => setTimeout(r, 300));
  const wrap = document.querySelector('.map-wrap');
  const canvas = await html2canvas(wrap, { useCORS: true, allowTaint: false, scale: 2, backgroundColor: '#ffffff' });
  const { jsPDF } = window.jspdf;
  const w = Number(document.getElementById('pdfW').value) || 297;
  const h = Number(document.getElementById('pdfH').value) || 210;
  const pdf = new jsPDF({ orientation: w > h ? 'landscape' : 'portrait', unit: 'mm', format: [w, h] });
  const img = canvas.toDataURL('image/png');
  const ratio = Math.min(w / canvas.width, h / canvas.height);
  const imgW = canvas.width * ratio;
  const imgH = canvas.height * ratio;
  pdf.addImage(img, 'PNG', (w - imgW) / 2, (h - imgH) / 2, imgW, imgH);
  pdf.save('mapa-direcciones.pdf');
}

document.getElementById('mapBtn').onclick = mapAddresses;
document.getElementById('clearBtn').onclick = clearAll;
document.getElementById('arrangeBtn').onclick = () => arrangeLabels(true);
document.getElementById('fitBtn').onclick = fitAll;
document.getElementById('fontSize').oninput = applyFontSize;
document.getElementById('markerSize').oninput = applyMarkerSize;
document.getElementById('clusterPx').oninput = applyClusterDistance;
document.getElementById('zoomRange').oninput = e => map.setZoom(Number(e.target.value));
document.getElementById('titleInput').oninput = e => document.getElementById('mapTitle').textContent = e.target.value;
document.getElementById('pdfPreset').onchange = updatePdfPreset;
document.getElementById('orientation').onchange = updatePdfPreset;
document.getElementById('pdfBtn').onclick = exportPdf;
map.on('zoomend moveend', () => { updateClusters(); redrawLines(); });
updatePdfPreset();
fitAll();
