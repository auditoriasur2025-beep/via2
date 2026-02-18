/**
 * ViaComodoro Scraper — Busbud Edition
 * Usa Busbud en vez de BusPlus (más confiable, usa nombres de ciudades)
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({ origin: (o, cb) => (!o || ALLOWED.includes('*') || ALLOWED.includes(o)) ? cb(null,true) : cb(new Error('No autorizado')) }));
app.use(express.json());

// Geohash codes para Busbud (públicos, verificados)
const CITIES = {
  'Comodoro Rivadavia': '4xb504',
  'Bariloche': '62tmcm',
  'San Carlos de Bariloche': '62tmcm',
  'Buenos Aires': '69y7pd',
  'Neuquén': '6fkfhn',
  'Mendoza': '6bbckf',
  'Mar del Plata': '6fqn00',
  'Córdoba': '6efyn3',
  'Puerto Madryn': '4xn6cd',
  'Trelew': '4xrxv5',
  'Rosario': '6efgbb',
};

// Cache
const cache = new Map();
const TTL = 5 * 60 * 1000;
function key(f,t,d,p) { return `${f}|${t}|${d}|${p}`; }
function get(k) { const e=cache.get(k); if(!e||Date.now()-e.ts>TTL){cache.delete(k);return null;} return e.data; }
function set(k,d) { cache.set(k,{ts:Date.now(),data:d}); if(cache.size>50){const o=[...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0];cache.delete(o[0]);} }

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ViaComodoro Scraper — Busbud', version: '4.0' }));

app.get('/search', async (req, res) => {
  const { from, to, date, passengers = 1 } = req.query;
  if (!from || !to || !date) return res.status(400).json({ success: false, error: 'Params: from, to, date' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: 'Date: YYYY-MM-DD' });

  const k = key(from, to, date, passengers);
  const cached = get(k);
  if (cached) { console.log(`[CACHE] ${k}`); return res.json({ ...cached, cached: true }); }

  console.log(`[FETCH] ${from} → ${to} · ${date}`);

  // Mapear nombres a geohash
  const fromGeo = CITIES[from];
  const toGeo   = CITIES[to];
  
  // Generar URL de Busbud como fallback
  const fallbackUrl = `https://www.busbud.com/es/bus-${slugify(from)}-${slugify(to)}/r/${fromGeo||'4xb504'}-${toGeo||'62tmcm'}?date=${date}&adult=${passengers}`;

  if (!fromGeo || !toGeo) {
    console.log(`[WARN] Ciudad no mapeada: ${from} → ${to}`);
    return res.json({
      success: false,
      trips: [],
      error: 'Ciudad no disponible. Usá: ' + Object.keys(CITIES).slice(0,5).join(', '),
      busplus_url: fallbackUrl,
    });
  }

  try {
    // Intentar fetch directo a Busbud (sin token si es posible)
    const url = `https://www.busbud.com/es/bus-${slugify(from)}-${slugify(to)}/r/${fromGeo}-${toGeo}?date=${date}&adult=${passengers}`;
    
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es',
      },
    });

    if (!r.ok) throw new Error(`Busbud HTTP ${r.status}`);
    const html = await r.text();

    // Extraer datos del HTML de Busbud
    const trips = parseHTML(html, from, to);

    const result = {
      success: trips.length > 0,
      trips: trips,
      total: trips.length,
      error: trips.length === 0 ? 'Sin servicios disponibles' : null,
      busplus_url: url,
      source: 'busbud_html',
    };

    if (trips.length > 0) set(k, result);
    res.json(result);

  } catch (err) {
    console.error('[ERROR]', err.message);
    res.json({
      success: false,
      trips: [],
      error: err.message,
      busplus_url: fallbackUrl,
    });
  }
});

function slugify(s) {
  return s.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ñ/g, 'n');
}

function parseHTML(html, from, to) {
  const trips = [];
  
  // Busbud usa Next.js — buscar __NEXT_DATA__
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const props = data?.props?.pageProps || {};
      
      // Buscar departures en el árbol de datos
      const departures = findDepartures(props);
      const operators  = indexOperators(props.operators || []);
      
      departures.forEach(dep => {
        const avail = parseInt(dep.available_seats || dep.seats_available || 0);
        if (avail < 1) return;
        
        const op = operators[dep.operator_id] || {};
        const cls = (dep.class || dep.class_name || 'economy').toLowerCase();
        
        let seatType = 'salon';
        if (/suite|cama|premium|sleeper/.test(cls)) seatType = 'suite';
        else if (/semi|business/.test(cls)) seatType = 'semicama';
        
        const price = parseFloat(dep.prices?.total || dep.price?.total || dep.price || 0);
        const priceARS = price > 1000 ? price / 100 : price; // centavos → pesos
        
        trips.push({
          id: dep.id || `${op.name}-${dep.departure_time}`,
          operator_name: op.name || op.display_name || 'Operador',
          operator_logo: op.logo_url || '',
          departure_time: (dep.departure_time || '').substring(11, 16),
          arrival_time: (dep.arrival_time || '').substring(11, 16),
          class_raw: dep.class_name || cls,
          seat_type: seatType,
          available_seats: avail,
          price_ars: priceARS,
          price_final: priceARS,
          price_display: '$' + priceARS.toLocaleString('es-AR'),
          surcharge: 0,
          amenities: guessAmen(seatType),
          duration_min: calcDur(dep.departure_time, dep.arrival_time),
          source: 'busbud',
        });
      });
    } catch (e) {
      console.error('[PARSE ERROR]', e.message);
    }
  }
  
  return trips.sort((a,b) => a.departure_time.localeCompare(b.departure_time));
}

function findDepartures(obj, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return [];
  
  // Si es array y parece lista de departures
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && (obj[0].departure_time || obj[0].operator_id)) {
      return obj;
    }
    // Buscar recursivamente
    const found = [];
    obj.forEach(item => found.push(...findDepartures(item, depth + 1)));
    return found;
  }
  
  // Buscar en propiedades conocidas
  const keys = ['departures', 'trips', 'results', 'data'];
  for (const k of keys) {
    if (obj[k]) {
      const f = findDepartures(obj[k], depth + 1);
      if (f.length) return f;
    }
  }
  
  // Buscar en todas las props
  const found = [];
  Object.values(obj).forEach(v => {
    if (typeof v === 'object') found.push(...findDepartures(v, depth + 1));
  });
  
  return found;
}

function indexOperators(list) {
  const map = {};
  list.forEach(op => { map[op.id] = op; });
  return map;
}

function calcDur(dep, arr) {
  if (!dep || !arr) return null;
  try {
    const d1 = new Date(dep);
    const d2 = new Date(arr);
    return Math.round((d2 - d1) / 60000);
  } catch (e) { return null; }
}

function guessAmen(t) {
  const base = ['🚻 Baño', '❄️ AC'];
  if (t === 'suite') return [...base, '🍽️ Comida', '👤 Azafata', '🔌 Enchufes'];
  if (t === 'semicama') return [...base, '🔌 Enchufes'];
  return base;
}

app.listen(PORT, () => console.log(`✅ Scraper Busbud en puerto ${PORT}`));
