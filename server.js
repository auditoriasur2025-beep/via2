/**
 * ViaComodoro Scraper — Busbud (URL corregida)
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({ origin: (o, cb) => (!o || ALLOWED.includes('*') || ALLOWED.includes(o)) ? cb(null,true) : cb(new Error('No autorizado')) }));
app.use(express.json());

// Mapeo de ciudades con geohash Y slug correcto
const CITIES = {
  'Comodoro Rivadavia': { geo: '4xb504', slug: 'comodoro-rivadavia' },
  'Bariloche': { geo: '62tmcm', slug: 'san-carlos-de-bariloche' },
  'San Carlos de Bariloche': { geo: '62tmcm', slug: 'san-carlos-de-bariloche' },
  'Buenos Aires': { geo: '69y7pd', slug: 'buenos-aires' },
  'Neuquén': { geo: '6fkfhn', slug: 'neuquen' },
  'Mendoza': { geo: '6bbckf', slug: 'mendoza' },
  'Mar del Plata': { geo: '6fqn00', slug: 'mar-del-plata' },
  'Córdoba': { geo: '6efyn3', slug: 'cordoba' },
  'Puerto Madryn': { geo: '4xn6cd', slug: 'puerto-madryn' },
  'Trelew': { geo: '4xrxv5', slug: 'trelew' },
  'Rosario': { geo: '6efgbb', slug: 'rosario' },
};

// Cache
const cache = new Map();
const TTL = 5 * 60 * 1000;
function key(f,t,d,p) { return `${f}|${t}|${d}|${p}`; }
function get(k) { const e=cache.get(k); if(!e||Date.now()-e.ts>TTL){cache.delete(k);return null;} return e.data; }
function set(k,d) { cache.set(k,{ts:Date.now(),data:d}); if(cache.size>50){const o=[...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0];cache.delete(o[0]);} }

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ViaComodoro Scraper — Busbud v5', version: '5.0' }));

app.get('/search', async (req, res) => {
  const { from, to, date, passengers = 1 } = req.query;
  if (!from || !to || !date) return res.status(400).json({ success: false, error: 'Params: from, to, date' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: 'Date: YYYY-MM-DD' });

  const k = key(from, to, date, passengers);
  const cached = get(k);
  if (cached) { console.log(`[CACHE] ${k}`); return res.json({ ...cached, cached: true }); }

  console.log(`[FETCH] ${from} → ${to} · ${date}`);

  const fromCity = CITIES[from];
  const toCity   = CITIES[to];
  
  // URL de fallback con formato correcto
  const fallbackUrl = fromCity && toCity
    ? `https://www.busbud.com/es/autobus-${fromCity.slug}-${toCity.slug}/r/${fromCity.geo}-${toCity.geo}?date=${date}&adult=${passengers}`
    : `https://www.busbud.com/es?origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}`;

  if (!fromCity || !toCity) {
    console.log(`[WARN] Ciudad no mapeada: ${from} → ${to}`);
    return res.json({
      success: false,
      trips: [],
      error: 'Ciudad no disponible. Ciudades válidas: ' + Object.keys(CITIES).slice(0,5).join(', '),
      busplus_url: fallbackUrl,
    });
  }

  try {
    // URL correcta de Busbud
    const url = `https://www.busbud.com/es/autobus-${fromCity.slug}-${toCity.slug}/r/${fromCity.geo}-${toCity.geo}?date=${date}&adult=${passengers}`;
    
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
    });

    if (!r.ok) throw new Error(`Busbud HTTP ${r.status}`);
    const html = await r.text();

    // Extraer datos
    const trips = parseHTML(html);

    const result = {
      success: trips.length > 0,
      trips: trips,
      total: trips.length,
      error: trips.length === 0 ? 'Sin servicios disponibles' : null,
      busplus_url: url,
      source: 'busbud_html_v5',
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

function parseHTML(html) {
  const trips = [];
  
  // Buscar __NEXT_DATA__
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const props = data?.props?.pageProps || {};
      
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
        const priceARS = price > 1000 ? price / 100 : price;
        
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
          price_display: '$' + Math.round(priceARS).toLocaleString('es-AR'),
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
  
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && (obj[0].departure_time || obj[0].operator_id)) {
      return obj;
    }
    const found = [];
    obj.forEach(item => found.push(...findDepartures(item, depth + 1)));
    return found;
  }
  
  const keys = ['departures', 'trips', 'results', 'data'];
  for (const k of keys) {
    if (obj[k]) {
      const f = findDepartures(obj[k], depth + 1);
      if (f.length) return f;
    }
  }
  
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

app.listen(PORT, () => console.log(`✅ Scraper Busbud v5 en puerto ${PORT}`));
