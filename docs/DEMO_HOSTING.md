# Stable demo URL (free, no custom domain)

Vapi needs a **public HTTPS URL**. For demos you do **not** need your own domain.

## Option A — Render (recommended)

You get a **fixed** URL like `https://restvagent.onrender.com` (name depends on what you choose in Render).

1. Push this repo to **GitHub** (or GitLab / Bitbucket Render supports).
2. Go to [render.com](https://render.com) → sign up (free).
3. **New +** → **Web Service** → connect the repo.
4. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
5. **Environment** → add at least:
   - `WEBHOOK_API_KEY` — long random string (use the same value in Vapi `x-api-key`)
   - `ORDER_MODE` — `test` for demo without Toast
   - `RESTAURANT_TIMEZONE`, `BUSINESS_HOURS_OPEN`, `BUSINESS_HOURS_CLOSE` — match how you want the menu gate to behave
6. **Do not** set `ORDERS_HUB_ALLOW_NO_AUTH=true` on a public URL unless you accept anyone opening the Orders Hub JSON. For demos, omit it or use `false` and use the API key in the hub UI.
7. Deploy. Copy the service URL (e.g. `https://restvagent.onrender.com`).
8. Locally, set `PUBLIC_BASE_URL` in `.env` to that URL (no trailing slash), run `npm run vapi:sync-prompt`, and paste the same tool URLs into **Vapi** (`npm run vapi:urls`).

**Free tier:** the service **sleeps** after ~15 minutes idle. The first request after sleep can take **~30–60 seconds** — hit **Open URL** or `/health/live` once before a demo to wake it.

You can also commit `render.yaml` and use **New +** → **Blueprint** for the same shape.

## Option B — Quick tunnel (unchanging hostname only while process runs)

`cloudflared tunnel --url http://localhost:3000` — free, but the hostname **changes** when you restart `cloudflared`. Fine for dev, awkward for demos.

## Option C — Other free PaaS

Same idea as Render: **Railway**, **Fly.io**, etc. — assign env vars, use their `https://…` URL as `PUBLIC_BASE_URL` for Vapi.
