# CUMBANK Backend

## Architecture
- Express.js + TypeScript backend for automated revenue share
- Claims pump.fun creator fees → swaps SOL → $CUM → distributes to holders
- PostgreSQL database with migration system
- Runs on Railway

## Key Details
- Reward token ($CUM): `oqU4DdYCbdSf9j74vnEgvCn1YzNfYQEPWaC6pu6pump`
- PumpSwap program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- Token has 6 decimals (pump.fun standard)
- Uses pnpm for package management
- DB column names use `amount_usdc` but store SOL values (legacy naming, don't rename)

## Commands
- `pnpm install` — install deps
- `pnpm run build` — compile TypeScript
- `pnpm run dev` — dev mode with tsx watch

## Code Standards
- TypeScript strict mode
- Use existing logger utility for all logging
- Use existing solana utility for connections and transactions
- Follow existing patterns for DB queries (pool.query with parameterized queries)
- Keep all event logging via logEvent() pattern
