import { useState, useEffect } from "react"
import {
  ArrowLeft,
  ReceiptIndianRupee,
  CheckCircle2,
  ShieldCheck,
  Plus,
  Trash2,
  LockKeyhole,
  IndianRupee,
  AlertCircle,
} from "lucide-react"
import {
  getPublicPatientId,
  type Page,
  type Patient,
  type BillData,
  type BillItem,
} from "../../types"
import { computeBillTotals } from "../../utils/billing"
import {
  Button,
  IconButton,
  Field,
  TextInput,
  SelectInput,
  StatusPill,
  Modal,
  FormSection,
} from "../common"
import { AppHeader } from "../layout"
import {
  isTauriDesktop,
  saveLocalInvoice,
  finalizeLocalInvoice,
  type LocalInvoiceItem,
  type LocalInvoiceRecord,
  type DesktopSessionContext,
} from "../../desktop/desktop-bridge"

export interface BillFormProps {
  go: (page: Page) => void
  patient: Patient
  bill: BillData
  onChange: (bill: BillData) => void
  desktopSession?: DesktopSessionContext | null
  onFinalized?: (invoice: LocalInvoiceRecord) => void
}

export function BillForm({
  go,
  patient,
  bill,
  onChange,
  desktopSession,
  onFinalized,
}: BillFormProps) {
  const [isSaving, setIsSaving] = useState(false)
  const [isFinalizing, setIsFinalizing] = useState(false)
  const [showFinalizeModal, setShowFinalizeModal] = useState(false)
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const isFinalized = bill.status === "FINALIZED"

  const {
    subtotalPaise,
    discountPaise,
    taxRatePercent,
    taxPaise,
    totalPaise,
    subtotalRupees,
    discountRupees,
    taxRupees,
    totalRupees,
  } = computeBillTotals(bill.items, bill.discount, bill.taxRatePercent)

  const updateItem = (id: number, updates: Partial<BillItem>) => {
    if (isFinalized) return
    onChange({
      ...bill,
      items: bill.items.map((item) =>
        item.id === id ? { ...item, ...updates } : item,
      ),
    })
  }

  const addItem = () => {
    if (isFinalized) return
    onChange({
      ...bill,
      items: [
        ...bill.items,
        { id: Date.now(), description: "", quantity: 1, rate: 0 },
      ],
    })
  }

  const removeItem = (id: number) => {
    if (isFinalized || bill.items.length === 1) return
    onChange({
      ...bill,
      items: bill.items.filter((item) => item.id !== id),
    })
  }

  const canPreview = bill.items.some(
    (item) => item.description.trim() && item.rate >= 0,
  )
  const canFinalize =
    bill.items.length > 0 &&
    bill.items.every(
      (item) => item.description.trim() && item.quantity >= 1 && item.rate >= 0,
    )

  const handleSaveDraft = async () => {
    setErrorMessage(null)
    setIsSaving(true)
    try {
      const items: LocalInvoiceItem[] = bill.items.map((it) => ({
        name: it.description.trim() || "Service",
        quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
        unit_price_paise: Math.max(0, Math.round((Number(it.rate) || 0) * 100)),
        line_total_paise:
          Math.max(1, Math.floor(Number(it.quantity) || 1)) *
          Math.max(0, Math.round((Number(it.rate) || 0) * 100)),
      }))

      if (isTauriDesktop() && desktopSession?.clinic_id) {
        const savedId = await saveLocalInvoice({
          id: bill.id || null,
          clinic_id: desktopSession.clinic_id,
          patient_id: patient.id,
          invoice_number: bill.invoiceNumber,
          subtotal_paise: subtotalPaise,
          discount_paise: discountPaise,
          tax_rate_percent: taxRatePercent,
          tax_paise: taxPaise,
          total_paise: totalPaise,
          items,
          notes: bill.notes || null,
        })
        if (savedId) {
          onChange({ ...bill, id: savedId, status: "DRAFT" })
        }
      }
      setSaveFeedback("Draft invoice saved to local encrypted storage.")
      window.setTimeout(() => setSaveFeedback(null), 2500)
    } catch (err: unknown) {
      console.error("Failed to save draft invoice:", err)
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to save draft invoice to storage.",
      )
    } finally {
      setIsSaving(false)
    }
  }

  const handleFinalizeBill = async () => {
    setErrorMessage(null)
    setIsFinalizing(true)
    try {
      const items: LocalInvoiceItem[] = bill.items.map((it) => ({
        name: it.description.trim() || "Service",
        quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
        unit_price_paise: Math.max(0, Math.round((Number(it.rate) || 0) * 100)),
        line_total_paise:
          Math.max(1, Math.floor(Number(it.quantity) || 1)) *
          Math.max(0, Math.round((Number(it.rate) || 0) * 100)),
      }))

      let invoiceId = bill.id
      if (isTauriDesktop() && desktopSession?.clinic_id) {
        if (!invoiceId) {
          invoiceId =
            (await saveLocalInvoice({
              id: null,
              clinic_id: desktopSession.clinic_id,
              patient_id: patient.id,
              invoice_number: bill.invoiceNumber,
              subtotal_paise: subtotalPaise,
              discount_paise: discountPaise,
              tax_rate_percent: taxRatePercent,
              tax_paise: taxPaise,
              total_paise: totalPaise,
              items,
              notes: bill.notes || null,
            })) || undefined
        }
        if (invoiceId) {
          const finalizedRecord = await finalizeLocalInvoice(
            desktopSession.clinic_id,
            invoiceId,
          )
          if (finalizedRecord) {
            onChange({
              ...bill,
              id: finalizedRecord.id,
              status: "FINALIZED",
            })
            onFinalized?.(finalizedRecord)
          }
        }
      } else {
        onChange({ ...bill, status: "FINALIZED" })
      }
      setShowFinalizeModal(false)
      go("bill-preview")
    } catch (err: unknown) {
      console.error("Failed to finalize invoice:", err)
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to finalize invoice. Record preserved.",
      )
    } finally {
      setIsFinalizing(false)
    }
  }

  useEffect(() => {
    const handleShortcut = (e: Event) => {
      const customEvent = e as CustomEvent<{ action: string }>
      const { action } = customEvent.detail || {}
      if (action === "add-bill-item") {
        addItem()
      } else if (action === "save-draft") {
        if (!isFinalized && !isSaving) {
          handleSaveDraft()
        }
      }
    }
    window.addEventListener("cliniqo-shortcut", handleShortcut)
    return () => {
      window.removeEventListener("cliniqo-shortcut", handleShortcut)
    }
  }, [bill, isFinalized, isSaving])

  return (
    <>
      <AppHeader
        title={isFinalized ? "View finalized bill" : "Create bill"}
        subtitle={`${patient.name} · ${getPublicPatientId(patient)}`}
      >
        <IconButton
          className="topbar-back"
          label="Back to patient profile"
          onClick={() => go("patient-profile")}
        >
          <ArrowLeft size={18} />
        </IconButton>
        {!isFinalized && (
          <>
            <Button
              variant="secondary"
              title="Save draft (Ctrl+S)"
              onClick={handleSaveDraft}
              disabled={isSaving}
              loading={isSaving}
            >
              {isSaving ? "Saving draft..." : "Save draft"}
            </Button>
            <Button
              icon={ReceiptIndianRupee}
              disabled={!canFinalize}
              onClick={() => setShowFinalizeModal(true)}
            >
              Finalize bill
            </Button>
          </>
        )}
        <Button
          variant={isFinalized ? "primary" : "secondary"}
          title="Print / Preview bill (Ctrl+P)"
          disabled={!canPreview}
          onClick={() => go("bill-preview")}
        >
          {isFinalized ? "Print / Preview bill" : "Preview bill"}
        </Button>
      </AppHeader>

      <div className="page-content billing-page">
        {saveFeedback && (
          <div className="success-banner" role="status" aria-live="polite">
            <CheckCircle2 size={19} />
            <div>
              <strong>{saveFeedback}</strong>
              <span>Changes are persisted in encrypted local storage.</span>
            </div>
          </div>
        )}

        {errorMessage && (
          <div
            className="error-box"
            role="alert"
            style={{
              marginBottom: "16px",
              padding: "12px",
              backgroundColor: "#fee2e2",
              color: "#b91c1c",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <AlertCircle size={18} />
            <span>{errorMessage}</span>
          </div>
        )}

        {isFinalized && (
          <div className="bill-immutable-callout">
            <ShieldCheck size={20} style={{ flexShrink: 0 }} />
            <div>
              <strong>Finalized Medical Invoice (Immutable)</strong>
              <p style={{ margin: 0, fontSize: "11px", opacity: 0.9 }}>
                This invoice has been finalized in accordance with clinical and
                financial audit integrity standards. Line items, quantities, and
                totals are locked and cannot be edited.
              </p>
            </div>
          </div>
        )}

        <div className="patient-strip">
          <span className="avatar subtle">{patient.initials}</span>
          <div>
            <strong>{patient.name}</strong>
            <small>
              {patient.age} years · {patient.gender} · {patient.phone}
            </small>
          </div>
          <StatusPill tone={isFinalized ? "success" : "warning"}>
            {isFinalized ? "Finalized bill" : "Local draft"}
          </StatusPill>
        </div>

        <FormSection icon={ReceiptIndianRupee} title="Bill details">
          <div className="form-grid four bill-meta">
            <Field label="Invoice number">
              <TextInput
                value={bill.invoiceNumber}
                disabled={isFinalized}
                onChange={(event) =>
                  onChange({ ...bill, invoiceNumber: event.target.value })
                }
              />
            </Field>
            <Field label="Invoice date">
              <TextInput
                type="date"
                value={bill.date}
                disabled={isFinalized}
                onChange={(event) =>
                  onChange({ ...bill, date: event.target.value })
                }
              />
            </Field>
            <Field label="Payment status">
              <SelectInput
                value={bill.paymentStatus}
                disabled={isFinalized}
                onChange={(event) =>
                  onChange({
                    ...bill,
                    paymentStatus: event.target
                      .value as BillData["paymentStatus"],
                  })
                }
              >
                <option>Unpaid</option>
                <option>Paid</option>
              </SelectInput>
            </Field>
            <Field label="GST / Tax configuration">
              <SelectInput
                value={String(bill.taxRatePercent ?? 0)}
                disabled={isFinalized}
                onChange={(event) =>
                  onChange({
                    ...bill,
                    taxRatePercent: Number(event.target.value),
                  })
                }
              >
                <option value="0">0% (GST Exempt / Nil)</option>
                <option value="5">5% GST</option>
                <option value="12">12% GST</option>
                <option value="18">18% GST</option>
              </SelectInput>
            </Field>
          </div>

          <div className="bill-items-head">
            <span>Service or item</span>
            <span>Qty</span>
            <span>Unit Rate (₹)</span>
            <span>Amount (₹)</span>
            <span />
          </div>

          <div className="bill-items">
            {bill.items.map((item) => (
              <div className="bill-item-row" key={item.id}>
                <TextInput
                  aria-label="Service or item"
                  value={item.description}
                  disabled={isFinalized}
                  onChange={(event) =>
                    updateItem(item.id, { description: event.target.value })
                  }
                  placeholder="e.g. Consultation fee, ECG, Procedure"
                />
                <TextInput
                  aria-label="Quantity"
                  type="number"
                  min="1"
                  disabled={isFinalized}
                  value={item.quantity}
                  onChange={(event) =>
                    updateItem(item.id, {
                      quantity: Math.max(1, Number(event.target.value)),
                    })
                  }
                />
                <div className="money-input">
                  <IndianRupee size={14} />
                  <input
                    aria-label="Rate"
                    type="number"
                    min="0"
                    disabled={isFinalized}
                    value={item.rate || ""}
                    onChange={(event) =>
                      updateItem(item.id, {
                        rate: Math.max(0, Number(event.target.value)),
                      })
                    }
                    placeholder="0"
                  />
                </div>
                <strong>
                  ₹
                  {(item.quantity * item.rate).toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                  })}
                </strong>
                <IconButton
                  label="Remove item"
                  onClick={() => removeItem(item.id)}
                  disabled={isFinalized || bill.items.length === 1}
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
            ))}
          </div>

          {!isFinalized && (
            <Button
              size="sm"
              variant="secondary"
              icon={Plus}
              title="Add bill item (Ctrl+Shift+I)"
              onClick={addItem}
            >
              Add item
            </Button>
          )}

          <div className="form-grid one" style={{ marginTop: "18px" }}>
            <Field label="Invoice / Payment remarks (Optional)">
              <TextInput
                value={bill.notes ?? ""}
                disabled={isFinalized}
                onChange={(event) =>
                  onChange({ ...bill, notes: event.target.value })
                }
                placeholder="e.g. UPI Ref / Cheque # / Insurance Pre-auth note"
              />
            </Field>
          </div>

          <div className="bill-summary">
            <div>
              <span>Subtotal</span>
              <strong>
                ₹
                {subtotalRupees.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                })}
              </strong>
            </div>
            <label>
              <span>Discount</span>
              <div className="money-input">
                <IndianRupee size={13} />
                <input
                  aria-label="Discount"
                  type="number"
                  min="0"
                  disabled={isFinalized}
                  value={bill.discount || ""}
                  onChange={(event) =>
                    onChange({
                      ...bill,
                      discount: Math.max(0, Number(event.target.value)),
                    })
                  }
                  placeholder="0"
                />
              </div>
            </label>
            {taxRatePercent > 0 && (
              <div>
                <span>Tax ({taxRatePercent}% GST)</span>
                <strong>
                  + ₹
                  {taxRupees.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                  })}
                </strong>
              </div>
            )}
            <div className="bill-total">
              <span>Grand Total</span>
              <strong>
                ₹
                {totalRupees.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                })}
              </strong>
            </div>
          </div>
        </FormSection>

        <div className="patient-form-actions">
          <div>
            <strong>
              {isFinalized ? "Finalized medical invoice" : "Review bill draft"}
            </strong>
          </div>
          <Button variant="ghost" onClick={() => go("patient-profile")}>
            {isFinalized ? "Back to patient" : "Cancel"}
          </Button>
          {!isFinalized && (
            <Button
              icon={ReceiptIndianRupee}
              disabled={!canFinalize}
              onClick={() => setShowFinalizeModal(true)}
            >
              Finalize bill
            </Button>
          )}
          <Button
            variant={isFinalized ? "primary" : "secondary"}
            disabled={!canPreview}
            onClick={() => go("bill-preview")}
          >
            {isFinalized ? "Print bill" : "Preview"}
          </Button>
        </div>
      </div>

      {showFinalizeModal && (
        <Modal
          title="Finalize invoice?"
          description="Confirm that you have reviewed the service charges, quantities, discount, and tax. Once finalized, the invoice amounts and line items become immutable."
          onClose={() => {
            if (!isFinalizing) setShowFinalizeModal(false)
          }}
        >
          <div className="review-checklist">
            <p>
              <CheckCircle2 size={18} /> Billed patient: {patient.name} (
              {getPublicPatientId(patient)})
            </p>
            <p>
              <CheckCircle2 size={18} /> Subtotal: ₹
              {subtotalRupees.toLocaleString("en-IN", {
                minimumFractionDigits: 2,
              })}{" "}
              (Paise: {subtotalPaise})
            </p>
            {discountRupees > 0 && (
              <p>
                <CheckCircle2 size={18} /> Discount applied: ₹
                {discountRupees.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                })}
              </p>
            )}
            {taxRatePercent > 0 && (
              <p>
                <CheckCircle2 size={18} /> Tax ({taxRatePercent}%): ₹
                {taxRupees.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                })}
              </p>
            )}
            <p>
              <CheckCircle2 size={18} /> Final payable total: ₹
              {totalRupees.toLocaleString("en-IN", {
                minimumFractionDigits: 2,
              })}
            </p>
          </div>
          <div className="modal-warning">
            <LockKeyhole size={17} />
            <p>
              Finalizing commits this record to the immutable billing ledger.
              Further changes cannot be made.
            </p>
          </div>
          <div className="modal-actions">
            <Button
              variant="ghost"
              onClick={() => setShowFinalizeModal(false)}
              disabled={isFinalizing}
            >
              Continue editing
            </Button>
            <Button
              onClick={handleFinalizeBill}
              disabled={isFinalizing}
              loading={isFinalizing}
            >
              {isFinalizing
                ? "Finalizing invoice..."
                : "Confirm & finalize bill"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

export default BillForm
