# mso-api-proxy

Proxy con caché de la API MSO (`kpi.red.com.sv`) para el Dashboard Intelfon. Agrega `x-api-key` del lado del servidor para que la llave nunca llegue al navegador. Sin dependencias.

## Local

```bash
cp .env.example .env   # completar MSO_API_KEY
npm start
```

`http://localhost:3000/api/health`

## Rutas

| Proxy | API MSO |
|---|---|
| `/api/mso/simcards/*` | `/dashboard-simcards/*` |
| `/api/mso/reclamos/*` | `/dashboard-reclamos-m2m/*` |

`?refresh=1` ignora el caché. La respuesta incluye `X-Cache: HIT | MISS | COALESCED`.

## Variables de entorno

| Variable | Por defecto | |
|---|---|---|
| `MSO_API_KEY` | — | **Obligatoria** |
| `ALLOW_ORIGIN` | `*` | Orígenes permitidos, separados por coma |
| `CACHE_TTL_MS` | `60000` | |
| `MSO_API_BASE_URL` | `https://kpi.red.com.sv/api` | |
| `PORT` | `3000` | Lo asigna el proveedor |
