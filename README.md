# Empire Biryani & Grille Voice Agent Backend

Node.js backend for Vapi tools (`get_menu`, `submit_order`) for an Indian grill ordering flow with Toast integration and test mode.

The included demo tenant is aligned to `Empire Biryani & Grille` using public menu information and restaurant hours from the official site.

## 1) Setup

```bash
cp .env.example .env
npm install
```

## 2) Run server

```bash
npm run dev
```

Server starts on `http://localhost:3000`.

**Stable demo URL (free, no custom domain):** Deploy to **[Render](https://render.com)** (see `render.yaml` and `docs/DEMO_HOSTING.md`) for a fixed `https://your-service.onrender.com` — use that as `PUBLIC_BASE_URL` and in Vapi tools.

**Local-only tunnel:** Vapi cannot call `localhost`. For quick tests on your machine, use **Cloudflare Quick Tunnel** (`cloudflared tunnel --url http://localhost:3000`); the hostname changes when you restart it (section 6).

## 3) Run full local test suite (recommended first)

```bash
npm run test:local
```

This validates:
- menu fetch + business-hours handling
- happy-path submission
- duplicate/idempotent submission
- unavailable item handling
- invalid payload rejection

## 4) Test with sample order payload

In another terminal:

```bash
npm run test:order
```

Expected response (in `ORDER_MODE=test`): success with `mode: "test"` and fake `orderGuid`.

## 5) Test duplicate protection manually

Run `npm run test:order` a second time.  
You should get `duplicate: true` for the same `callId`.

## 6) Stable URL for Vapi (demo)

**Recommended:** deploy this app to **Render** (free). You get `https://<name>.onrender.com` with **no custom domain**. Full steps: **`docs/DEMO_HOSTING.md`**.

Summary:

1. Connect the repo on Render → Web Service → `npm install` / `npm start` (or use **`render.yaml`** as a blueprint).
2. Set **`WEBHOOK_API_KEY`** (and other vars) in the Render dashboard — same key in Vapi.
3. Put your Render URL in **`PUBLIC_BASE_URL`** (local `.env` for `vapi:sync-prompt`, and mirror the tool URLs in Vapi).
4. `npm run vapi:urls` → paste into Vapi; `npm run vapi:sync-prompt` → updates `config/vapi-system-prompt.txt`.

**Free tier:** the app **sleeps** when idle; wake it with `/health/live` before a demo.

### 6b) Local tunnel (hostname changes when cloudflared restarts)

0. `npm run dev` and, in another terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

1. Set **`PUBLIC_BASE_URL`** to the printed `https://….trycloudflare.com` (no trailing slash). Update Vapi + `vapi:sync-prompt` whenever the host changes.

2. Tool URLs and prompt sync:

```bash
npm run vapi:urls
npm run vapi:sync-prompt
```

In Vapi, each tool is **POST** with header **`x-api-key: <WEBHOOK_API_KEY>`**.

Prompt file: **`config/vapi-system-prompt.txt`**

Use this payload shape:

- `config/vapi-webhook-payload-example.json`

## 7) Tool payload formats

`POST /tools/get_menu`

```json
{
  "restaurantId": "rest_001"
}
```

`POST /tools/submit_order`


```json
{
  "sessionId": "session_abc123",
  "callId": "call_123",
  "restaurantId": "rest_001",
  "items": [
    { "menuItemName": "Chicken Dum Biryani", "quantity": 1 },
    { "menuItemName": "Garlic Naan", "quantity": 2 },
    { "menuItemName": "Butter Chicken", "quantity": 1 }
  ]
}
```

## 8) Switch to Toast live mode

1. Set in `.env`:
   - `ORDER_MODE=live`
   - `TOAST_CLIENT_ID`
   - `TOAST_CLIENT_SECRET`
   - `TOAST_RESTAURANT_GUID`
2. Restart server.
3. Send test payload.

## 9) Utility endpoints

- `GET /health/live`
- `GET /health/ready`
- `POST /tools/get_menu`
- `POST /tools/submit_order`
- `POST /webhooks/vapi/order` (legacy alias to submit order)
