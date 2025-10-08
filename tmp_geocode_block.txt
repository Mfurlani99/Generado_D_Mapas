const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const morgan = require('morgan');

// Prefer native fetch (Node 18+); fallback to node-fetch
const getFetch = () => {
  if (typeof fetch !== 'undefined') return fetch;
  return (...args) => import('node-fetch').then(({ default: f }) => f(...args));
};
const fetchFn = getFetch();

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'addresses.json');

app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));

// Serve static files from the project root
app.use(express.static(__dirname));

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('Error creating data dir:', err);
  }
}

// Simple health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Geocoding proxy to Nominatim (OpenStreetMap)
// Usage: GET /api/geocode?q=Direccion%20a%20buscar
app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const restrict = (req.query.restrict || '').toString() === 'comuna9';
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  const CABA_VIEWBOX = {
    left: -58.531,   // oeste
    top: -34.526,    // norte (lat menos negativa)
    right: -58.335,  // este
    bottom: -34.705  // sur (lat más negativa)
  };

  const fetchSearch = async (query, useCabaBox = false) => {
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '10',
      countrycodes: 'ar'
    });
    if (useCabaBox) {
      params.set('viewbox', `${CABA_VIEWBOX.left},${CABA_VIEWBOX.top},${CABA_VIEWBOX.right},${CABA_VIEWBOX.bottom}`);
      params.set('bounded', '1');
    }
    const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
    const resp = await fetchFn(url, {
      headers: {
        'User-Agent': 'GeneradorMapas/1.0 (local app)',
        'Accept': 'application/json',
        'Accept-Language': 'es'
      }
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Upstream error ${resp.status}: ${txt}`);
    }
    return resp.json();
  };

  try {
    let data = await fetchSearch(q, restrict); // cuando se restringe, acoto a CABA

    const inComuna9 = (addr) => {
      if (!addr) return false;
      const suburb = (addr.suburb || '').toLowerCase();
      const cityDistrict = (addr.city_district || addr.district || '').toLowerCase();
      const city = (addr.city || addr.town || '').toLowerCase();
      const state = (addr.state || '').toLowerCase();
      const matchesSuburb = ['liniers','mataderos','parque avellaneda'].includes(suburb);
      const matchesDistrict = cityDistrict.includes('comuna 9');
      const matchesCaba = city.includes('buenos aires') || state.includes('buenos aires') || city.includes('autónoma') || state.includes('autónoma') || city === 'caba' || state === 'caba' || city.includes('ciudad autonoma') || state.includes('ciudad autonoma');
      // Acepto si (barrio o comuna) y (CABA por city/state) — pero si barrio coincide, no exijo city si el state ya es BA
      return (matchesSuburb || matchesDistrict) && (matchesCaba || matchesSuburb);
    };

    if (restrict) {
      data = (Array.isArray(data) ? data : []).filter(r => inComuna9(r.address));
      if (data.length === 0) {
        // Reintento con sesgo explícito a Comuna 9, CABA
        const biased1 = `${q}, Comuna 9, Ciudad Autónoma de Buenos Aires, Argentina`;
        const data2 = await fetchSearch(biased1, true);
        data = (Array.isArray(data2) ? data2 : []).filter(r => inComuna9(r.address));
      }
      if (data.length === 0) {
        // Otro intento con CABA (CABA/Capital Federal)
        const biased2 = `${q}, CABA, Argentina`;
        const data3 = await fetchSearch(biased2, true);
        data = (Array.isArray(data3) ? data3 : []).filter(r => inComuna9(r.address));
      }
    }

    res.json(data);
  } catch (err) {
    console.error('Geocode error:', err);
    res.status(500).json({ error: 'Geocode failed' });
  }
});

// Reverse geocoding to enrich labels (e.g., street names)
// Usage: GET /api/reverse?lat=..&lon=..
app.get('/api/reverse', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'Missing lat/lon' });
  }
  try {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: 'jsonv2',
      addressdetails: '1',
      namedetails: '1',
      extratags: '1'
    });
    const url = `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;
    const resp = await fetchFn(url, {
      headers: {
        'User-Agent': 'GeneradorMapas/1.0 (local app)',
        'Accept': 'application/json'
      }
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(resp.status).json({ error: 'Upstream error', details: txt });
    }
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Reverse error:', err);
    res.status(500).json({ error: 'Reverse failed' });
  }
});

