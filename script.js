// Estado de la aplicación
const state = {
  items: [], // { id, raw, type, status, lat, lon, displayName, marker }
  awaitingPickForId: null
};

// Mapa y capas
let map, cluster, labelsLayer;
let labelTimer = null;
const MERGE_PX = 28; // distancia en pixeles para unificar etiquetas

function initMap() {
  map = L.map('map', {
    preferCanvas: true,
    zoomControl: true
  }).setView([40.4168, -3.7038], 5); // España por defecto

  // CartoDB Positron para estilo claro y etiquetas legibles
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
    crossOrigin: true
  }).addTo(map);

  cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    maxClusterRadius: 50
  });
  map.addLayer(cluster);

  // Pane para etiquetas por encima de los marcadores
  map.createPane('labelsPane');
  map.getPane('labelsPane').style.zIndex = 650;
  map.getPane('labelsPane').style.pointerEvents = 'none';
  labelsLayer = L.layerGroup().addTo(map);

  map.on('click', onMapClickForManual);
  map.on('moveend zoomend', updateLabelsThrottled);
  window.addEventListener('resize', updateLabelsThrottled);
}

function newId() { return Math.random().toString(36).slice(2, 10); }

function parseInputLines() {
  const ta = document.getElementById('addressesInput');
  const lines = ta.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const items = lines.map(raw => ({ id: newId(), raw, type: 'A', status: 'pending' }));
  return items;
}

function renderList() {
  const wrap = document.getElementById('addressList');
  wrap.innerHTML = '';
  for (const it of state.items) {
    const div = document.createElement('div');
    div.className = 'addr-item';
    div.dataset.id = it.id;

    const top = document.createElement('div');
    top.className = 'addr-top';
    const main = document.createElement('div');
    main.className = 'addr-main';
    main.textContent = it.raw;
    top.appendChild(main);
    const status = document.createElement('div');
    status.className = 'addr-status ' +
      (it.status === 'found' ? 'status-found' : it.status === 'manual' ? 'status-manual' : it.status === 'notfound' ? 'status-notfound' : 'status-pending');
    status.textContent = labelStatus(it);
    top.appendChild(status);
    div.appendChild(top);

    const row = document.createElement('div');
    row.className = 'addr-row';
    const sel = document.createElement('select');
    sel.className = 'addr-type';
    for (const t of ['A','B','C','D']) {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = 'Tipo ' + t; if (it.type === t) opt.selected = true; sel.appendChild(opt);
    }
    sel.addEventListener('change', () => { it.type = sel.value; updateMarkerStyle(it); });
    row.appendChild(sel);

    if (it.status === 'notfound' || it.status === 'pending') {
      const btnManual = document.createElement('button');
      btnManual.className = 'secondary';
      btnManual.textContent = 'Agregar manualmente';
      btnManual.addEventListener('click', () => showManualControls(div, it));
      row.appendChild(btnManual);
    }

    if (it.status === 'found' || it.status === 'manual') {
      const zoomBtn = document.createElement('button');
      zoomBtn.className = 'secondary';
      zoomBtn.textContent = 'Ver';
      zoomBtn.addEventListener('click', () => {
        if (it.marker) {
          map.setView(it.marker.getLatLng(), Math.max(map.getZoom(), 16));
          it.marker.openPopup();
        }
      });
      row.appendChild(zoomBtn);
    }

    div.appendChild(row);
    wrap.appendChild(div);
  }
}

function labelStatus(it) {
  if (it.status === 'found') return 'Encontrada';
  if (it.status === 'manual') return 'Agregada manualmente';
  if (it.status === 'notfound') return 'No encontrada';
  return 'Pendiente';
}

