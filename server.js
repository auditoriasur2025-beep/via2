/**
 * ViaComodoro Scraper v3 — Parser mejorado para BusPlus
 * Extrae datos directamente del HTML renderizado
 */

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({ origin: (o, cb) => (!o || ALLOWED.includes('*') || ALLOWED.includes(o)) ? cb(null,true) : cb(new Error('No autorizado')) }));
app.use(express.json());

// Cache
const cache = new Map();
const TTL = 5 * 60 * 1000;
function key(f,t,d,p) { return `${f}|${t}|${d}|${p}`; }
function get(k) { const e=cache.get(k); if(!e||Date.now()-e.ts>TTL){cache.delete(k);return null;} return e.data; }
function set(k,d) { cache.set(k,{ts:Date.now(),data:d}); if(cache.size>50){const o=[...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0];cache.delete(o[0]);} }

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ViaComodoro Scraper v3', version: '3.0' }));

app.get('/search', async (req, res) => {
  const { from, to, date, passengers = 1 } = req.query;
  if (!from || !to || !date) return res.status(400).json({ success: false, error: 'Params: from, to, date' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: 'Date: YYYY-MM-DD' });

  const k = key(from, to, date, passengers);
  const cached = get(k);
  if (cached) { console.log(`[CACHE] ${k}`); return res.json({ ...cached, cached: true }); }

  console.log(`[FETCH] ${from} → ${to} · ${date}`);

  try {
    const [y, m, d] = date.split('-');
    const dateBP = `${d}-${m}-${y}`;
    const url = `https://checkout.busplus.com.ar/?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&departure=${dateBP}&cant_pasajeros=${passengers}`;

    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
    });

    if (!r.ok) throw new Error(`BusPlus HTTP ${r.status}`);
    const html = await r.text();

    // Parser específico para el HTML de BusPlus
    const trips = parseHTML(html);

    const result = {
      success: trips.length > 0,
      trips: trips,
      total: trips.length,
      error: trips.length === 0 ? 'Sin servicios disponibles' : null,
      busplus_url: url,
      source: 'busplus_html_v3',
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

// Parser HTML de BusPlus
function parseHTML(html) {
  const trips = [];
  
  // Extraer cada <div class="r-item"> que contiene un servicio
  const itemRegex = /<div class="r-item[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let match;
  
  while ((match = itemRegex.exec(html)) !== null) {
    const itemHtml = match[1];
    
    // Extraer operador
    const opMatch = itemHtml.match(/alt="([^"]+)"/);
    const operator = opMatch ? opMatch[1] : 'Via Bariloche';
    
    // Extraer horarios
    const timeMatches = itemHtml.match(/<div class="h[^"]*">(\d{2}:\d{2})/g);
    if (!timeMatches || timeMatches.length < 2) continue;
    
    const depTime = timeMatches[0].match(/(\d{2}:\d{2})/)[1];
    const arrTime = timeMatches[1].match(/(\d{2}:\d{2})/)[1];
    
    // Extraer duración
    const durMatch = itemHtml.match(/Duraci[oó]n:\s*(\d+)\s*h\s*(\d+)\s*min/);
    const durMinutes = durMatch ? (parseInt(durMatch[1]) * 60 + parseInt(durMatch[2])) : null;
    
    // Extraer categorías y precios
    const catMatches = itemHtml.match(/<div>(.*?)<\/div>/g);
    const categories = [];
    const prices = [];
    
    // Buscar precios con formato específico
    const priceMatches = itemHtml.match(/\$<\/span>([0-9.,]+)<\/span>/g);
    if (priceMatches) {
      priceMatches.forEach(pm => {
        const price = pm.match(/([0-9.,]+)/)[1].replace(/\./g,'').replace(',','.');
        prices.push(parseFloat(price));
      });
    }
    
    // Extraer nombres de categorías
    const catDivs = itemHtml.match(/<div class="cats">[\s\S]*?<\/div>/);
    if (catDivs) {
      const catNames = catDivs[0].match(/>([^<]+)</g);
      if (catNames) {
        catNames.forEach(cn => {
          const name = cn.replace(/>/g,'').replace(/</g,'').trim();
          if (name && name.length > 3 && !name.includes('div') && !name.includes('from')) {
            categories.push(name);
          }
        });
      }
    }
    
    // Crear un trip por cada categoría/precio
    const maxItems = Math.max(categories.length, prices.length);
    for (let i = 0; i < maxItems; i++) {
      const cat = categories[i] || 'Servicio';
      const price = prices[i] || (prices[0] || 0);
      
      if (!cat || price === 0) continue;
      
      const catL = cat.toLowerCase();
      let seatType = 'salon';
      if (/cama|suite|ejecut|premium/.test(catL)) seatType = 'suite';
      else if (/semi/.test(catL)) seatType = 'semicama';
      
      trips.push({
        id: `${operator}-${depTime}-${cat}`,
        operator_name: operator,
        operator_logo: '',
        departure_time: depTime,
        arrival_time: arrTime,
        class_raw: cat,
        seat_type: seatType,
        available_seats: null,
        price_ars: price,
        price_final: price,
        price_display: '$' + price.toLocaleString('es-AR'),
        surcharge: 0,
        amenities: guessAmen(seatType),
        duration_min: durMinutes,
        source: 'busplus',
      });
    }
  }
  
  return trips.sort((a,b) => a.departure_time.localeCompare(b.departure_time));
}

function guessAmen(t) {
  const base = ['🚻 Baño', '❄️ AC'];
  if (t === 'suite') return [...base, '🍽️ Comida', '👤 Azafata', '🔌 Enchufes'];
  if (t === 'semicama') return [...base, '🔌 Enchufes'];
  return base;
}

app.listen(PORT, () => console.log(`✅ Scraper v3 en puerto ${PORT}`));
