import { describe, it, expect } from "vitest"
import { renderToString } from "react-dom/server"
import { BillForm } from "./BillForm"
import { BillPreview } from "./BillPreview"
import type { Patient, BillData, BillLayoutPreferences } from "../../types"

describe("Billing Components & UX", () => {
  const samplePatient: Patient = {
    id: "PC-1001",
    name: "Aarav Sharma",
    initials: "AS",
    age: 45,
    gender: "Male",
    phone: "+91 98765 00001",
    lastVisit: "Today",
    allergies: [],
    conditions: [],
  }

  const draftBill: BillData = {
    invoiceNumber: "INV-2026-1001",
    date: "2026-10-28",
    status: "DRAFT",
    paymentStatus: "Unpaid",
    discount: 50,
    taxRatePercent: 18,
    items: [
      { id: 1, description: "Consultation Fee", quantity: 1, rate: 800 },
      { id: 2, description: "ECG Test", quantity: 1, rate: 450 },
    ],
    notes: "Follow up in 2 weeks",
  }

  const finalizedBill: BillData = {
    ...draftBill,
    id: "inv-uuid-finalized",
    status: "FINALIZED",
    paymentStatus: "Paid",
  }

  const defaultLayout: BillLayoutPreferences = {
    showBanner: true,
    showClinicLogo: true,
    showClinicEmail: true,
    showSignature: true,
    showPaymentNote: true,
  }

  describe("BillForm - Draft vs Finalized States", () => {
    it("renders editable controls and active action buttons in draft state", () => {
      const html = renderToString(
        <BillForm
          go={() => {}}
          patient={samplePatient}
          bill={draftBill}
          onChange={() => {}}
        />,
      )

      expect(html).toContain("Create bill")
      expect(html).toContain("Save draft")
      expect(html).toContain("Finalize bill")
      expect(html).toContain("Consultation Fee")
      expect(html).toContain("ECG Test")
      expect(html).toContain("Add item")
      expect(html).not.toContain("Finalized Medical Invoice (Immutable)")
    })

    it("renders immutable callout and disables form inputs in finalized state", () => {
      const html = renderToString(
        <BillForm
          go={() => {}}
          patient={samplePatient}
          bill={finalizedBill}
          onChange={() => {}}
        />,
      )

      expect(html).toContain("View finalized bill")
      expect(html).toContain("Finalized Medical Invoice (Immutable)")
      expect(html).toContain(
        "This invoice has been finalized in accordance with clinical and financial audit integrity standards",
      )
      // Save draft and Finalize bill buttons must not be present
      expect(html).not.toContain("Save draft")
      expect(html).toContain("Print / Preview bill")
    })
  })

  describe("BillPreview", () => {
    it("renders printable tax invoice with items, GST breakdown and doctor signature", () => {
      const rawHtml = renderToString(
        <BillPreview
          go={() => {}}
          patient={samplePatient}
          bill={finalizedBill}
          bannerImage={null}
          signatureImage={null}
          layout={defaultLayout}
          returnPage="bill-form"
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("Bill preview")
      expect(html).toContain("printable-bill")
      expect(html).toContain("INV-2026-1001")
      expect(html).toContain("Consultation Fee")
      expect(html).toContain("ECG Test")
      expect(html).toContain("GST (18%)")
      expect(html).toContain("Doctor’s signature")
      expect(html).toContain("Print bill")
      expect(html).toContain("Preview WhatsApp flow")
    })
  })
})
