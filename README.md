# PumpFun Revenue Share Template

**Fork → Deploy → Earn.** Automatic USDC distribution to your pump.fun token holders.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone)

---

## Features

- 🤖 **Auto-claims** pump.fun creator fees every 90 seconds
- 💵 **Distributes USDC** proportionally to all token holders
- 📊 **Full transparency dashboard** with live stats (holders, rounds, per-payment history)
- 🔗 **On-chain verified** — every transaction linkable on Solscan
- ⚙️ **Fully configurable** — fork once, set env vars, done

---

## Quick Start (5 minutes)

### Prerequisites

- A token deployed on [pump.fun](https://pump.fun)
- The deployer wallet private key (base58)
- A Solana RPC endpoint ([Helius](https://helius.dev), [Chainstack](https://chainstack.com), or public mainnet)

---

### Step 1: Deploy Backend (Railway)

The backend is an Express + PostgreSQL service that claims fees and distributes USDC.

**Automated:**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/)

**Manual:**

1. Fork this repo
2. Create a new project on [Railway](https://railway.com)
3. Add a **PostgreSQL** database to the project
4. Connect your fork — set the **root directory** to `backend`
5. Set environment variables (see [`backend/.env.example`](backend/.env.example)):

| Variable | Description |
|---|---|
| `WALLET_PRIVATE_KEY` | Deployer wallet private key (base58) — **required** |
| `TOKEN_MINT` | Your token's mint address — **required** |
| `DATABASE_URL` | PostgreSQL connection string (Railway injects this automatically) |
| `SOLANA_RPC_URL` | RPC endpoint — **required** |
| `CYCLE_MS` | Distribution cycle in milliseconds (default: `90000`) |
| `MIN_HOLDING_PERCENT` | Minimum % of supply to qualify (default: `0.5`) |
| `PORT` | HTTP port (default: `4000`) |

Railway will run `npm start` which compiles and launches the server.

---

### Step 2: Deploy Frontend (Vercel)

The frontend is a Next.js transparency dashboard.

**Automated:**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone)

**Manual:**

1. Import the repo on [Vercel](https://vercel.com)
2. Set the **root directory** to `frontend`
3. Set environment variables (see [`frontend/.env.example`](frontend/.env.example)):

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Your Railway backend URL — **required** |
| `NEXT_PUBLIC_TOKEN_CA` | Your token mint address — **required** |
| `NEXT_PUBLIC_TOKEN_NAME` | Token display name, e.g. `$MYTOKEN` (default: `$TOKEN`) |
| `NEXT_PUBLIC_TOKEN_DESCRIPTION` | Short description shown on the homepage |
| `NEXT_PUBLIC_TWITTER_URL` | Your X/Twitter profile URL |

4. Deploy

---

### Step 3: Replace Logo & Banner Images

The template ships with placeholder Vercel Blob image URLs. Search for the comment `Replace this src with your own token logo URL` in the frontend source to find every `<Image src="...">` that needs updating:

- `frontend/app/page.tsx` — coin logo (header, hero, footer) and hero banner image
- `frontend/app/dashboard/page.tsx` — coin logo (header, footer)

Upload your images to any public CDN (Vercel Blob, Cloudflare R2, etc.) and replace the `src` values.

---

## Architecture

```
┌─────────────────────────────────┐      ┌──────────────────────────────┐
│         Backend (Railway)        │      │       Frontend (Vercel)       │
│                                 │      │                              │
│  Scheduler (every 90 s)         │      │  Next.js App Router          │
│    └─ Claimer                   │      │    /           ← landing page │
│        └─ claim pump.fun fees   │      │    /dashboard  ← live stats  │
│    └─ Snapshot                  │◄─────│                              │
│        └─ fetch token holders   │ API  │  Polls /api/* every 30 s    │
│    └─ Distributor               │      │                              │
│        └─ send USDC per holder  │      └──────────────────────────────┘
│                                 │
│  Express REST API               │
│  PostgreSQL database            │
└─────────────────────────────────┘
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/stats` | Aggregate totals (USDC distributed, rounds, holders, …) |
| `GET` | `/api/holders` | Latest holder snapshot with balances and percentages |
| `GET` | `/api/distributions` | Paginated list of distribution rounds (`?page=1&limit=10`) |
| `GET` | `/api/distributions/:id` | Single distribution with all per-holder payments |
| `GET` | `/api/events` | Recent system event log |
| `GET` | `/health` | Health check |

---

## Database Schema

| Table | Description |
|---|---|
| `claim_rounds` | Each fee-claim cycle (tx signature, USDC amount) |
| `snapshots` | Holder snapshots taken at distribution time |
| `snapshot_holders` | Individual balances per snapshot |
| `distributions` | Distribution rounds (links claim round + snapshot) |
| `distribution_payments` | Per-wallet USDC transfer records |
| `events` | System event log |

---

## Switching to a Different Token

1. Update `WALLET_PRIVATE_KEY` and `TOKEN_MINT` on Railway
2. Update `NEXT_PUBLIC_TOKEN_CA` (and other `NEXT_PUBLIC_*` vars) on Vercel
3. Reset the database so old distribution history is cleared:

```bash
DATABASE_URL="postgresql://..." npx tsx backend/scripts/reset-db.ts
```

Railway will restart the backend automatically after env var changes. Vercel will rebuild the frontend.

---

## Local Development

```bash
# Backend
cd backend
cp .env.example .env   # fill in your values
npm install
npm run dev            # ts-node watch on port 4000

# Frontend (separate terminal)
cd frontend
cp .env.example .env.local   # fill in your values
pnpm install
pnpm dev               # Next.js on port 3000
```

---

## License

MIT — fork freely, ship fast, distribute rewards.
