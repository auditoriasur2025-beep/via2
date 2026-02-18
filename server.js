/**
 * ViaComodoro Scraper LITE — sin Puppeteer
 * Usa fetch directo a BusPlus para obtener disponibilidad
 * Deploy ultra-rápido en Render (30 segundos)
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({ origin: (o, cb) => (!o || ALLOWED.includes('*') || ALLOWED.includes(o)) ? cb(null,true) : cb(new Error('No autorizado')) }));
app.use(express.json());

// Cache simple
const cache = new Map();
const TTL = 5 * 60 * 1000;
function key(f,t,d,p) { return `${f}|${t}|${d}|${p}`; }
function get(k) { const e=cache.get(k); if(!e||Date.now()-e.ts>TTL){cache.delete(k);return null;} return e.data; }
function set(k,d) { cache.set(k,{ts:Date.now(),data:d}); if(cache.size>50){const o=[...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0];cache.delete(o[0]);} }

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ViaComodoro Scraper LITE', version: '2.0' }));

app.get('/search', async (req, res) => {
  const { from, to, date, passengers = 1 } = req.query;
  if (!from || !to || !date) return res.status(400).json({ success: false, error: 'Params: from, to, date' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: 'Date: YYYY-MM-DD' });

  const k = key(from, to, date, passengers);
  const cached = get(k);
  if (cached) { console.log(`[CACHE] ${k}`); return res.json({ ...cached, cached: true }); }

  console.log(`[FETCH] ${from} → ${to} · ${date}`);

  try {
    // BusPlus URL directa
    const [y, m, d] = date.split('-');
    const dateBP = `${d}-${m}-${y}`;
    const url = `https://checkout.busplus.com.ar/?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&departure=${dateBP}&cant_pasajeros=${passengers}`;

    // Fetch HTML
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
    });

    if (!r.ok) throw new Error(`BusPlus HTTP ${r.status}`);
    const html = await r.text();

    // Extraer datos embedded en __NEXT_DATA__ o window vars
    const trips = parseHTML(html);

    const result = {
      success: trips.length > 0,
      trips: applyServiceCharge(trips),
      total: trips.length,
      error: trips.length === 0 ? 'Sin servicios disponibles' : null,
      busplus_url: url,
      source: 'busplus_html',
    };

    if (trips.length > 0) set(k, result);
    res.json(result);

  } catch (err) {
    console.error('[ERROR]', err.message);
    const [y,m,d] = date.split('-');
    const fallback = `https://checkout.busplus.com.ar/?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&departure=${d}-${m}-${y}&cant_pasajeros=${passengers}`;
    res.json({ success: false, trips: [], error: err.message, busplus_url: fallback });
  }
});

// Parser HTML
function parseHTML(html) {
  const trips = [];

  // Estrategia 1: __NEXT_DATA__
  const nextMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const extracted = extractFromNextData(data);
      if (extracted.length) return extracted;
    } catch(e) {}
  }

  // Estrategia 2: window.__INITIAL_STATE__
  const stateMatch = html.match(/window\.__(?:INITIAL_STATE|APP_STATE|DATA)__\s*=\s*(\{.*?\});/s);
  if (stateMatch) {
    try {
      const data = JSON.parse(stateMatch[1]);
      const extracted = extractFromState(data);
      if (extracted.length) return extracted;
    } catch(e) {}
  }

  // Estrategia 3: buscar patterns de JSON en el HTML
  const jsonMatches = html.match(/"hora_salida"\s*:\s*"([^"]+)"[^}]*"precio"\s*:\s*(\d+)/g);
  if (jsonMatches) {
    jsonMatches.forEach(m => {
      const time = m.match(/"hora_salida"\s*:\s*"([^"]+)"/)?.[1];
      const price = m.match(/"precio"\s*:\s*(\d+)/)?.[1];
      if (time && price) trips.push(normalize({ hora_salida: time, precio: parseFloat(price) }));
    });
  }

  return trips;
}

function extractFromNextData(data) {
  const trips = [];
  const props = data?.props?.pageProps || {};
  const candidates = [props.trips, props.services, props.departures, props.viajes, props.servicios].filter(Boolean);
  for (const list of candidates) {
    if (Array.isArray(list) && list.length > 0) {
      list.forEach(item => { const t = normalize(item); if (t) trips.push(t); });
      if (trips.length) break;
    }
  }
  return trips;
}

function extractFromState(data) {
  return extractFromNextData({ props: { pageProps: data } });
}

function normalize(raw) {
  const dep = clean(raw.hora_salida || raw.departure_time || raw.salida || '');
  const arr = clean(raw.hora_llegada || raw.arrival_time || raw.llegada || '');
  const price = parseFloat(raw.precio || raw.price || raw.importe || 0);
  const op = raw.empresa || raw.operator || 'Via Bariloche';
  const srv = raw.servicio || raw.service || raw.clase || 'Servicio';
  const seats = raw.asientos_disp ?? raw.available_seats ?? null;
  const id = raw.id || `${dep}-${op}`;

  if (!dep && !price) return null;

  const srvL = srv.toLowerCase();
  let type = 'salon';
  if (/suite|cama|ejecut|premium/.test(srvL)) type = 'suite';
  else if (/semi|dormis/.test(srvL)) type = 'semicama';

  return {
    id: String(id),
    operator_name: op,
    operator_logo: '',
    departure_time: dep,
    arrival_time: arr,
    class_raw: srv,
    seat_type: type,
    available_seats: seats !== null ? parseInt(seats) : null,
    price_ars: price,
    price_final: price,
    price_display: '$' + price.toLocaleString('es-AR'),
    surcharge: 0,
    amenities: guessAmen(type),
    source: 'busplus',
  };
}

function clean(t) {
  if (!t) return '';
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : '';
}

function guessAmen(t) {
  const base = ['🚻 Baño', '❄️ AC'];
  if (t === 'suite') return [...base, '🍽️ Comida', '👤 Azafata', '🔌 Enchufes'];
  if (t === 'semicama') return [...base, '🔌 Enchufes'];
  return base;
}

function applyServiceCharge(trips) {
  // El servicecharge lo aplica WordPress, acá solo pasamos los datos crudos
  return trips;
}

app.listen(PORT, () => console.log(`✅ Scraper LITE en puerto ${PORT}`));