function showManualControls(container, item) {
  let panel = container.querySelector('.manual-panel');
  if (panel) { panel.remove(); }
  panel = document.createElement('div');
  panel.className = 'addr-row manual-panel';

  const lat = document.createElement('input'); lat.placeholder = 'Latitud'; lat.type = 'number'; lat.step = 'any'; lat.className = 'coord';
  const lon = document.createElement('input'); lon.placeholder = 'Longitud'; lon.type = 'number'; lon.step = 'any'; lon.className = 'coord';
  const setBtn = document.createElement('button'); setBtn.textContent = 'Añadir';
  const pickBtn = document.createElement('button'); pickBtn.className = 'secondary'; pickBtn.textContent = 'Seleccionar en mapa';

  setBtn.addEventListener('click', () => {
    const la = parseFloat(lat.value), lo = parseFloat(lon.value);
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      setManual(item, la, lo);
    } else {
      alert('Latitud/Longitud inválida');
    }
  });
  pickBtn.addEventListener('click', () => {
    state.awaitingPickForId = item.id;
    pickBtn.disabled = true;
    pickBtn.textContent = 'Haga clic en el mapa…';
  });

  panel.appendChild(lat); panel.appendChild(lon); panel.appendChild(setBtn); panel.appendChild(pickBtn);
  container.appendChild(panel);
}

function onMapClickForManual(e) {
  const id = state.awaitingPickForId;
  if (!id) return;
  const item = state.items.find(x => x.id === id);
  if (!item) return;
  state.awaitingPickForId = null;
  setManual(item, e.latlng.lat, e.latlng.lng);
}

function setManual(item, lat, lon) {
  item.lat = lat; item.lon = lon; item.status = 'manual';
  addOrUpdateMarker(item);
  renderList();
  enrichManual(item);
}

function makeDivIcon(type) {
  const cls = 'marker tipo' + type;
  return L.divIcon({ className: cls, html: '', iconSize: [26,26], iconAnchor: [13,13], popupAnchor: [0,-10] });
}

function addOrUpdateMarker(item) {
  if (!('lat' in item) || !('lon' in item)) return;
  const latlng = [item.lat, item.lon];
  if (item.marker) {
    item.marker.setLatLng(latlng).setIcon(makeDivIcon(item.type));
    item.marker.bindPopup(popupHtml(item));
    updateLabelsThrottled();
    return;
  }
  const m = L.marker(latlng, { icon: makeDivIcon(item.type), title: item.raw });
  m.bindPopup(popupHtml(item));
  cluster.addLayer(m);
  item.marker = m;
  updateLabelsThrottled();
}

function updateMarkerStyle(item) {
  if (item.marker) {
    item.marker.setIcon(makeDivIcon(item.type));
  }
}

async function geocodeAll(items) {
  // Process sequentially to be gentle on Nominatim
  for (const it of items) {
    await geocodeItem(it);
  }
  fitToMarkers();
  updateLabelsThrottled();
}

async function geocodeItem(item) {
  item.status = 'pending';
  renderList();
  try {
    const restrict = document.getElementById('restrictComuna9').checked ? 'comuna9' : '';
    const url = `/api/geocode?q=${encodeURIComponent(item.raw)}${restrict ? `&restrict=${restrict}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('geocode http ' + res.status);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const best = data[0];
      item.lat = parseFloat(best.lat);
      item.lon = parseFloat(best.lon);
      item.displayName = best.display_name || '';
      if (best.address) {
        const addr = best.address;
        const road = addr.road || addr.residential || addr.pedestrian || addr.neighbourhood || addr.suburb;
        const hn = addr.house_number || addr.housenumber || addr["addr:housenumber"];
        const sl = ((road ? road : '') + (hn ? (' ' + hn) : '')).trim();
        if (sl) item.street = sl;
      }
      item.status = 'found';
      addOrUpdateMarker(item);
      // Enriquecer con reverse (para mostrar info local más precisa)
      try {
        const r = await fetch(`/api/reverse?lat=${item.lat}&lon=${item.lon}`);
        if (r.ok) {
          const rev = await r.json();
          if (rev && rev.address) {
            const a = rev.address;
            const barrio = a.suburb || a.neighbourhood || '';
            const calle = a.road || '';
            const altura = a.house_number || '';
            const ciudad = a.city || a.town || 'CABA';
            // Solo calle y altura para etiquetas
            const road = a.road || a.residential || a.pedestrian || a.neighbourhood || a.suburb;
            const hn = a.house_number || a.housenumber || a["addr:housenumber"];
            const sl2 = ((road ? road : '') + (hn ? (' ' + hn) : '')).trim();
            if (sl2) item.street = sl2;
            const nota = [calle && `${calle} ${altura}`.trim(), barrio, ciudad].filter(Boolean).join(' · ');
            item.displayName = nota || item.displayName;
            // derive street-only label
            {
              const road = a.road || a.residential || a.pedestrian || a.neighbourhood || a.suburb;
              const hn = a.house_number || a.housenumber || a["addr:housenumber"];
              const sl2 = ((road ? road : '') + (hn ? (' ' + hn) : '')).trim();
              if (sl2) item.street = sl2;
            }
            addOrUpdateMarker(item);
          }
        }
      } catch (e) { /* silencioso */ }
      // Entrecalles cercanas (intersecciones)
      try {
        const r2 = await fetch(`/api/intersections?lat=${item.lat}&lon=${item.lon}`);
        if (r2.ok) {
          const ints = await r2.json();
          if (ints && Array.isArray(ints.between) && ints.between.length) {
            item.cross = ints.between;
            addOrUpdateMarker(item);
          }
        }
      } catch (e) { /* silencioso */ }
    } else {
      item.status = 'notfound';
    }
  } catch (e) {
    console.error('geocode error', e);
    item.status = 'notfound';
  }
  renderList();
}

