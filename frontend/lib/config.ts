/**
 * Centralised front-end configuration.
 * Every value is driven by a NEXT_PUBLIC_ environment variable so forks only
 * need to set their .env on Vercel — no code changes required.
 */
export const config = {
  tokenName: process.env.NEXT_PUBLIC_TOKEN_NAME || "$CUMBANK",
  tokenCA: process.env.NEXT_PUBLIC_TOKEN_CA || "",
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "https://cumbank-backend.up.railway.app",
  twitterUrl: process.env.NEXT_PUBLIC_TWITTER_URL || "",
  tokenDescription:
    process.env.NEXT_PUBLIC_TOKEN_DESCRIPTION ||
    "Deposit Today. Invest in Tomorrow. Hold $CUMBANK, earn SOL automatically every 90 seconds. 🏦",
}
