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

// Geocoding proxy supporting Nominatim (OSM), Georef (AR) and Mapbox
// Usage: GET /api/geocode?q=Direccion&engine=auto|georef|nominatim|mapbox&restrict=comuna9
app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const restrict = (req.query.restrict || '').toString() === 'comuna9';
  const engine = 'nominatim';
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  // Nominatim helpers
  const CABA_VIEWBOX = {
    left: -58.531,   // oeste
    top: -34.526,    // norte (lat menos negativa)
    right: -58.335,  // este
    bottom: -34.705  // sur (lat más negativa)
  };
  const fetchNominatim = async (query, useCabaBox = false) => {
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '5',
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
  const inComuna9_OSM = (addr) => {
    if (!addr) return false;
    const suburb = (addr.suburb || '').toLowerCase();
    const cityDistrict = (addr.city_district || addr.district || '').toLowerCase();
    const city = (addr.city || addr.town || '').toLowerCase();
    const state = (addr.state || '').toLowerCase();
    const matchesSuburb = ['liniers','mataderos','parque avellaneda'].includes(suburb);
    const matchesDistrict = cityDistrict.includes('comuna 9');
    const matchesCaba = city.includes('buenos aires') || state.includes('buenos aires') || city.includes('autónoma') || state.includes('autónoma') || city === 'caba' || state === 'caba' || city.includes('ciudad autonoma') || state.includes('ciudad autonoma');
    return (matchesSuburb || matchesDistrict) && (matchesCaba || matchesSuburb);
  };

  // Georef helpers
  const fetchGeoref = async (query, opts = {}) => {
    const params = new URLSearchParams({ direccion: query, max: String(opts.max || 10) });
    if (opts.provincia) params.set('provincia', opts.provincia);
    if (opts.departamento) params.set('departamento', opts.departamento);
    const url = `https://apis.datos.gob.ar/georef/api/direcciones?${params.toString()}`;
    const resp = await fetchFn(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'es-AR,es;q=0.9',
        'User-Agent': 'GeneradorMapas/1.0 (local app)'
      }
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Georef upstream error ${resp.status}: ${txt}`);
    }
    const json = await resp.json();
    const dirs = Array.isArray(json?.direcciones) ? json.direcciones : [];
    const mapped = dirs
      .filter(d => d?.ubicacion && typeof d.ubicacion.lat === 'number' && typeof d.ubicacion.lon === 'number')
      .map(d => {
        const lat = d.ubicacion.lat;
        const lon = d.ubicacion.lon;
        const calle = d.calle?.nombre || '';
        const altura = d.altura || d.puerta || '';
        const localidad = d.localidad?.nombre || d.municipio?.nombre || '';
        const provincia = d.provincia?.nombre || '';
        const display_name = [calle && `${calle} ${altura}`.trim(), localidad, provincia, 'Argentina'].filter(Boolean).join(', ');
        const address = {
          road: calle || undefined,
          house_number: altura || undefined,
          city: localidad || undefined,
          town: undefined,
          state: provincia || undefined,
          country: 'Argentina',
          country_code: 'ar',
          city_district: (d.departamento?.nombre || '').toLowerCase().includes('comuna') ? d.departamento?.nombre : undefined,
          suburb: undefined
        };
        return { lat, lon, display_name, address, geocoder: 'georef', addressdetails: address, raw: d };
      });
    const filtered = restrict ? mapped.filter(r => {
      const dep = r?.raw?.departamento?.nombre || '';
      const depId = r?.raw?.departamento?.id || '';
      const matchDep = dep.toLowerCase().includes('comuna 9') || depId === '02009';
      const prov = r?.raw?.provincia?.nombre || '';
      const matchProv = prov.toLowerCase().includes('ciudad autónoma de buenos aires') || prov.toLowerCase().includes('ciudad autonoma de buenos aires') || prov.toLowerCase() === 'caba';
      return matchDep && matchProv;
    }) : mapped;
    return filtered;
  };

  // Intersection helpers
  const parseIntersection = (s) => {
    const norm = s.replace(/\s+/g, ' ').trim();
    // common separators: " y ", " & ", "/"
    const sepMatch = norm.match(/^(.*?)[\s]*(?:y|&|\/)[\s]*(.*)$/i);
    if (!sepMatch) return null;
    const a = sepMatch[1].trim();
    const b = sepMatch[2].trim();
    if (!a || !b) return null;
    return { a, b };
  };
  const fetchGeorefIntersection = async (a, b, opts = {}) => {
    const params = new URLSearchParams({
      calle_nombre: a,
      interseccion_nombre: b,
      max: String(opts.max || 10)
    });
    if (opts.provincia) params.set('provincia', opts.provincia);
    if (opts.departamento) params.set('departamento', opts.departamento);
    const url = `https://apis.datos.gob.ar/georef/api/intersecciones?${params.toString()}`;
    const resp = await fetchFn(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'GeneradorMapas/1.0 (local app)' } });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Georef intersections upstream error ${resp.status}: ${txt}`);
    }
    const json = await resp.json();
    const arr = Array.isArray(json?.intersecciones) ? json.intersecciones : [];
    const mapped = arr
      .filter(it => it?.ubicacion && typeof it.ubicacion.lat === 'number' && typeof it.ubicacion.lon === 'number')
      .map(it => {
        const lat = it.ubicacion.lat;
        const lon = it.ubicacion.lon;
        const localidad = it.localidad?.nombre || it.municipio?.nombre || '';
        const provincia = it.provincia?.nombre || '';
        const display_name = [`${a} y ${b}`, localidad, provincia, 'Argentina'].filter(Boolean).join(', ');
        const address = {
          road: `${a} y ${b}`,
          city: localidad || undefined,
          state: provincia || undefined,
          country: 'Argentina',
          country_code: 'ar'
        };
        return { lat, lon, display_name, address, geocoder: 'georef', raw: it };
      });
    const filtered = restrict ? mapped.filter(r => {
      const prov = (r?.address?.state || '').toLowerCase();
      const loc = (r?.address?.city || '').toLowerCase();
      const inCaba = prov.includes('ciudad aut') || prov === 'caba' || loc.includes('buenos aires');
      // Cannot strictly verify Comuna 9 here; leave CABA filter
      return inCaba;
    }) : mapped;
    return filtered;
  };

  // Mapbox helpers (requires MAPBOX_TOKEN)
  const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';
  const fetchMapbox = async (query) => {
    if (!MAPBOX_TOKEN) return [];
    const params = new URLSearchParams({
      access_token: MAPBOX_TOKEN,
      country: 'AR',
      language: 'es',
      limit: '10',
      types: 'address,poi'
    });
    // Bias to CABA area if restricting
    if (restrict) {
      // BBOX aproximada CABA
      params.set('bbox', '-58.531,-34.705,-58.335,-34.526');
    }
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params.toString()}`;
    const resp = await fetchFn(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'GeneradorMapas/1.0 (local app)' } });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Mapbox upstream error ${resp.status}: ${txt}`);
    }
    const json = await resp.json();
    const feats = Array.isArray(json?.features) ? json.features : [];
    const mapped = feats.map(f => {
      const [lon, lat] = (f.center && Array.isArray(f.center)) ? f.center : (f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [null, null]);
      const props = f.properties || {};
      const ctx = Array.isArray(f.context) ? f.context : [];
      const getCtx = (idPrefix) => (ctx.find(c => typeof c.id === 'string' && c.id.startsWith(idPrefix)) || {});
      const neighborhood = (getCtx('neighbourhood')?.text_es || getCtx('neighborhood')?.text || props.neighborhood || '').toString();
      const place = (getCtx('place')?.text_es || getCtx('place')?.text || props.place || '').toString();
      const region = (getCtx('region')?.text_es || getCtx('region')?.text || props.region || '').toString();
      const district = (getCtx('district')?.text_es || getCtx('district')?.text || props.district || '').toString();
      const addressNumber = (props['address'] || '').toString();
      const street = (props['street'] || f.text_es || f.text || '').toString();
      const display_name = f.place_name_es || f.place_name || '';
      const address = {
        road: street || undefined,
        house_number: addressNumber || undefined,
        suburb: neighborhood || undefined,
        city: place || undefined,
        state: region || undefined,
        city_district: district || undefined,
        country: 'Argentina',
        country_code: 'ar'
      };
      return { lat, lon, display_name, address, geocoder: 'mapbox', raw: f };
    }).filter(r => typeof r.lat === 'number' && typeof r.lon === 'number');
    // If restricting to Comuna 9, filter by known neighborhoods
    const filtered = restrict ? mapped.filter(r => {
      const sub = (r?.address?.suburb || '').toLowerCase();
      const place = (r?.address?.city || '').toLowerCase();
      const region = (r?.address?.state || '').toLowerCase();
      const inCaba = place.includes('buenos aires') || region.includes('buenos aires') || place === 'caba' || region === 'caba' || place.includes('ciudad autonoma') || region.includes('ciudad autonoma');
      const inCom9 = ['liniers','mataderos','parque avellaneda'].includes(sub);
      return inCaba && inCom9;
    }) : mapped;
    return filtered;
  };

  try {
    // Fast path: if query looks like an intersection, try Georef intersecciones first
    const inter = parseIntersection(q);
    if (inter) {
      const opts = restrict ? { provincia: 'Ciudad Aut\u00F3noma de Buenos Aires', departamento: 'Comuna 9', max: 10 } : { max: 10 };
      let results = await fetchGeorefIntersection(inter.a, inter.b, opts);
      if (restrict && results.length === 0) {
        results = await fetchGeorefIntersection(inter.a, inter.b, { provincia: 'Ciudad Aut\u00F3noma de Buenos Aires', max: 10 });
      }
      if (results.length > 0) {
        return res.json(results);
      }
    }
    const tryGeoref = async () => {
      const opts = restrict ? { provincia: 'Ciudad Autónoma de Buenos Aires', departamento: 'Comuna 9', max: 10 } : { max: 10 };
      const r = await fetchGeoref(q, opts);
      if (restrict && r.length === 0) {
        return fetchGeoref(q, { provincia: 'Ciudad Autónoma de Buenos Aires', max: 10 });
      }
      return r;
    };
    const tryNominatim = async () => {
      let data = await fetchNominatim(q, restrict);
      if (restrict) {
        data = (Array.isArray(data) ? data : []).filter(r => inComuna9_OSM(r.address));
        if (data.length === 0) {
          const biased1 = `${q}, Comuna 9, Ciudad Autónoma de Buenos Aires, Argentina`;
          const data2 = await fetchNominatim(biased1, true);
          data = (Array.isArray(data2) ? data2 : []).filter(r => inComuna9_OSM(r.address));
        }
        if (data.length === 0) {
          const biased2 = `${q}, CABA, Argentina`;
          const data3 = await fetchNominatim(biased2, true);
          data = (Array.isArray(data3) ? data3 : []).filter(r => inComuna9_OSM(r.address));
        }
      }
      return data;
    };

    // Always use Nominatim
    const results = await tryNominatim();

    res.json(results);
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
      zoom: '18',
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