function fitToMarkers() {
  const markers = state.items.filter(i => i.marker).map(i => i.marker);
  if (!markers.length) return;
  const group = new L.featureGroup(markers);
  const b = group.getBounds().pad(0.2);
  map.fitBounds(b);
  if (map.getZoom() < 16) map.setZoom(16); // acercar para ver entrecalles
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]+/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

async function onClickSearch() {
  const parsed = parseInputLines();
  // Merge with existing? For simplicity, replace current list
  // Remove old markers
  cluster.clearLayers();
  state.items = parsed;
  renderList();
  await geocodeAll(state.items);
}

function enrichManual(item) {
  // Reverse
  fetch(`/api/reverse?lat=${item.lat}&lon=${item.lon}`)
    .then(r => r.ok ? r.json() : null)
    .then(rev => {
      if (rev && rev.address) {
        const a = rev.address;
        const barrio = a.suburb || a.neighbourhood || '';
        const calle = a.road || '';
        const altura = a.house_number || '';
        const ciudad = a.city || a.town || 'CABA';
        const nota = [calle && `${calle} ${altura}`.trim(), barrio, ciudad].filter(Boolean).join(' · ');
        item.displayName = nota || item.displayName;
        // derive street-only label
        {
          const road = a.road || a.residential || a.pedestrian || a.neighbourhood || a.suburb;
          const hn = a.house_number || a.housenumber || a["addr:housenumber"];
          const sl2 = ((road ? road : '') + (hn ? (' ' + hn) : '')).trim();
          if (sl2) item.street = sl2;
        }
        addOrUpdateMarker(item);
        renderList();
      }
    }).catch(()=>{});

  // Intersections
  fetch(`/api/intersections?lat=${item.lat}&lon=${item.lon}`)
    .then(r => r.ok ? r.json() : null)
    .then(ints => {
      if (ints && Array.isArray(ints.between) && ints.between.length) {
        item.cross = ints.between;
        addOrUpdateMarker(item);
        renderList();
      }
    }).catch(()=>{});
}

async function onClickSave() {
  const payload = { items: state.items.map(({ id, raw, type, status, lat, lon, displayName }) => ({ id, raw, type, status, lat, lon, displayName })) };
  const res = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    alert('Guardado en data/addresses.json');
  } else {
    alert('No se pudo guardar');
  }
}

async function onClickLoad() {
  const res = await fetch('/api/load');
  if (!res.ok) return alert('No se pudo cargar');
  const data = await res.json();
  if (!data || !Array.isArray(data.items)) return alert('Formato inválido');
  cluster.clearLayers();
  state.items = data.items.map(it => ({ ...it, marker: null }));
  renderList();
  for (const it of state.items) addOrUpdateMarker(it);
  fitToMarkers();
  updateLabelsThrottled();
}

function exportPNGWithHtmlToImage() {
  const node = document.getElementById('map');
  if (!window.htmlToImage) {
    alert('html-to-image no disponible');
    return;
  }
  window.htmlToImage.toPng(node, { pixelRatio: 2 })
    .then((dataUrl) => {
      const link = document.createElement('a');
      link.download = 'mapa.png';
      link.href = dataUrl;
      link.click();
    })
    .catch((err) => {
      console.error(err);
      alert('Error exportando PNG');
    });
}

