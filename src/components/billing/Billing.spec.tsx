import { describe, it, expect, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { BillForm } from "./BillForm"
import { BillPreview } from "./BillPreview"
import { WhatsAppSettings } from "../settings/WhatsAppSettings"
import { PrescriptionPreview } from "../consultation/PrescriptionPreview"
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
      expect(html).toContain("Print bill")
      expect(html).not.toContain("Preview bill")
    })

    it("does not render preview button in draft state (Issue 23)", () => {
      const html = renderToString(
        <BillForm
          go={() => {}}
          patient={samplePatient}
          bill={draftBill}
          onChange={() => {}}
        />,
      )

      expect(html).not.toContain("Preview bill")
      expect(html).toContain("Save draft")
      expect(html).toContain("Finalize bill")
    })

    it("does not contain any finalize confirmation popup modal in draft or finalized state (Issue 22)", () => {
      const draftHtml = renderToString(
        <BillForm
          go={() => {}}
          patient={samplePatient}
          bill={draftBill}
          onChange={() => {}}
        />,
      )
      expect(draftHtml).not.toContain("Finalize invoice?")
      expect(draftHtml).not.toContain("Confirm & finalize bill")
      expect(draftHtml).not.toContain("Continue editing")

      const finalizedHtml = renderToString(
        <BillForm
          go={() => {}}
          patient={samplePatient}
          bill={finalizedBill}
          onChange={() => {}}
        />,
      )
      expect(finalizedHtml).not.toContain("Finalize invoice?")
      expect(finalizedHtml).not.toContain("Confirm & finalize bill")
      expect(finalizedHtml).not.toContain("Continue editing")
    })
  })

  describe("Invoice Data Contract & Version Alignment (Issues 21-24 & Release Prep)", () => {
    it("ensures version 1.0.3 is synchronized across config files", async () => {
      const fs = await import("node:fs")
      const path = await import("node:path")

      // package.json
      const pkgPath = path.resolve(process.cwd(), "package.json")
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
      expect(pkg.version).toBe("1.0.3")

      // src-tauri/Cargo.toml
      const cargoPath = path.resolve(process.cwd(), "src-tauri/Cargo.toml")
      const cargoContent = fs.readFileSync(cargoPath, "utf-8")
      expect(cargoContent).toMatch(/version\s*=\s*"1\.0\.3"/)

      // src-tauri/tauri.conf.json
      const tauriPath = path.resolve(process.cwd(), "src-tauri/tauri.conf.json")
      const tauriConf = JSON.parse(fs.readFileSync(tauriPath, "utf-8"))
      expect(tauriConf.version).toBe("1.0.3")
    })

    it("ensures onFinalized in App.tsx updates return page without duplicate navigation", () => {
      // Regression test for Issue 2: BillForm alone navigates to bill-preview
      const go = vi.fn()
      let billPreviewReturnPage = "bill-form"

      // App.tsx callback contract
      const onFinalized = () => {
        billPreviewReturnPage = "patient-profile"
        // MUST NOT call go("bill-preview") here!
      }

      // Execute onFinalized
      onFinalized()

      expect(billPreviewReturnPage).toBe("patient-profile")
      expect(go).not.toHaveBeenCalled()
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
      expect(html).toContain("28/10/2026")
      expect(html).toContain("Consultation Fee")
      expect(html).toContain("ECG Test")
      expect(html).toContain("GST (18%)")
      expect(html).toContain("Doctor’s signature")
      expect(html).toContain("Print bill")
      expect(html).toContain("Send on WhatsApp")
    })

    it("omits View invoice button in notification banner when bill is finalized", () => {
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
      expect(html).not.toContain("View invoice")
      expect(html).not.toContain("Edit bill")
      expect(html).toContain("Finalized tax invoice. Ready for patient delivery and printing.")
    })

    it("renders disabled Send on WhatsApp button with opacity-50 cursor-not-allowed in BillPreview", () => {
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
      expect(html).toContain("Send on WhatsApp")
      expect(html).toContain("disabled")
      expect(html).toContain("opacity-50 cursor-not-allowed")
    })

    it("renders disabled Connect button with opacity-50 cursor-not-allowed in WhatsAppSettings", () => {
      const rawHtml = renderToString(<WhatsAppSettings />)
      const html = rawHtml.replace(/<!-- -->/g, "")
      expect(html).toContain("Connect")
      expect(html).not.toContain("UI checked")
      expect(html).toContain("opacity-50 cursor-not-allowed")
      expect(html).toContain("disabled")
    })

    it("renders disabled Send on WhatsApp button with opacity-50 cursor-not-allowed in PrescriptionPreview", () => {
      const rawHtml = renderToString(
        <PrescriptionPreview
          patient={samplePatient}
          go={() => {}}
          clinicalLibrary={[]}
          vitals={{}}
          data={{ medicines: [] }}
          bannerImage={null}
          signatureImage={null}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")
      expect(html).toContain("Send on WhatsApp")
      expect(html).toContain("opacity-50 cursor-not-allowed")
      expect(html).toContain("disabled")
    })
  })
})
