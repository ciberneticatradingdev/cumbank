import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'
import { config } from '@/lib/config'

const inter = Inter({
  subsets: ["latin"],
  variable: '--font-inter'
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: '--font-jetbrains-mono'
})

export const metadata: Metadata = {
  title: `CUMBANK — Deposit Today. Invest in Tomorrow.`,
  description: config.tokenDescription,
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'CUMBANK — Deposit Today. Invest in Tomorrow.',
    description: 'Hold $CUMBANK, earn $CUM tokens automatically. 50% instant + 50% diamond hands. The bank is always open. 🏦',
    images: [{ url: '/og-image.jpg', width: 1200, height: 1200, alt: 'CUMBANK' }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CUMBANK — Deposit Today. Invest in Tomorrow.',
    description: 'Hold $CUMBANK, earn $CUM tokens automatically. 🏦',
    images: ['/og-image.jpg'],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans antialiased bg-black text-white">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
