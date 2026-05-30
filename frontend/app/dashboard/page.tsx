"use client"

import React, { useState, useEffect, useCallback } from "react"
import {
  Home,
  LayoutDashboard,
  Users,
  History,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  RefreshCw,
  Loader2,
  TrendingUp,
  Gem,
  Repeat,
  BarChart2,
  Diamond,
  Timer,
  Shield,
} from "lucide-react"
import Image from "next/image"
import { config } from "@/lib/config"

// ── Constants ──────────────────────────────────────────────────────────────────

const API_BASE = config.apiUrl
const CONTRACT = config.tokenCA
const SOLSCAN_TX = "https://solscan.io/tx/"
const ITEMS_PER_PAGE = 10

// ── Types (matching the real backend API) ──────────────────────────────────────

interface ApiStats {
  totalDistributed: string
  totalRounds: number
  totalClaims: number
  totalClaimedSol: string
  currentHolders: number
  qualifiedHolders: number
  lastClaimAt: string | null
  lastDistributionAt: string | null
  avgPerRound: string
  tokenMint: string
}

interface ApiHolder {
  wallet: string
  balance: number
  percentage: number
}

interface ApiHoldersResponse {
  holders: ApiHolder[]
  snapshot: {
    id: number
    createdAt: string
    holderCount: number
    totalSupply: string | number
  } | null
}

interface ApiDistribution {
  id: number
  claimRoundId: number | null
  snapshotId: number | null
  totalAmountSol: string
  holderCount: number
  status: string
  createdAt: string
  completedAt: string | null
}

interface ApiPayment {
  id: number
  wallet: string
  amountSol: string
  tokenBalance: string | number
  percentage: string | number
  txSignature: string | null
  status: string
  errorMessage: string | null
  sentAt: string | null
}

interface ApiDistributionDetail {
  distribution: ApiDistribution
  payments: ApiPayment[]
}

interface ApiDiamondDistribution {
  id: number
  snapshotId: number | null
  totalAmountTokens: string
  holderCount: number
  status: string
  createdAt: string
  completedAt: string | null
}

interface ApiDiamondPayment {
  wallet: string
  amountTokens: string
  tokenBalance: string | number
  percentage: string | number
  txSignature: string | null
  status: string
  errorMessage: string | null
  sentAt: string | null
}

interface ApiDiamondData {
  accumulated: string
  totalDistributed: string
  totalRounds: number
  lastDistributionAt: string | null
  nextDistributionIn: number
  qualifiedHolders: number
  totalHolders: number
  recentDistributions: ApiDiamondDistribution[]
}

interface DistPagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const truncate = (w: string) =>
  w && w.length >= 8 ? `${w.slice(0, 4)}...${w.slice(-4)}` : w ?? "—"

/** Amounts from the API are decimal strings — format them. */
const fmtSol = (s: string | number | undefined | null) => {
  const n = typeof s === "string" ? parseFloat(s) : (s ?? 0)
  if (isNaN(n)) return "0.0000"
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 })
}

const fmtNum = (n: number | undefined | null) =>
  (n ?? 0).toLocaleString("en-US")

const fmtDate = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—"