function exportPDFWithHtmlToImage() {
  const node = document.getElementById('map');
  if (!window.htmlToImage || !window.jspdf) {
    alert('Dependencias de exportación no disponibles');
    return;
  }
  const { jsPDF } = window.jspdf;
  const rect = node.getBoundingClientRect();
  const landscape = rect.width >= rect.height;
  window.htmlToImage.toPng(node, { pixelRatio: 2 })
    .then((dataUrl) => {
      const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 20;
      const maxW = pageW - margin * 2;
      const maxH = pageH - margin * 2;
      // Scale image to fit page while preserving aspect ratio
      let w = rect.width, h = rect.height;
      const ratio = Math.min(maxW / w, maxH / h);
      w *= ratio; h *= ratio;
      const x = (pageW - w) / 2;
      const y = (pageH - h) / 2;
      pdf.addImage(dataUrl, 'PNG', x, y, w, h);
      pdf.save('mapa.pdf');
    })
    .catch((err) => {
      console.error(err);
      alert('Error exportando PDF');
    });
}

function bindUI() {
  document.getElementById('geocodeBtn').addEventListener('click', onClickSearch);
  document.getElementById('saveBtn').addEventListener('click', onClickSave);
  document.getElementById('loadBtn').addEventListener('click', onClickLoad);
  document.getElementById('exportBtn').addEventListener('click', exportPNGWithHtmlToImage);
  document.getElementById('exportPdfBtn').addEventListener('click', exportPDFWithHtmlToImage);
}

function popupHtml(item) {
  const title = `<b>${escapeHtml((item.street && item.street.trim()) || item.raw || '')}</b>`;
  const cross = item.cross && item.cross.length ? `<br/><span class="cross">Entre: ${escapeHtml(item.cross.join(' y '))}</span>` : '';
  return `${title}${cross}`;
}

function updateLabelsThrottled() {
  if (labelTimer) clearTimeout(labelTimer);
  labelTimer = setTimeout(updateLabels, 80);
}

function shortLabel(it) {
  // Prefiere calle y altura; si no, usa texto ingresado
  return (it.street && it.street.trim()) || it.raw || '';
}

function updateLabels() {
  if (!map) return;
  labelsLayer.clearLayers();
  const bounds = map.getBounds();
  // Recolectar puntos visibles
  const pts = [];
  for (const it of state.items) {
    if (!it || typeof it.lat !== 'number' || typeof it.lon !== 'number') continue;
    const ll = L.latLng(it.lat, it.lon);
    if (!bounds.pad(0.2).contains(ll)) continue;
    const p = map.latLngToContainerPoint(ll);
    pts.push({ it, ll, p });
  }
  // Agrupar por proximidad en pixeles
  const used = new Set();
  for (let i = 0; i < pts.length; i++) {
    if (used.has(i)) continue;
    const group = [pts[i]];
    used.add(i);
    for (let j = i + 1; j < pts.length; j++) {
      if (used.has(j)) continue;
      const dx = pts[j].p.x - pts[i].p.x;
      const dy = pts[j].p.y - pts[i].p.y;
      const d = Math.hypot(dx, dy);
      if (d <= MERGE_PX) {
        group.push(pts[j]);
        used.add(j);
      }
    }

    // Centrar etiqueta en el centro del grupo
    const avgPx = group.reduce((acc, g) => { acc.x += g.p.x; acc.y += g.p.y; return acc; }, { x: 0, y: 0 });
    avgPx.x /= group.length; avgPx.y /= group.length;
    const labelLL = map.containerPointToLatLng(avgPx);

    // Texto: unir direcciones si hay más de una
    const texts = group.map(g => shortLabel(g.it));
    const text = texts.join(' - ');

    const tip = L.tooltip({
      permanent: true,
      direction: 'top',
      offset: [0, -10],
      pane: 'labelsPane',
      className: 'addr-label'
    })
    .setLatLng(labelLL)
    .setContent(escapeHtml(text));

    labelsLayer.addLayer(tip);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initMap();
  bindUI();
});
