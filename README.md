# ViaComodoro Scraper — Deploy en Render.com (Gratis)

Microservicio Node.js que extrae disponibilidad real de BusPlus/Via Bariloche
y se la pasa al plugin WordPress de ViaComodoro.

---

## Deploy en 5 minutos (gratis)

### Paso 1 — Subir a GitHub
1. Creá un repositorio PRIVADO en github.com
2. Subí estos archivos: `server.js`, `package.json`, `render.yaml`

### Paso 2 — Deploy en Render.com
1. Entrá a https://render.com y creá cuenta gratis
2. Click en **"New +"** → **"Web Service"**
3. Conectá tu repositorio de GitHub
4. Render detecta automáticamente el `render.yaml`
5. En **Environment Variables** agregá:
   - `ALLOWED_ORIGINS` = `https://tudominio.com` (tu WordPress)
6. Click **"Deploy"**
7. Esperás ~3 minutos → te da una URL tipo `https://viacomodoro-scraper.onrender.com`

### Paso 3 — Configurar el plugin WordPress
1. Andá a **ViaComodoro → Configuración** en WordPress
2. En el campo **"URL del Scraper"** pegá tu URL de Render
3. Guardá

### Paso 4 — Probar
Abrí en el navegador:
```
https://viacomodoro-scraper.onrender.com/search?from=Comodoro+Rivadavia&to=Bariloche&date=2026-03-20&passengers=1
```
Deberías ver un JSON con los servicios disponibles.

---

## Notas importantes

**Plan gratuito de Render:** el servicio "duerme" después de 15 minutos sin requests.
La primera búsqueda del día puede tardar 30-60 segundos en despertar.
Para evitar esto, podés usar https://uptimerobot.com (gratis) para hacer un ping
cada 10 minutos y mantenerlo despierto.

**Cache:** los resultados se cachean 5 minutos en memoria.
Si BusPlus cambia su estructura HTML, los resultados pueden fallar y el plugin
activa el modo fallback automáticamente.

**Variables de entorno opcionales:**
- `DEBUG=true` → incluye HTML de BusPlus en la respuesta para debug
- `CACHE_TTL_MS=300000` → tiempo de cache en milisegundos (default 5 min)
