# Stable demo URL (free, no custom domain)

Vapi needs a **public HTTPS URL**. For demos you do **not** need your own domain.

## Option A — Render (recommended)

You get a **fixed** URL like `https://restagent.onrender.com` (exact hostname is shown in the Render dashboard after deploy).

### Path 1 — Blueprint (uses `render.yaml` in this repo)

1. Code is already on **GitHub** (e.g. `deejaychai2-crypto/restagent`).
2. Open [dashboard.render.com](https://dashboard.render.com) → sign up / log in.
3. **New +** → **Blueprint** → connect the **same** GitHub account → pick repo **`restagent`**.
4. Render reads **`render.yaml`**. Confirm the web service name (default **`restagent`**) and region.
5. Before **Apply**, open **Environment** for that service and add variables below (Blueprint may not set secrets—you add them in the UI).
6. **Apply** / deploy. Wait for **Live**.
7. Open your service URL → try **`/health/live`** (should return JSON `{"ok":true}`).

### Path 2 — Web Service (manual, same result)

1. **New +** → **Web Service** → connect **`restagent`**.
2. **Runtime:** Node  
3. **Build command:** `npm install`  
4. **Start command:** `npm start`  
5. **Instance type:** Free  
6. **Health check path:** `/health/live` (optional but useful)

### Environment variables (set in Render → your service → **Environment**)

| Key | Example | Notes |
|-----|---------|--------|
| `WEBHOOK_API_KEY` | long random string | **Same value** as Vapi tool header `x-api-key` |
| `ORDER_MODE` | `test` | Use `live` + Toast vars only when you are ready |
| `RESTAURANT_TIMEZONE` | `America/New_York` | |
| `BUSINESS_HOURS_OPEN` | `11:30` | Menu/order gate |
| `BUSINESS_HOURS_CLOSE` | `21:30` | |
| `LOG_LEVEL` | `info` | Optional |

**Optional (logging only):** after first deploy, add `PUBLIC_BASE_URL` = your exact Render URL (no trailing slash) so startup logs point at the right host. Vapi still needs tool URLs set separately.

**Do not** set `ORDERS_HUB_ALLOW_NO_AUTH=true` on a public URL unless you accept unauthenticated access to Orders Hub JSON. For demos, leave it unset and use **API key** in the Orders Hub browser UI.

### After deploy — Vapi and local `.env`

1. Copy the service URL from Render (e.g. `https://restagent.onrender.com`).
2. On your laptop, set **`PUBLIC_BASE_URL`** in `.env` to that origin (no trailing slash).
3. Run:

   ```bash
   npm run vapi:urls
   npm run vapi:sync-prompt
   ```

4. Paste the printed URLs into **Vapi** tool definitions (`get_menu`, `submit_order`) and keep **`x-api-key`** = same `WEBHOOK_API_KEY` as in Render.

**Free tier:** the service **sleeps** after ~15 minutes idle. The first request after sleep can take **~30–60 seconds** — open **`/health/live`** once before a demo to wake it.

## Option B — Quick tunnel (unchanging hostname only while process runs)

`cloudflared tunnel --url http://localhost:3000` — free, but the hostname **changes** when you restart `cloudflared`. Fine for dev, awkward for demos.

## Option C — Other free PaaS

Same idea as Render: **Railway**, **Fly.io**, etc. — assign env vars, use their `https://…` URL as `PUBLIC_BASE_URL` for Vapi.