// Find nearest cross streets using Overpass API
// Returns up to two closest road names suitable as "entrecalles"
app.get('/api/intersections', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'Missing lat/lon' });
  }
  // Radius in meters
  const radius = Math.max(40, Math.min(120, Number(req.query.radius) || 60));
  // Overpass QL: fetch named highways around point and their nodes
  const q = `
  [out:json][timeout:25];
  (
    way(around:${radius},${lat},${lon})[highway][name];
  );
  (._;>;);
  out body;`;

  try {
    const resp = await fetchFn('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GeneradorMapas/1.0 (local app)' },
      body: new URLSearchParams({ data: q }).toString()
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(resp.status).json({ error: 'Upstream error', details: txt });
    }
    const data = await resp.json();
    // Build node lookup
    const nodes = new Map();
    for (const el of data.elements || []) {
      if (el.type === 'node') nodes.set(el.id, el);
    }
    // Candidate ways with geometry and name
    const ways = [];
    for (const el of data.elements || []) {
      if (el.type !== 'way') continue;
      const name = el.tags && el.tags.name;
      const hw = el.tags && el.tags.highway;
      if (!name || !hw) continue;
      // Filter to vehicular roads primarily
      const skip = ['footway','path','cycleway','steps','bridleway','track'];
      if (skip.includes(hw)) continue;
      const pts = (el.nodes || []).map(id => nodes.get(id)).filter(Boolean).map(n => [n.lat, n.lon]);
      if (pts.length < 2) continue;
      const d = minDistancePointToPolyline(lat, lon, pts);
      ways.push({ name, distance: d });
    }
    ways.sort((a,b) => a.distance - b.distance);
    const unique = [];
    for (const w of ways) {
      if (!unique.find(u => u.name.toLowerCase() === w.name.toLowerCase())) unique.push(w);
      if (unique.length >= 3) break;
    }
    const between = unique.slice(0,2).map(w => w.name);
    res.json({ between, candidates: unique });
  } catch (err) {
    console.error('Intersections error:', err);
    res.status(500).json({ error: 'Intersections failed' });
  }
});

// Compute minimal distance from point to polyline (meters)
function minDistancePointToPolyline(lat, lon, pts) {
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distancePointToSegmentMeters(lat, lon, pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]);
    if (d < min) min = d;
  }
  return min;
}

// Approximate meters using Web Mercator projection-like scaling near the point
function distancePointToSegmentMeters(lat, lon, lat1, lon1, lat2, lon2) {
  const toXY = (la, lo) => {
    const x = (lo) * 111320 * Math.cos(lat * Math.PI/180);
    const y = (la) * 110540;
    return [x,y];
  };
  const [px, py] = toXY(lat, lon);
  const [x1, y1] = toXY(lat1, lon1);
  const [x2, y2] = toXY(lat2, lon2);
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1)*dx + (py - y1)*dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t*dx, cy = y1 + t*dy;
  return Math.hypot(px - cx, py - cy);
}

// Save addresses to local JSON
app.post('/api/save', async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }
  try {
    await ensureDataDir();
    await fsp.writeFile(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Save failed' });
  }
});

// Load saved addresses from local JSON
app.get('/api/load', async (req, res) => {
  try {
    const buf = await fsp.readFile(DATA_FILE, 'utf8');
    const data = JSON.parse(buf);
    res.json(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return res.json({ items: [] });
    }
    console.error('Load error:', err);
    res.status(500).json({ error: 'Load failed' });
  }
});

// Fallback to index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
