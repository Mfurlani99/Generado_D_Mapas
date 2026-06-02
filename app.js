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
let clusterLayer = L.layerGroup().addTo(map);
let clusterGroups = [];
let relocatingEntry = null;
const geocodeDelayMs = 1100;

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

function uniqueValues(values) {
  return [...new Set(values.map(v => normalizeAddress(v)).filter(Boolean))];
}

function expandAddress(address) {
  return normalizeAddress(address)
    .replace(/(^|\s)Avda?\.?(?=\s|$)/gi, '$1Avenida')
    .replace(/(^|\s)Av\.?(?=\s|$)/gi, '$1Avenida')
    .replace(/(^|\s)Cnel\.?(?=\s|$)/gi, '$1Coronel')
    .replace(/(^|\s)Dr\.?(?=\s|$)/gi, '$1Doctor')
    .replace(/(^|\s)Gral\.?(?=\s|$)/gi, '$1General')
    .replace(/(^|\s)Sta\.?(?=\s|$)/gi, '$1Santa')
    .replace(/(^|\s)Sto\.?(?=\s|$)/gi, '$1Santo')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseStreetNumber(address) {
  const cleaned = stripAccents(expandAddress(address));
  const m = cleaned.match(/^(.*?)[,\s]+(\d{1,5})(?:\s.*)?$/);
  if (!m) return { street: cleaned, number: '' };
  return { street: m[1].trim(), number: m[2].trim() };
}

function streetAlternatives(street) {
  const options = [street];
  const low = stripAccents(street.toLowerCase());
  if (low.includes('ramon') && low.includes('falcon')) {
    options.push('Avenida Coronel Ramon Lorenzo Falcon');
    options.push('Coronel Ramon Lorenzo Falcon');
    options.push('Avenida Coronel Ramon L Falcon');
  }
  return uniqueValues(options);
}

function addressVariants(address) {
  const expanded = expandAddress(address);
  const { street, number } = parseStreetNumber(expanded);
  const variants = [address, expanded];
  if (number && street) {
    streetAlternatives(street).forEach(name => {
      variants.push(`${name} ${number}`);
      variants.push(`${number} ${name}`);
    });
  }
  return uniqueValues(variants);
}

function streetWords(street) {
  const stop = new Set(['avenida', 'calle', 'coronel', 'doctor', 'general', 'santa', 'santo', 'presidente']);
  return stripAccents(street.toLowerCase())
    .split(/[^a-z0-9]+/i)
    .filter(word => word.length > 2 && !stop.has(word));
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
  const words = streetWords(streetLow);
  const matchedWords = words.filter(word => display.includes(word)).length;
  const houseNumber = item.address?.house_number ? String(item.address.house_number) : '';

  if (isInsideComuna9(lat, lon)) score += 1200;
  if (display.includes('comuna 9')) score += 180;
  if (display.includes('mataderos') || display.includes('liniers') || display.includes('parque avellaneda')) score += 120;
  if (display.includes('ciudad autonoma de buenos aires') || display.includes('buenos aires')) score += 100;
  if (streetLow && display.includes(streetLow)) score += 120;
  if (words.length) score += Math.round((matchedWords / words.length) * 130);
  if (number && houseNumber === number) score += 120;
  if (number && display.includes(number)) score += 60;
  if (display.includes(addr)) score += 80;
  if (item.type === 'house' || item.addresstype === 'house') score += 25;
  return score;
}

function buildGeocodeQueries(address) {
  const viewbox = `${comuna9Bounds.getWest()},${comuna9Bounds.getNorth()},${comuna9Bounds.getEast()},${comuna9Bounds.getSouth()}`;
  const variants = addressVariants(address);
  const { street, number } = parseStreetNumber(address);
  const contexts = [
    'Comuna 9, Ciudad Autonoma de Buenos Aires, Argentina',
    'Mataderos, Ciudad Autonoma de Buenos Aires, Argentina',
    'Liniers, Ciudad Autonoma de Buenos Aires, Argentina',
    'Parque Avellaneda, Ciudad Autonoma de Buenos Aires, Argentina',
    'CABA, Argentina'
  ];
  const queries = [];

  if (street && number) {
    streetAlternatives(street).forEach(name => {
      queries.push({ format: 'json', limit: '10', countrycodes: 'ar', addressdetails: '1', bounded: '1', viewbox, street: `${number} ${name}`, city: 'Ciudad Autonoma de Buenos Aires', country: 'Argentina' });
    });
  }

  variants.slice(0, 5).forEach(variant => {
    contexts.forEach(context => {
      queries.push({ format: 'json', limit: '10', countrycodes: 'ar', addressdetails: '1', bounded: '1', viewbox, q: `${variant}, ${context}` });
    });
  });

  variants.slice(0, 3).forEach(variant => {
    queries.push({ format: 'json', limit: '10', countrycodes: 'ar', addressdetails: '1', q: `${variant}, Ciudad Autonoma de Buenos Aires, Argentina` });
  });

  const seen = new Set();
  return queries.filter(query => {
    const key = JSON.stringify(query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchNominatim(params) {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Error de geocodificación HTTP ${res.status}`);
  return await res.json();
}

async function geocode(address) {
  let candidates = [];
  let lastError = '';
  for (const params of buildGeocodeQueries(address)) {
    try {
      const data = await fetchNominatim(params);
      candidates = candidates.concat(data);
      const bestInside = candidates
        .map(item => ({ ...item, _score: scoreResult(item, address) }))
        .filter(item => isInsideComuna9(Number(item.lat), Number(item.lon)))
        .sort((a, b) => b._score - a._score)[0];
      if (bestInside && bestInside._score >= 1420) break;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise(r => setTimeout(r, geocodeDelayMs));
  }
  if (!candidates.length) throw new Error(`No encontré: ${address}${lastError ? ` (${lastError})` : ''}`);

  candidates = candidates
    .map(item => ({ ...item, _score: scoreResult(item, address) }))
    .sort((a, b) => b._score - a._score);

  const onlyComuna9 = document.getElementById('onlyComuna9').checked;
  const validCandidates = onlyComuna9
    ? candidates.filter(item => isInsideComuna9(Number(item.lat), Number(item.lon)))
    : candidates;
  if (!validCandidates.length) throw new Error(`Resultado fuera de Comuna 9: ${address}`);

  const best = validCandidates[0];
  const lat = Number(best.lat), lon = Number(best.lon);
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

function labelsVisible() {
  return document.getElementById('showLabels').checked;
}

function syncLabelVisibility() {
  entries.forEach(e => {
    if (!e.label) return;
    if (labelsVisible()) {
      if (!map.hasLayer(e.label)) e.label.addTo(map);
    } else if (map.hasLayer(e.label)) {
      map.removeLayer(e.label);
    }
  });
}

function updateLegend() {
  const list = document.getElementById('legendList');
  const count = document.getElementById('legendCount');
  list.innerHTML = '';
  count.textContent = `${entries.length} ${entries.length === 1 ? 'direccion' : 'direcciones'}`;
  entries.forEach(e => {
    const item = document.createElement('li');
    item.innerHTML = `<span class="legend-num">${e.order}</span><span>${escapeHtml(e.address)}</span>`;
    list.appendChild(item);
  });
}

function setEntryLatLng(entry, latlng) {
  entry.marker.setLatLng(latlng);
  entry.label.setLatLng(latlng);
  updateClusters();
  arrangeLabels(false);
  updateLegend();
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
    div.innerHTML = `<span class="num">${e.order}</span><input value="${escapeHtml(e.address)}" /><button type="button" title="Subir">↑</button><button type="button" title="Bajar">↓</button><button type="button" title="Buscar de nuevo">↻</button><button type="button" title="Reubicar con clic en mapa">◎</button><button type="button" title="Borrar">×</button>`;
    const input = div.querySelector('input');
    input.addEventListener('change', () => {
      e.address = normalizeAddress(input.value);
      input.value = e.address;
      e.label.setIcon(labelIcon(e));
      updateClusters();
      updateLegend();
    });
    div.children[2].onclick = () => moveEntry(idx, -1);
    div.children[3].onclick = () => moveEntry(idx, 1);
    div.children[4].onclick = () => refreshEntry(idx);
    div.children[5].onclick = () => startRelocate(idx);
    div.children[6].onclick = () => deleteEntry(idx);
    list.appendChild(div);
  });
  updateClusters();
  syncLabelVisibility();
  updateLegend();
}

function moveEntry(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= entries.length) return;
  [entries[i], entries[j]] = [entries[j], entries[i]];
  rebuildList();
  arrangeLabels(false);
}

async function refreshEntry(i) {
  const entry = entries[i];
  if (!entry) return;
  setStatus(`[BUSCANDO] ${entry.address}`);
  try {
    const latlng = await geocode(entry.address);
    setEntryLatLng(entry, latlng);
    fitAll();
    setStatus(`[OK] Reubicada: ${entry.order}. ${entry.address}`, 'ok');
  } catch (err) {
    setStatus(`[WARN] ${err.message}`, 'warn');
  }
}

function startRelocate(i) {
  relocatingEntry = entries[i] || null;
  if (!relocatingEntry) return;
  setStatus(`[REUBICAR] Hacé clic en el mapa para ubicar: ${relocatingEntry.order}. ${relocatingEntry.address}`);
}

function deleteEntry(i) {
  const entry = entries[i];
  if (!entry) return;
  if (entry.marker) map.removeLayer(entry.marker);
  if (entry.label) map.removeLayer(entry.label);
  entries.splice(i, 1);
  relocatingEntry = null;
  rebuildList();
  fitAll();
  setStatus(`[OK] Punto borrado. Quedan ${entries.length}.`, 'ok');
}

async function mapAddresses() {
  clearAll();
  const btn = document.getElementById('mapBtn');
  btn.classList.add('loading'); btn.textContent = 'Mapeando...';
  const addresses = document.getElementById('addressInput').value.split('\n').map(normalizeAddress).filter(Boolean);
  let ok = 0, failed = [];

  try {
    if (!addresses.length) {
      setStatus('[WARN] Pegá al menos una dirección.', 'warn');
      return;
    }

    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      setStatus(`[BUSCANDO] ${i + 1}/${addresses.length}: ${address}`);
      try {
        const latlng = await geocode(address);
        const entry = { address, order: entries.length + 1 };
        entry.marker = L.marker(latlng, { icon: pinIcon(entry.order), draggable: true }).addTo(map);
        entry.marker.on('drag', () => updateClusters());
        entry.marker.on('dragend', () => arrangeLabels(false));
        entry.label = L.marker(latlng, { icon: labelIcon(entry), draggable: true, interactive: true, zIndexOffset: 1000 });
        entry.label.on('dragend', () => arrangeLabels(false));
        entries.push(entry);
        ok++;
      } catch (err) {
        failed.push(err.message);
        console.warn(err.message);
      }
      await new Promise(r => setTimeout(r, geocodeDelayMs));
    }
    fitAll();
    setTimeout(() => arrangeLabels(true), 500);
    rebuildList();
    setStatus(`[${failed.length ? 'WARN' : 'OK'}] Mapeadas: ${ok}. Fallidas: ${failed.length}${failed.length ? ' | ' + failed.join(' | ') : ''}`, failed.length ? 'warn' : 'ok');
  } finally {
    btn.classList.remove('loading');
    btn.textContent = 'Mapear direcciones';
  }
}

function clearAll() {
  entries.forEach(e => { if (e.marker) map.removeLayer(e.marker); if (e.label) map.removeLayer(e.label); });
  entries = [];
  relocatingEntry = null;
  clusterLayer.clearLayers();
  clusterGroups = [];
  document.getElementById('list').innerHTML = '';
  updateLegend();
  setStatus('[OK] Listo.');
}

function fitAll() {
  const points = entries.map(e => e.marker?.getLatLng()).filter(Boolean);
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
  syncLabelVisibility();
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
  syncLabelVisibility();
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
  const btn = document.getElementById('pdfBtn');
  btn.classList.add('loading');
  btn.textContent = 'Generando PDF...';
  document.body.classList.add('exporting');
  try {
    document.getElementById('mapTitle').textContent = document.getElementById('titleInput').value || 'Mapa de direcciones';
    updateLegend();
    map.invalidateSize();
    await new Promise(r => setTimeout(r, 500));
    const wrap = document.querySelector('.map-wrap');
    const canvas = await html2canvas(wrap, { useCORS: true, allowTaint: false, scale: 2, backgroundColor: '#020617' });
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
    setStatus('[OK] PDF generado.', 'ok');
  } catch (err) {
    setStatus(`[WARN] No se pudo generar el PDF: ${err.message}`, 'warn');
  } finally {
    document.body.classList.remove('exporting');
    btn.classList.remove('loading');
    btn.textContent = 'Generar PDF';
  }
}

function togglePanel() {
  document.body.classList.toggle('panel-hidden');
  const hidden = document.body.classList.contains('panel-hidden');
  document.getElementById('togglePanelBtn').textContent = hidden ? 'Mostrar panel' : 'Ocultar panel';
  setTimeout(() => map.invalidateSize(), 250);
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
document.getElementById('showLabels').onchange = () => { syncLabelVisibility(); arrangeLabels(false); };
document.getElementById('pdfPreset').onchange = updatePdfPreset;
document.getElementById('orientation').onchange = updatePdfPreset;
document.getElementById('pdfBtn').onclick = exportPdf;
document.getElementById('togglePanelBtn').onclick = togglePanel;
map.on('click', e => {
  if (!relocatingEntry) return;
  setEntryLatLng(relocatingEntry, e.latlng);
  setStatus(`[OK] Reubicada manualmente: ${relocatingEntry.order}. ${relocatingEntry.address}`, 'ok');
  relocatingEntry = null;
});
map.on('zoomend moveend', () => updateClusters());
updatePdfPreset();
updateLegend();
fitAll();