const distStatusBadge = (status: string) => {
  const s = status?.toLowerCase()
  if (s === "completed") return { cls: "bg-green-900/30 text-green-400 border border-green-500/20", label: "DONE" }
  if (s === "pending")   return { cls: "bg-yellow-900/20 text-yellow-400 border border-yellow-500/20", label: "PENDING" }
  if (s === "processing")return { cls: "bg-yellow-900/20 text-yellow-400 border border-yellow-500/20", label: "PROCESSING" }
  return { cls: "bg-red-900/20 text-red-400 border border-red-500/20", label: status?.toUpperCase() ?? "—" }
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function Sk({ className = "" }: { className?: string }) {
  return <div className={`bg-white/10 animate-pulse rounded ${className}`} />
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function DashboardPage() {
  type Tab = "dashboard" | "holders" | "history"
  const [tab, setTab] = useState<Tab>("dashboard")

  // Data
  const [stats, setStats]               = useState<ApiStats | null>(null)
  const [holdersData, setHoldersData]   = useState<ApiHoldersResponse | null>(null)
  const [distributions, setDistributions] = useState<ApiDistribution[]>([])
  const [distPagination, setDistPagination] = useState<DistPagination>({
    page: 1, limit: ITEMS_PER_PAGE, total: 0, totalPages: 0,
  })
  const [distributionDetails, setDistributionDetails] = useState<
    Record<number, ApiDistributionDetail | null>
  >({})
  const [diamondData, setDiamondData] = useState<ApiDiamondData | null>(null)
  const [diamondCountdown, setDiamondCountdown] = useState<number>(0)

  // History filter + diamond distributions for history tab
  type HistoryFilter = "all" | "instant" | "diamond"
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all")
  const [diamondDistributions, setDiamondDistributions] = useState<ApiDiamondDistribution[]>([])
  const [diamondDistDetails, setDiamondDistDetails] = useState<Record<string, { distribution: ApiDiamondDistribution; payments: ApiDiamondPayment[] } | null>>({})

  // UI
  const [loading, setLoading]               = useState(true)
  const [loadingDist, setLoadingDist]       = useState(false)
  const [refreshing, setRefreshing]         = useState(false)
  const [expandedDist, setExpandedDist]     = useState<number | null>(null)
  const [loadingDetail, setLoadingDetail]   = useState<number | null>(null)
  const [copiedWallet, setCopiedWallet]     = useState<string | null>(null)
  const [currentPage, setCurrentPage]       = useState(1)

  // ── Fetch ────────────────────────────────────────────────────────────────────

  const fetchCoreData = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    else setLoading(true)
    try {
      const res  = await fetch(`${API_BASE}/api/stats`)
      const json = await res.json()
      setStats(json)
    } catch (err) {
      console.error("fetchCoreData:", err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  const fetchHolders = useCallback(async () => {
    try {
      const res  = await fetch(`${API_BASE}/api/holders`)
      const json = await res.json()
      setHoldersData(json)
    } catch (err) {
      console.error("fetchHolders:", err)
    }
  }, [])

  const fetchDistributions = useCallback(async (page: number) => {
    setLoadingDist(true)
    try {
      const res  = await fetch(`${API_BASE}/api/distributions?limit=${ITEMS_PER_PAGE}&page=${page}`)
      const json = await res.json()
      setDistributions(json.distributions ?? [])
      if (json.pagination) setDistPagination(json.pagination)
    } catch (err) {
      console.error("fetchDistributions:", err)
    } finally {
      setLoadingDist(false)
    }
  }, [])

  const fetchDistributionDetail = useCallback(
    async (id: number) => {
      if (id in distributionDetails) return
      setLoadingDetail(id)
      try {
        const res  = await fetch(`${API_BASE}/api/distributions/${id}`)
        const json = await res.json()
        setDistributionDetails((prev) => ({ ...prev, [id]: json }))
      } catch (err) {
        console.error("fetchDistributionDetail:", err)
        setDistributionDetails((prev) => ({ ...prev, [id]: null }))
      } finally {
        setLoadingDetail(null)
      }
    },
    [distributionDetails]
  )

  const fetchDiamond = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/diamond`)
      const json = await res.json()
      setDiamondData(json)
      setDiamondCountdown(json.nextDistributionIn ?? 0)
    } catch (err) {
      console.error("fetchDiamond:", err)
    }
  }, [])

  const fetchDiamondDistributions = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/diamond/distributions?limit=50`)
      const json = await res.json()
      setDiamondDistributions(json.distributions ?? [])
    } catch (err) {
      console.error("fetchDiamondDist:", err)
    }
  }, [])

  const fetchDiamondDistDetail = useCallback(
    async (id: number) => {
      const key = `diamond-${id}`
      if (key in diamondDistDetails) return
      setLoadingDetail(id)
      try {
        const res = await fetch(`${API_BASE}/api/diamond/distributions/${id}`)
        const json = await res.json()
        setDiamondDistDetails((prev) => ({ ...prev, [key]: json }))
      } catch (err) {
        console.error("fetchDiamondDistDetail:", err)
        setDiamondDistDetails((prev) => ({ ...prev, [key]: null }))
      } finally {
        setLoadingDetail(null)
      }
    },
    [diamondDistDetails]
  )

  // ── Effects ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchCoreData()
    fetchHolders()
    fetchDistributions(1)
    fetchDiamond()
    fetchDiamondDistributions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-refresh stats + holders every 30 s
  useEffect(() => {
    const id = setInterval(() => {
      fetchCoreData(true)
      fetchHolders()
      fetchDiamond()
      fetchDiamondDistributions()
    }, 30_000)
    return () => clearInterval(id)
  }, [fetchCoreData, fetchHolders, fetchDiamond, fetchDiamondDistributions])

  // Diamond countdown timer — tick every second
  useEffect(() => {
    const id = setInterval(() => {
      setDiamondCountdown((prev) => Math.max(0, prev - 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Re-fetch distributions when page changes (only in history tab)
  useEffect(() => {
    if (tab === "history") fetchDistributions(currentPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, tab])

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleExpand = (id: number) => {
    if (expandedDist === id) {
      setExpandedDist(null)
    } else {
      setExpandedDist(id)
      fetchDistributionDetail(id)
    }
  }

  const handleExpandDiamond = (id: number) => {
    const key = id + 100000 // offset to avoid collision with instant dist ids
    if (expandedDist === key) {
      setExpandedDist(null)
    } else {
      setExpandedDist(key)
      fetchDiamondDistDetail(id)
    }
  }

  const copyWallet = (wallet: string) => {
    navigator.clipboard.writeText(wallet)
    setCopiedWallet(wallet)
    setTimeout(() => setCopiedWallet(null), 2000)
  }

  // ── Derived ───────────────────────────────────────────────────────────────────

  const { totalPages, total: totalDist } = distPagination

  const pageNumbers = (() => {
    if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1)
    const half  = 2
    let   start = Math.max(1, currentPage - half)
    const end   = Math.min(totalPages, start + 4)
    start        = Math.max(1, end - 4)
    return Array.from({ length: end - start + 1 }, (_, i) => start + i)
  })()

  // Merged history list for the "all" filter
  interface MergedDistribution {
    type: "instant" | "diamond"
    id: number
    date: string
    amount: string
    holderCount: number
    status: string
    expandKey: number // unique key for expand state
    claimRoundId?: number | null
    completedAt?: string | null
  }

  const mergedDistributions: MergedDistribution[] = (() => {
    const instantItems: MergedDistribution[] = distributions.map((d) => ({
      type: "instant" as const,
      id: d.id,
      date: d.createdAt,
      amount: d.totalAmountSol,
      holderCount: d.holderCount,
      status: d.status,
      expandKey: d.id,
      claimRoundId: d.claimRoundId,
      completedAt: d.completedAt,
    }))
    const diamondItems: MergedDistribution[] = diamondDistributions.map((d) => ({
      type: "diamond" as const,
      id: d.id,
      date: d.createdAt,
      amount: d.totalAmountTokens,
      holderCount: d.holderCount,
      status: d.status,
      expandKey: d.id + 100000,
      completedAt: d.completedAt,
    }))

    if (historyFilter === "instant") return instantItems
    if (historyFilter === "diamond") return diamondItems
    return [...instantItems, ...diamondItems].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    )
  })()

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-black">

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <header className="border-b border-white/10 bg-black sticky top-0 z-50 ">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <nav className="hidden sm:flex items-center gap-1">
            <a
              href="/"
              className="flex items-center gap-1.5 px-3 py-1.5 text-white/50 font-bold text-sm hover:text-white hover:bg-[#0A0A0A]/60 rounded-lg transition-colors"
            >
              <Home className="w-4 h-4" />
              HOME
            </a>
            <a
              href="/dashboard"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-white font-bold text-sm rounded-lg hover:bg-white/90 transition-colors"
            >
              <LayoutDashboard className="w-4 h-4" />
              DASHBOARD
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { fetchCoreData(true); fetchHolders() }}
              className="flex items-center gap-1.5 px-2 py-2 text-white/40 hover:text-white hover:bg-[#0A0A0A]/60 rounded-lg transition-colors"
              title="Refresh data"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            <a
              href={`https://pump.fun/coin/${config.tokenCA}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-9 h-9 bg-[#0A0A0A]/60 hover:bg-[#0A0A0A] rounded-lg transition-colors"
              aria-label="Buy on Pump.fun"
            >
              <Image src="/pumpfun-icon.png" alt="Pump.fun" width={20} height={20} />
            </a>
            {config.twitterUrl && (
              <a
                href={config.twitterUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center w-9 h-9 bg-[#0A0A0A]/60 text-white/50 hover:bg-[#0A0A0A] hover:text-white rounded-lg transition-colors"
                aria-label={`Follow ${config.tokenName} on X`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              </a>
            )}
          </div>
        </div>
      </header>

      {/* ── Tab Bar ───────────────────────────────────────────────────────────── */}
      <div className="bg-[#0A0A0A] border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 flex items-center gap-1 py-2">
          {(
            [
              { id: "dashboard", Icon: LayoutDashboard, label: "DASHBOARD" },
              { id: "holders",   Icon: Users,            label: "HOLDERS"   },
              { id: "history",   Icon: History,          label: "HISTORY"   },
            ] as const
          ).map(({ id, Icon, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-4 py-2 font-black text-sm rounded-lg transition-colors ${
                tab === id
                  ? "bg-white/10 text-white  border border-white/20"
                  : "text-white/50 hover:text-white hover:bg-[#0A0A0A]"
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
          {/* Live indicator */}
          <div className="ml-auto flex items-center gap-2 pr-1">
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-xs font-bold text-emerald-400 hidden sm:inline">LIVE · AUTO-REFRESH 30s</span>
          </div>
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-4 py-6">

        {/* ═══════════════════════════════════════════════════════════════════════
            TAB 1 — DASHBOARD
        ═══════════════════════════════════════════════════════════════════════ */}
        {tab === "dashboard" && (
          <div className="space-y-4">

            {/* Stat cards — 2×2 → 4-col */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">

              {/* Total Claimed */}
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-4 ">
                <div className="flex items-center gap-2 mb-3">
                  <Gem className="w-4 h-4 text-white/30" />
                  <p className="text-xs font-bold text-white/30">TOTAL CLAIMED</p>
                </div>
                {loading ? (
                  <Sk className="h-9 w-3/4 mb-1" />
                ) : (
                  <p className="text-2xl font-black text-white leading-none">
                    {fmtSol(stats?.totalClaimedSol)}
                  </p>
                )}
                <p className="text-xs text-white/40 mt-1">SOL</p>
              </div>

              {/* Total Distributed */}
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-4 ">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="w-4 h-4 text-white/30" />
                  <p className="text-xs font-bold text-white/30">TOTAL DISTRIBUTED</p>
                </div>
                {loading ? (
                  <Sk className="h-9 w-3/4 mb-1" />
                ) : (
                  <p className="text-2xl font-black text-white leading-none">
                    {fmtSol(stats?.totalDistributed)}
                  </p>
                )}
                <p className="text-xs text-white/40 mt-1">$CUM</p>
              </div>

              {/* Total Rounds */}
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-4 ">
                <div className="flex items-center gap-2 mb-3">
                  <Repeat className="w-4 h-4 text-white/40" />
                  <p className="text-xs font-bold text-white/40">TOTAL ROUNDS</p>
                </div>
                {loading ? (
                  <Sk className="h-9 w-1/2 mb-1" />
                ) : (
                  <p className="text-2xl font-black text-white leading-none">
                    {fmtNum(stats?.totalRounds)}
                  </p>
                )}
                <p className="text-xs text-white/40 mt-1">COMPLETED</p>
              </div>

              {/* Avg Per Round */}
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-4 ">
                <div className="flex items-center gap-2 mb-3">
                  <BarChart2 className="w-4 h-4 text-white/30" />
                  <p className="text-xs font-bold text-white/30">AVG PER ROUND</p>
                </div>
                {loading ? (
                  <Sk className="h-9 w-3/4 mb-1" />
                ) : (
                  <p className="text-2xl font-black text-white leading-none">
                    {fmtSol(stats?.avgPerRound)}
                  </p>
                )}
                <p className="text-xs text-white/40 mt-1">$CUM / ROUND</p>
              </div>
            </div>

            {/* Status panel + Last activity */}
            <div className="grid md:grid-cols-2 gap-4">

              {/* Distribution Status */}
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-6 ">
                <p className="text-xs font-bold text-white/30 mb-4 uppercase tracking-wide">DISTRIBUTION STATUS</p>
                <div className="flex items-center gap-3 mb-5">
                  <span className="w-3 h-3 bg-green-500 rounded-full animate-pulse flex-shrink-0" />
                  <span className="font-black text-lg text-white leading-tight">
                    ACTIVE — AUTO-DISTRIBUTING
                  </span>
                </div>
                <div className="space-y-3 mb-4">
                  <div>
                    <p className="text-xs font-bold text-white/40 mb-1">LAST DISTRIBUTION</p>
                    <p className="font-mono text-sm font-bold text-white">
                      {loading ? "—" : fmtDate(stats?.lastDistributionAt)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-white/40 mb-1">LAST CLAIM</p>
                    <p className="font-mono text-sm font-bold text-white">
                      {loading ? "—" : fmtDate(stats?.lastClaimAt)}
                    </p>
                  </div>
                </div>
                <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-2">
                  <p className="text-xs font-bold text-white/40 mb-0.5">TOKEN MINT</p>
                  <p className="font-mono text-xs text-white break-all">{CONTRACT}</p>
                </div>
              </div>

              {/* Stats summary */}
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-6 ">
                <p className="text-xs font-bold text-white/30 mb-4 uppercase tracking-wide">HOLDER STATS</p>
                {loading ? (
                  <div className="space-y-3">
                    <Sk className="h-6 w-2/3" />
                    <Sk className="h-6 w-1/2" />
                    <Sk className="h-6 w-2/3" />
                    <Sk className="h-6 w-1/3" />
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b border-white/10 pb-3">
                      <span className="text-xs text-white/40 font-bold">CURRENT HOLDERS</span>
                      <span className="font-black text-white text-xl">
                        {fmtNum(stats?.currentHolders)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between border-b border-white/10 pb-3">
                      <span className="text-xs text-white/40 font-bold">QUALIFIED HOLDERS</span>
                      <span className="font-black text-white/40 text-xl">
                        {fmtNum(stats?.qualifiedHolders)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between border-b border-white/10 pb-3">
                      <span className="text-xs text-white/40 font-bold">TOTAL CLAIMS</span>
                      <span className="font-black text-white text-xl">
                        {fmtNum(stats?.totalClaims)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/40 font-bold">TOTAL ROUNDS</span>
                      <span className="font-black text-white text-xl">
                        {fmtNum(stats?.totalRounds)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 💎 Diamond Hands Vault */}
            <div className="bg-[#0A0A0A] rounded-xl border border-white/10 overflow-hidden">
              <div className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
                <Diamond className="w-4 h-4 text-cyan-400" />
                <h3 className="font-black text-white text-sm">💎 DIAMOND HANDS VAULT</h3>
                <span className="ml-auto text-xs font-bold text-white/30">1H CYCLE</span>
              </div>

              <div className="p-4 space-y-4">
                {/* Top stats row */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Accumulated */}
                  <div className="bg-black rounded-lg border border-white/10 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Shield className="w-3.5 h-3.5 text-cyan-400/50" />
                      <p className="text-xs font-bold text-white/30">ACCUMULATED</p>
                    </div>
                    {!diamondData ? (
                      <Sk className="h-8 w-3/4" />
                    ) : (
                      <p className="text-2xl font-black text-cyan-400 leading-none">
                        {fmtSol(diamondData.accumulated)}
                      </p>
                    )}
                    <p className="text-xs text-white/40 mt-1">$CUM PENDING</p>
                  </div>

                  {/* Countdown */}
                  <div className="bg-black rounded-lg border border-white/10 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Timer className="w-3.5 h-3.5 text-white/30" />
                      <p className="text-xs font-bold text-white/30">NEXT DROP</p>
                    </div>
                    {!diamondData ? (
                      <Sk className="h-8 w-3/4" />
                    ) : (
                      <p className="text-2xl font-black text-white leading-none font-mono">
                        {(() => {
                          const totalSec = Math.floor(diamondCountdown / 1000)
                          const m = Math.floor(totalSec / 60)
                          const s = totalSec % 60
                          return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
                        })()}
                      </p>
                    )}
                    <p className="text-xs text-white/40 mt-1">MIN:SEC</p>
                  </div>

                  {/* Diamond Holders */}
                  <div className="bg-black rounded-lg border border-white/10 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Diamond className="w-3.5 h-3.5 text-cyan-400/50" />
                      <p className="text-xs font-bold text-white/30">💎 HOLDERS</p>
                    </div>
                    {!diamondData ? (
                      <Sk className="h-8 w-1/2" />
                    ) : (
                      <p className="text-2xl font-black text-white leading-none">
                        {fmtNum(diamondData.qualifiedHolders)}
                        <span className="text-sm font-bold text-white/30 ml-1">/ {fmtNum(diamondData.totalHolders)}</span>
                      </p>
                    )}
                    <p className="text-xs text-white/40 mt-1">QUALIFIED / TOTAL</p>
                  </div>

                  {/* Total Distributed */}
                  <div className="bg-black rounded-lg border border-white/10 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <TrendingUp className="w-3.5 h-3.5 text-white/30" />
                      <p className="text-xs font-bold text-white/30">TOTAL 💎 DISTRIBUTED</p>
                    </div>
                    {!diamondData ? (
                      <Sk className="h-8 w-3/4" />
                    ) : (
                      <p className="text-2xl font-black text-white leading-none">
                        {fmtSol(diamondData.totalDistributed)}
                      </p>
                    )}
                    <p className="text-xs text-white/40 mt-1">$CUM · {diamondData ? fmtNum(diamondData.totalRounds) : "—"} ROUNDS</p>
                  </div>
                </div>

                {/* Progress bar — % of holders qualifying */}
                {diamondData && diamondData.totalHolders > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-bold text-white/40">DIAMOND HAND RATE</span>
                      <span className="text-xs font-black text-cyan-400">
                        {((diamondData.qualifiedHolders / diamondData.totalHolders) * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-cyan-500 to-cyan-300 rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(100, (diamondData.qualifiedHolders / diamondData.totalHolders) * 100)}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Recent Diamond Distributions table */}
                {diamondData && diamondData.recentDistributions.length > 0 && (
                  <div>
                    <p className="text-xs font-bold text-white/30 mb-2 uppercase tracking-wide">RECENT 💎 DISTRIBUTIONS</p>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[500px]">
                        <thead>
                          <tr className="border-b border-white/10">
                            {["ID", "DATE", "AMOUNT", "💎 HOLDERS", "STATUS"].map((h, i) => (
                              <th
                                key={h}
                                className={`text-xs font-bold text-white/40 px-3 py-2 ${
                                  i >= 2 ? "text-right" : "text-left"
                                } ${i === 4 ? "text-center" : ""}`}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {diamondData.recentDistributions.map((d) => {
                            const badge = distStatusBadge(d.status)
                            return (
                              <tr key={d.id} className="border-b border-white/5 hover:bg-black/50 transition-colors">
                                <td className="px-3 py-2.5 font-mono text-sm text-white font-bold">#{d.id}</td>
                                <td className="px-3 py-2.5 text-xs text-white/40">{fmtDate(d.createdAt)}</td>
                                <td className="px-3 py-2.5 text-right font-mono text-sm text-cyan-400">
                                  {fmtSol(d.totalAmountTokens)}
                                </td>
                                <td className="px-3 py-2.5 text-right font-mono text-sm text-white/40">
                                  {d.holderCount}
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  <span className={`text-xs font-black px-2 py-0.5 rounded ${badge.cls}`}>
                                    {badge.label}
                                  </span>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Recent Distributions preview */}
            <div className="bg-[#0A0A0A] rounded-xl border border-white/10 overflow-hidden ">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h3 className="font-black text-white text-sm">RECENT DISTRIBUTIONS</h3>
                <button
                  onClick={() => setTab("history")}
                  className="text-xs font-bold text-white/40 hover:text-white transition-colors"
                >
                  VIEW ALL →
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[500px]">
                  <thead>
                    <tr className="border-b border-white/10 bg-[#0A0A0A]">
                      {["ID", "DATE", "DISTRIBUTED", "HOLDERS", "STATUS"].map((h, i) => (
                        <th
                          key={h}
                          className={`text-xs font-bold text-white/40 px-4 py-2.5 ${
                            i >= 2 ? "text-right" : "text-left"
                          } ${i === 4 ? "text-center" : ""}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {loading || loadingDist
                      ? Array.from({ length: 5 }).map((_, i) => (
                          <tr key={i} className="border-b border-white/5">
                            <td className="px-4 py-3"><Sk className="h-4 w-10" /></td>
                            <td className="px-4 py-3"><Sk className="h-4 w-32" /></td>
                            <td className="px-4 py-3"><Sk className="h-4 w-20 ml-auto" /></td>
                            <td className="px-4 py-3"><Sk className="h-4 w-12 ml-auto" /></td>
                            <td className="px-4 py-3"><Sk className="h-4 w-14 mx-auto" /></td>
                          </tr>
                        ))
                      : distributions.slice(0, 5).map((d) => {
                          const badge = distStatusBadge(d.status)
                          return (
                            <tr
                              key={d.id}
                              className="border-b border-white/5 hover:bg-[#0A0A0A] transition-colors"
                            >
                              <td className="px-4 py-3 font-mono text-sm text-white font-bold">
                                #{d.id}
                              </td>
                              <td className="px-4 py-3 text-xs text-white/40">
                                {fmtDate(d.createdAt)}
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-sm text-white">
                                ${fmtSol(d.totalAmountSol)}
                              </td>
                              <td className="px-4 py-3 text-right font-mono text-sm text-white/40">
                                {d.holderCount}
                              </td>
                              <td className="px-4 py-3 text-center">
                                <span className={`text-xs font-black px-2 py-0.5 rounded ${badge.cls}`}>
                                  {badge.label}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════
            TAB 2 — HOLDERS
        ═══════════════════════════════════════════════════════════════════════ */}
        {tab === "holders" && (
          <div className="space-y-4">

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-4 ">
                <p className="text-xs font-bold text-white/40 mb-2">TOTAL HOLDERS</p>
                {loading ? (
                  <Sk className="h-9 w-1/2" />
                ) : (
                  <p className="text-3xl font-black text-white">
                    {fmtNum(stats?.currentHolders ?? holdersData?.snapshot?.holderCount)}
                  </p>
                )}
              </div>
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-4 ">
                <p className="text-xs font-bold text-white/30 mb-2">QUALIFIED</p>
                {loading ? (
                  <Sk className="h-9 w-1/2" />
                ) : (
                  <p className="text-3xl font-black text-white">
                    {fmtNum(stats?.qualifiedHolders)}
                  </p>
                )}
              </div>
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-4 ">
                <p className="text-xs font-bold text-white/40 mb-2">TOTAL CLAIMS</p>
                {loading ? (
                  <Sk className="h-9 w-1/2" />
                ) : (
                  <p className="text-3xl font-black text-white">
                    {fmtNum(stats?.totalClaims)}
                  </p>
                )}
              </div>
              <div className="bg-[#0A0A0A] rounded-xl border border-white/10 p-4 ">
                <p className="text-xs font-bold text-white/30 mb-2">TOTAL SUPPLY</p>
                {!holdersData ? (
                  <Sk className="h-9 w-1/2" />
                ) : (
                  <p className="text-3xl font-black text-white">
                    {holdersData.snapshot
                      ? fmtNum(Number(holdersData.snapshot.totalSupply))
                      : "—"}
                  </p>
                )}
              </div>
            </div>

            {/* Holders table */}
            <div className="bg-[#0A0A0A] rounded-xl border border-white/10 overflow-hidden ">
              <div className="px-4 py-3 border-b border-white/10">
                <h3 className="font-black text-white text-sm">HOLDER LEADERBOARD</h3>
                <p className="text-xs text-white/40 mt-0.5">
                  Click a wallet address to copy · Snapshot updated periodically
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px]">
                  <thead>
                    <tr className="border-b border-white/10 bg-[#0A0A0A]">
                      <th className="text-left text-xs font-bold text-white/40 px-4 py-3">RANK</th>
                      <th className="text-left text-xs font-bold text-white/40 px-4 py-3">WALLET</th>
                      <th className="text-right text-xs font-bold text-white/40 px-4 py-3">BALANCE</th>
                      <th className="text-right text-xs font-bold text-white/40 px-4 py-3">SHARE %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!holdersData
                      ? Array.from({ length: 10 }).map((_, i) => (
                          <tr key={i} className="border-b border-white/5">
                            <td className="px-4 py-3"><Sk className="h-4 w-8" /></td>
                            <td className="px-4 py-3"><Sk className="h-4 w-28" /></td>
                            <td className="px-4 py-3"><Sk className="h-4 w-24 ml-auto" /></td>
                            <td className="px-4 py-3"><Sk className="h-4 w-14 ml-auto" /></td>
                          </tr>
                        ))
                      : holdersData.holders.length === 0
                      ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-8 text-center text-white/40 text-sm font-bold">
                            No holder snapshot available yet — check back soon.
                          </td>
                        </tr>
                      )
                      : holdersData.holders.map((h, i) => (
                          <tr
                            key={h.wallet}
                            className="border-b border-white/5 hover:bg-[#0A0A0A] transition-colors group"
                          >
                            <td className="px-4 py-3 font-mono text-sm text-white/40 font-bold">
                              {i + 1}
                            </td>
                            <td className="px-4 py-3">
                              <button
                                onClick={() => copyWallet(h.wallet)}
                                className="flex items-center gap-2 font-mono text-sm text-white hover:text-white/40 transition-colors"
                              >
                                {truncate(h.wallet)}
                                {copiedWallet === h.wallet ? (
                                  <Check className="w-3 h-3 text-emerald-500" />
                                ) : (
                                  <Copy className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />
                                )}
                              </button>
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-sm text-white">
                              {fmtNum(h.balance)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <div className="hidden sm:block w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-white rounded-full"
                                    style={{ width: `${Math.min(100, Number(h.percentage))}%` }}
                                  />
                                </div>
                                <span className="font-mono text-sm text-white/40 font-bold">
                                  {Number(h.percentage).toFixed(2)}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════
            TAB 3 — HISTORY
        ═══════════════════════════════════════════════════════════════════════ */}
        {tab === "history" && (
          <div className="space-y-4">
            <div className="bg-[#0A0A0A] rounded-xl border border-white/10 overflow-hidden ">
              <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
                <div>
                  <h3 className="font-black text-white text-sm">DISTRIBUTION HISTORY</h3>
                  <p className="text-xs text-white/40 mt-0.5">
                    Click a row to expand per-holder payments
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {(["all", "instant", "diamond"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setHistoryFilter(f)}
                      className={`px-3 py-1.5 text-xs font-black rounded-lg transition-colors border ${
                        historyFilter === f
                          ? "bg-white/10 text-white border-white/20"
                          : "text-white/40 border-transparent hover:text-white hover:bg-white/5"
                      }`}
                    >
                      {f === "all" ? "ALL" : f === "instant" ? "⚡ INSTANT" : "💎 DIAMOND"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr className="border-b border-white/10 bg-[#0A0A0A]">
                      <th className="w-10 px-3 py-3" />
                      <th className="text-left text-xs font-bold text-white/40 px-3 py-3">TYPE</th>
                      <th className="text-left text-xs font-bold text-white/40 px-4 py-3">ID</th>
                      <th className="text-left text-xs font-bold text-white/40 px-4 py-3">DATE</th>
                      <th className="text-right text-xs font-bold text-white/40 px-4 py-3">DISTRIBUTED</th>
                      <th className="text-right text-xs font-bold text-white/40 px-4 py-3">HOLDERS</th>
                      <th className="text-center text-xs font-bold text-white/40 px-4 py-3">STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingDist
                      ? Array.from({ length: ITEMS_PER_PAGE }).map((_, i) => (
                          <tr key={i} className="border-b border-white/5">
                            {Array.from({ length: 7 }).map((_, j) => (
                              <td key={j} className="px-4 py-3">
                                <Sk className="h-4 w-full" />
                              </td>
                            ))}
                          </tr>
                        ))
                      : mergedDistributions.map((item) => {
                          const badge = distStatusBadge(item.status)
                          const isExpanded = expandedDist === item.expandKey
                          const isDiamond = item.type === "diamond"
                          const diamondKey = `diamond-${item.id}`
                          return (
                            <React.Fragment key={`${item.type}-${item.id}`}>
                              {/* Main row */}
                              <tr
                                className="border-b border-white/5 hover:bg-[#0A0A0A] transition-colors cursor-pointer select-none"
                                onClick={() =>
                                  isDiamond ? handleExpandDiamond(item.id) : handleExpand(item.id)
                                }
                              >
                                <td className="px-3 py-3 text-center">
                                  {isExpanded ? (
                                    <ChevronUp className="w-4 h-4 text-white/40 mx-auto" />
                                  ) : (
                                    <ChevronDown className="w-4 h-4 text-white/40 mx-auto" />
                                  )}
                                </td>
                                <td className="px-3 py-3">
                                  {isDiamond ? (
                                    <span className="text-xs font-black px-2 py-0.5 rounded bg-cyan-900/30 text-cyan-400 border border-cyan-500/20">
                                      💎
                                    </span>
                                  ) : (
                                    <span className="text-xs font-black px-2 py-0.5 rounded bg-white/10 text-white/60 border border-white/10">
                                      ⚡
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-3 font-mono text-sm text-white font-bold">
                                  #{item.id}
                                </td>
                                <td className="px-4 py-3 text-xs text-white/40">
                                  {fmtDate(item.date)}
                                </td>
                                <td className={`px-4 py-3 text-right font-mono text-sm ${isDiamond ? "text-cyan-400" : "text-white"}`}>
                                  {fmtSol(item.amount)} {isDiamond ? "$CUM" : "$CUM"}
                                </td>
                                <td className="px-4 py-3 text-right font-mono text-sm text-white/40">
                                  {item.holderCount}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  <span className={`text-xs font-black px-2 py-0.5 rounded ${badge.cls}`}>
                                    {badge.label}
                                  </span>
                                </td>
                              </tr>

                              {/* Expanded payments row — INSTANT */}
                              {isExpanded && !isDiamond && (() => {
                                const detail = distributionDetails[item.id]
                                return (
                                  <tr key={`instant-${item.id}-detail`} className="border-b border-white/10">
                                    <td colSpan={7} className="bg-[#0A0A0A] px-4 py-4">
                                      {loadingDetail === item.id ? (
                                        <div className="flex items-center gap-2 text-white/40 text-sm py-2">
                                          <Loader2 className="w-4 h-4 animate-spin" />
                                          Loading payments...
                                        </div>
                                      ) : detail === null ? (
                                        <p className="text-xs text-red-400">
                                          Failed to load distribution details.
                                        </p>
                                      ) : detail ? (
                                        <div>
                                          <div className="flex flex-wrap items-center gap-4 mb-3 pb-3 border-b border-white/10">
                                            {item.claimRoundId && (
                                              <span className="text-xs font-bold text-white/40">
                                                ROUND <span className="text-white">#{item.claimRoundId}</span>
                                              </span>
                                            )}
                                            {item.completedAt && (
                                              <span className="text-xs font-bold text-white/40">
                                                COMPLETED <span className="text-white">{fmtDate(item.completedAt)}</span>
                                              </span>
                                            )}
                                          </div>
                                          {detail.payments.length === 0 ? (
                                            <p className="text-xs text-white/40">
                                              No payments recorded for this distribution.
                                            </p>
                                          ) : (
                                            <div className="overflow-x-auto">
                                              <table className="w-full min-w-[520px]">
                                                <thead>
                                                  <tr className="border-b border-white/10">
                                                    <th className="text-left text-xs font-bold text-white/40 pb-2 pr-4">WALLET</th>
                                                    <th className="text-right text-xs font-bold text-white/40 pb-2 px-4">AMOUNT ($CUM)</th>
                                                    <th className="text-right text-xs font-bold text-white/40 pb-2 px-4">SHARE %</th>
                                                    <th className="text-center text-xs font-bold text-white/40 pb-2 px-4">STATUS</th>
                                                    <th className="text-right text-xs font-bold text-white/40 pb-2 pl-4">TX</th>
                                                  </tr>
                                                </thead>
                                                <tbody>
                                                  {detail.payments.map((p: ApiPayment, idx: number) => {
                                                    const pBadge = distStatusBadge(p.status)
                                                    return (
                                                      <tr key={idx} className="border-b border-white/5">
                                                        <td className="py-2 pr-4">
                                                          <button
                                                            onClick={(e) => { e.stopPropagation(); copyWallet(p.wallet) }}
                                                            className="flex items-center gap-1.5 font-mono text-xs text-white hover:text-white/40 transition-colors"
                                                          >
                                                            {truncate(p.wallet)}
                                                            {copiedWallet === p.wallet ? (
                                                              <Check className="w-3 h-3 text-emerald-500" />
                                                            ) : (
                                                              <Copy className="w-3 h-3 opacity-40" />
                                                            )}
                                                          </button>
                                                        </td>
                                                        <td className="py-2 px-4 text-right font-mono text-xs text-white">
                                                          {fmtSol(p.amountSol)}
                                                        </td>
                                                        <td className="py-2 px-4 text-right font-mono text-xs text-white/40">
                                                          {Number(p.percentage).toFixed(4)}%
                                                        </td>
                                                        <td className="py-2 px-4 text-center">
                                                          <span className={`text-xs font-black px-1.5 py-0.5 rounded ${pBadge.cls}`}>
                                                            {pBadge.label}
                                                          </span>
                                                        </td>
                                                        <td className="py-2 pl-4 text-right">
                                                          {p.txSignature ? (
                                                            <a
                                                              href={`${SOLSCAN_TX}${p.txSignature}`}
                                                              target="_blank"
                                                              rel="noopener noreferrer"
                                                              onClick={(e) => e.stopPropagation()}
                                                              className="inline-flex items-center gap-1 text-xs font-mono text-white/40 hover:text-white transition-colors"
                                                            >
                                                              {truncate(p.txSignature)}
                                                              <ExternalLink className="w-3 h-3" />
                                                            </a>
                                                          ) : (
                                                            <span className="text-xs text-white/40">—</span>
                                                          )}
                                                        </td>
                                                      </tr>
                                                    )
                                                  })}
                                                </tbody>
                                              </table>
                                            </div>
                                          )}
                                        </div>
                                      ) : null}
                                    </td>
                                  </tr>
                                )
                              })()}

                              {/* Expanded payments row — DIAMOND */}
                              {isExpanded && isDiamond && (() => {
                                const detail = diamondDistDetails[diamondKey]
                                return (
                                  <tr key={`diamond-${item.id}-detail`} className="border-b border-white/10">
                                    <td colSpan={7} className="bg-[#0A0A0A] px-4 py-4">
                                      {loadingDetail === item.id ? (
                                        <div className="flex items-center gap-2 text-white/40 text-sm py-2">
                                          <Loader2 className="w-4 h-4 animate-spin" />
                                          Loading payments...
                                        </div>
                                      ) : detail === null ? (
                                        <p className="text-xs text-red-400">
                                          Failed to load distribution details.
                                        </p>
                                      ) : detail ? (
                                        <div>
                                          <div className="flex flex-wrap items-center gap-4 mb-3 pb-3 border-b border-white/10">
                                            <span className="text-xs font-black px-2 py-0.5 rounded bg-cyan-900/30 text-cyan-400 border border-cyan-500/20">
                                              💎 DIAMOND HANDS
                                            </span>
                                            {item.completedAt && (
                                              <span className="text-xs font-bold text-white/40">
                                                COMPLETED <span className="text-white">{fmtDate(item.completedAt)}</span>
                                              </span>
                                            )}
                                          </div>
                                          {detail.payments.length === 0 ? (
                                            <p className="text-xs text-white/40">
                                              No payments recorded for this distribution.
                                            </p>
                                          ) : (
                                            <div className="overflow-x-auto">
                                              <table className="w-full min-w-[520px]">
                                                <thead>
                                                  <tr className="border-b border-white/10">
                                                    <th className="text-left text-xs font-bold text-white/40 pb-2 pr-4">WALLET</th>
                                                    <th className="text-right text-xs font-bold text-white/40 pb-2 px-4">AMOUNT ($CUM)</th>
                                                    <th className="text-right text-xs font-bold text-white/40 pb-2 px-4">SHARE %</th>
                                                    <th className="text-center text-xs font-bold text-white/40 pb-2 px-4">STATUS</th>
                                                    <th className="text-right text-xs font-bold text-white/40 pb-2 pl-4">TX</th>
                                                  </tr>
                                                </thead>
                                                <tbody>
                                                  {detail.payments.map((p: ApiDiamondPayment, idx: number) => {
                                                    const pBadge = distStatusBadge(p.status)
                                                    return (
                                                      <tr key={idx} className="border-b border-white/5">
                                                        <td className="py-2 pr-4">
                                                          <button
                                                            onClick={(e) => { e.stopPropagation(); copyWallet(p.wallet) }}
                                                            className="flex items-center gap-1.5 font-mono text-xs text-white hover:text-white/40 transition-colors"
                                                          >
                                                            {truncate(p.wallet)}
                                                            {copiedWallet === p.wallet ? (
                                                              <Check className="w-3 h-3 text-emerald-500" />
                                                            ) : (
                                                              <Copy className="w-3 h-3 opacity-40" />
                                                            )}
                                                          </button>
                                                        </td>
                                                        <td className="py-2 px-4 text-right font-mono text-xs text-cyan-400">
                                                          {fmtSol(p.amountTokens)}
                                                        </td>
                                                        <td className="py-2 px-4 text-right font-mono text-xs text-white/40">
                                                          {Number(p.percentage).toFixed(4)}%
                                                        </td>
                                                        <td className="py-2 px-4 text-center">
                                                          <span className={`text-xs font-black px-1.5 py-0.5 rounded ${pBadge.cls}`}>
                                                            {pBadge.label}
                                                          </span>
                                                        </td>
                                                        <td className="py-2 pl-4 text-right">
                                                          {p.txSignature ? (
                                                            <a
                                                              href={`${SOLSCAN_TX}${p.txSignature}`}
                                                              target="_blank"
                                                              rel="noopener noreferrer"
                                                              onClick={(e) => e.stopPropagation()}
                                                              className="inline-flex items-center gap-1 text-xs font-mono text-white/40 hover:text-white transition-colors"
                                                            >
                                                              {truncate(p.txSignature)}
                                                              <ExternalLink className="w-3 h-3" />
                                                            </a>
                                                          ) : (
                                                            <span className="text-xs text-white/40">—</span>
                                                          )}
                                                        </td>
                                                      </tr>
                                                    )
                                                  })}
                                                </tbody>
                                              </table>
                                            </div>
                                          )}
                                        </div>
                                      ) : null}
                                    </td>
                                  </tr>
                                )
                              })()}
                            </React.Fragment>
                          )
                        })}
                  </tbody>
                </table>
              </div>

              {/* Pagination — only for instant filter */}
              {historyFilter === "instant" && totalPages > 1 && (
                <div className="px-4 py-3 border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs font-bold text-white/40">
                    PAGE {currentPage} of {totalPages} · {totalDist} total distributions
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="px-3 py-1.5 bg-[#0A0A0A] rounded-lg text-white text-xs font-bold disabled:opacity-30 hover:bg-white hover:text-white transition-colors border border-white/10"
                    >
                      ← PREV
                    </button>
                    {pageNumbers.map((pg) => (
                      <button
                        key={pg}
                        onClick={() => setCurrentPage(pg)}
                        className={`w-8 h-8 rounded-lg text-xs font-black transition-colors border ${
                          pg === currentPage
                            ? "bg-white text-white border-[#8B7FA0]/50 "
                            : "bg-[#0A0A0A] text-white border-white/10 hover:bg-white hover:text-white hover:border-[#8B7FA0]/50"
                        }`}
                      >
                        {pg}
                      </button>
                    ))}
                    <button
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1.5 bg-[#0A0A0A] rounded-lg text-white text-xs font-bold disabled:opacity-30 hover:bg-white hover:text-white transition-colors border border-white/10"
                    >
                      NEXT →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────────── */}
      <footer className="bg-black border-t border-white/10 mt-6">
        <div className="max-w-7xl mx-auto px-4 py-5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Image
              src="/cumbank-logo.jpg"
              alt={"CUMBANK"}
              width={24}
              height={24}
              className="rounded"
            />
            <p className="text-white/50 text-sm font-bold">CUMBANK © 2026 · BUILT ON SOLANA</p>
          </div>
          <div className="flex items-center gap-4">
            <a href="/dashboard" className="text-white/50 text-sm font-bold hover:text-white transition-colors">
              DASHBOARD
            </a>
            {config.twitterUrl && (
              <a
                href={config.twitterUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-white/50 text-sm font-bold hover:text-white transition-colors"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                FOLLOW
              </a>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}