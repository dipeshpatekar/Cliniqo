import { useState, useEffect, useMemo } from "react"
import {
  Package,
  Search,
  UploadCloud,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Layers,
} from "lucide-react"
import { Button, TextInput, StatusPill } from "../common"
import {
  importInventoryStock,
  getInventoryStock,
  getInventoryStockSummary,
  type DesktopSessionContext,
  type StockItemRecord,
  type StockSummaryRecord,
  type StockImportSummary,
} from "../../desktop/desktop-bridge"
import stockReportData from "../../data/stock-report-18-10-26.json"

export interface InventoryStockSettingsProps {
  desktopSession?: DesktopSessionContext | null
}

export function InventoryStockSettings({
  desktopSession,
}: InventoryStockSettingsProps) {
  const clinicId = desktopSession?.clinic_id || "clinic-default"

  const [searchQuery, setSearchQuery] = useState("")
  const [items, setItems] = useState<StockItemRecord[]>([])
  const [summary, setSummary] = useState<StockSummaryRecord>({
    total_products: 0,
    total_quantity: 0,
    total_value: 0,
  })
  const [isLoading, setIsLoading] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [allowOverwrite, setAllowOverwrite] = useState(false)
  const [importResult, setImportResult] = useState<StockImportSummary | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)

  const loadStockData = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [records, stats] = await Promise.all([
        getInventoryStock(clinicId, searchQuery),
        getInventoryStockSummary(clinicId),
      ])
      setItems(records)
      setSummary(stats)
    } catch (err: any) {
      console.error("Failed to load inventory stock:", err)
      setError("Failed to load inventory stock records.")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadStockData()
  }, [clinicId, searchQuery])

  const handleImportStockReport = async () => {
    setIsImporting(true)
    setError(null)
    setImportResult(null)
    try {
      const res = await importInventoryStock(
        clinicId,
        stockReportData as any,
        allowOverwrite,
        "STOCK REPORT (18-10-26)",
      )
      setImportResult(res)
      await loadStockData()
    } catch (err: any) {
      console.error("Stock import failed:", err)
      setError(err?.message || "Failed to import stock report.")
    } finally {
      setIsImporting(false)
    }
  }

  const formatCurrency = (val: number | null | undefined) => {
    if (val == null) return "—"
    return `₹${val.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }

  return (
    <section className="settings-section">
      <div className="settings-title with-status">
        <div>
          <h2>Inventory & Stock Management</h2>
          <p>
            Track clinic and pharmacy inventory batches, quantities, and
            valuations. Maintained separately from Clinical Formulary and CDCI
            catalogues.
          </p>
        </div>
        <StatusPill tone="info">
          {summary.total_products > 0 ? "STOCKED" : "EMPTY"}
        </StatusPill>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-4">
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 bg-slate-50 dark:bg-slate-900/50">
          <span className="text-xs text-slate-500 uppercase tracking-wider block font-medium">
            Total Unique Products
          </span>
          <span className="text-2xl font-bold text-slate-800 dark:text-slate-100">
            {summary.total_products.toLocaleString()}
          </span>
        </div>
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 bg-slate-50 dark:bg-slate-900/50">
          <span className="text-xs text-slate-500 uppercase tracking-wider block font-medium">
            Total Quantity on Hand
          </span>
          <span className="text-2xl font-bold text-teal-600 dark:text-teal-400">
            {summary.total_quantity.toLocaleString()}
          </span>
        </div>
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 bg-slate-50 dark:bg-slate-900/50">
          <span className="text-xs text-slate-500 uppercase tracking-wider block font-medium">
            Total Valuation
          </span>
          <span className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(summary.total_value)}
          </span>
        </div>
      </div>

      {/* Controls & Import Action */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between mb-4 p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
        <div className="flex-1 max-w-md relative">
          <TextInput
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search stock by product, company, or unit..."
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allowOverwrite}
              onChange={(e) => setAllowOverwrite(e.target.checked)}
              className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            <span>Overwrite existing quantities</span>
          </label>

          <Button
            icon={isImporting ? RefreshCw : UploadCloud}
            onClick={handleImportStockReport}
            disabled={isImporting}
          >
            {isImporting
              ? "Importing Report..."
              : "Import Stock Report (18-10-26)"}
          </Button>
        </div>
      </div>

      {/* Import Feedback / Summary Banner */}
      {importResult && (
        <div
          className={`p-4 mb-4 rounded-lg border ${
            importResult.failed > 0
              ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200 text-amber-900 dark:text-amber-200"
              : "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 text-emerald-900 dark:text-emerald-200"
          }`}
        >
          <div className="flex items-start gap-2">
            <CheckCircle2
              size={18}
              className="mt-0.5 text-emerald-600 shrink-0"
            />
            <div>
              <strong className="block text-sm font-semibold">
                Import Completed Successfully
              </strong>
              <p className="text-xs mt-1">
                Total Processed: <strong>{importResult.total_records}</strong> ·
                Newly Added: <strong>{importResult.successful}</strong> ·
                Skipped (Duplicates): <strong>{importResult.skipped}</strong>
                {importResult.failed > 0 && ` · Failed: ${importResult.failed}`}
              </p>
              <p className="text-xs mt-1 text-slate-600 dark:text-slate-300">
                Total Units Reconciled:{" "}
                <strong>{importResult.total_quantity.toLocaleString()}</strong>{" "}
                · Total Valuation:{" "}
                <strong>{formatCurrency(importResult.total_value)}</strong>
              </p>
              {importResult.skipped > 0 && (
                <p className="text-xs mt-1 italic text-slate-500">
                  Duplicate entries safely skipped without modifying existing
                  quantities.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 mb-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 text-red-700 dark:text-red-300 text-xs flex items-center gap-2">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* Stock Items Table */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden bg-white dark:bg-slate-800">
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-100 dark:bg-slate-700/50 sticky top-0 border-b border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 uppercase tracking-wider font-semibold">
              <tr>
                <th className="py-2.5 px-3">Product Name</th>
                <th className="py-2.5 px-3">Unit</th>
                <th className="py-2.5 px-3">Company</th>
                <th className="py-2.5 px-3 text-right">Quantity</th>
                <th className="py-2.5 px-3 text-right">Value (₹)</th>
                <th className="py-2.5 px-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50 text-slate-800 dark:text-slate-200">
              {items.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="py-8 text-center text-slate-500 dark:text-slate-400"
                  >
                    {isLoading ? (
                      <div className="flex items-center justify-center gap-2">
                        <RefreshCw className="animate-spin" size={16} />
                        <span>Loading inventory items...</span>
                      </div>
                    ) : searchQuery ? (
                      <span>No stock items matching "{searchQuery}"</span>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Package size={24} className="text-slate-400" />
                        <span>
                          No inventory items recorded yet. Click 'Import Stock
                          Report' above to import the 18-10-26 stock report.
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-700/30"
                  >
                    <td className="py-2 px-3 font-medium text-slate-900 dark:text-slate-100">
                      {row.product_name}
                    </td>
                    <td className="py-2 px-3 text-slate-600 dark:text-slate-400">
                      {row.unit || "—"}
                    </td>
                    <td className="py-2 px-3 text-slate-600 dark:text-slate-400">
                      {row.company || "—"}
                    </td>
                    <td className="py-2 px-3 text-right font-semibold text-teal-600 dark:text-teal-400">
                      {row.quantity.toLocaleString()}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-700 dark:text-slate-300">
                      {formatCurrency(row.value)}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className="inline-block px-2 py-0.5 text-[10px] font-semibold rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
                        IN STOCK
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {items.length > 0 && (
          <div className="py-2 px-3 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-500 flex justify-between">
            <span>
              Showing {items.length} product{items.length === 1 ? "" : "s"}
            </span>
            <span>Batch Source: STOCK REPORT (18-10-26)</span>
          </div>
        )}
      </div>

      {/* Separation Safeguard Callout */}
      <div
        className="info-callout mt-4"
        style={{
          borderLeftColor: "#0d9488",
          backgroundColor: "#f0fdfa",
          color: "#0f766e",
        }}
      >
        <div className="flex gap-2 items-start">
          <Layers size={18} className="shrink-0 mt-0.5" />
          <div>
            <strong className="block mb-1 text-sm">
              Strict Architectural Separation Safeguard
            </strong>
            <p className="text-xs leading-relaxed">
              Inventory stock records are maintained in an independent storage
              model (
              <code className="bg-teal-100/60 dark:bg-teal-900/40 px-1 rounded">
                local_inventory_stock_v1
              </code>
              ). Physical clinic supplies do not pollute clinical prescription
              formulary entries or alter the 104,367-record CDCI reference
              catalogue.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

export default InventoryStockSettings
