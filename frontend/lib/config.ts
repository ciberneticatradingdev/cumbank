/**
 * Centralised front-end configuration.
 * Every value is driven by a NEXT_PUBLIC_ environment variable so forks only
 * need to set their .env on Vercel — no code changes required.
 */
export const config = {
  tokenName: process.env.NEXT_PUBLIC_TOKEN_NAME || "$CUMBANK",
  tokenCA: process.env.NEXT_PUBLIC_TOKEN_CA || "Dkwxc3fRESe6hKrvKoJRNRj69CsG3rCSj9cYTLxTpump",
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "https://backend-production-5033.up.railway.app",
  twitterUrl: process.env.NEXT_PUBLIC_TWITTER_URL || "https://x.com/CUMBANK_PF",
  tokenDescription:
    process.env.NEXT_PUBLIC_TOKEN_DESCRIPTION ||
    "Deposit Today. Invest in Tomorrow. Hold $CUMBANK, earn $CUM tokens automatically. 50/50 split: instant + diamond hands. 🏦",
}
