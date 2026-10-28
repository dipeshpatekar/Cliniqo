import { useEffect, useState } from "react"
import { Button, StatusPill } from "../common"
import {
  isTauriDesktop,
  getLocalInvoices,
  type DesktopSessionContext,
  type LocalInvoiceRecord,
} from "../../desktop/desktop-bridge"
import type { Patient } from "../../types"
import { ChevronRight, Plus, ReceiptIndianRupee } from "lucide-react"

export function InvoicesTab({
  patient,
  desktopSession,
  onStartBill,
}: {
  patient: Patient
  desktopSession?: DesktopSessionContext | null
  onStartBill?: (patient: Patient, invoice?: LocalInvoiceRecord) => void
}) {
  const [invoices, setInvoices] = useState<LocalInvoiceRecord[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let mounted = true
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      setLoading(true)
      getLocalInvoices(desktopSession.clinic_id, patient.id)
        .then((records) => {
          if (mounted) {
            setInvoices(records)
            setLoading(false)
          }
        })
        .catch((err) => {
          console.error("Failed to load patient invoices:", err)
          if (mounted) setLoading(false)
        })
    }
    return () => {
      mounted = false
    }
  }, [desktopSession?.clinic_id, patient.id])

  return (
    <section className="panel record-list">
      <div className="panel-head">
        <div>
          <h2>Patient invoices</h2>
          <p>
            Preserved billing records with safe minor-unit monetary arithmetic
          </p>
        </div>
        <Button size="sm" icon={Plus} onClick={() => onStartBill?.(patient)}>
          New bill
        </Button>
      </div>
      {loading ? (
        <div className="p-8 text-center text-slate-500 dark:text-slate-400">
          <p className="text-sm">Loading encrypted invoice records...</p>
        </div>
      ) : invoices.length > 0 ? (
        invoices.map((inv) => (
          <button key={inv.id} onClick={() => onStartBill?.(patient, inv)}>
            <span className="record-icon">
              <ReceiptIndianRupee size={18} />
            </span>
            <span>
              <strong>
                {inv.invoice_number} · ₹
                {(inv.total_paise / 100).toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                })}
              </strong>
              <small>
                {inv.created_at ? inv.created_at.slice(0, 10) : "Today"} ·{" "}
                {inv.items ? inv.items.length : 0}{" "}
                {inv.items && inv.items.length === 1 ? "item" : "items"}
              </small>
            </span>
            <div style={{ display: "flex", gap: "6px" }}>
              <StatusPill
                tone={inv.status === "FINALIZED" ? "success" : "warning"}
              >
                {inv.status === "FINALIZED" ? "Finalized" : "Draft"}
              </StatusPill>
              <StatusPill
                tone={inv.payment_status === "PAID" ? "success" : "neutral"}
              >
                {inv.payment_status === "PAID" ? "Paid" : "Unpaid"}
              </StatusPill>
              {inv.sync_status && (
                <StatusPill
                  tone={
                    inv.sync_status === "SYNCED"
                      ? "success"
                      : inv.sync_status === "CONFLICT"
                        ? "danger"
                        : "warning"
                  }
                >
                  {inv.sync_status}
                </StatusPill>
              )}
            </div>
            <ChevronRight size={17} />
          </button>
        ))
      ) : (
        <div className="empty-state compact">
          <ReceiptIndianRupee size={25} />
          <h2>No invoices recorded</h2>
          <p>
            Create an itemized invoice for consultation, tests, or clinical
            procedures.
          </p>
          <Button icon={Plus} onClick={() => onStartBill?.(patient)}>
            Create first bill
          </Button>
        </div>
      )}
    </section>
  )
}
