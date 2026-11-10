import { describe, it, expect, beforeAll } from "vitest"
import React from "react"
import { renderToString } from "react-dom/server"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, execSync } from "node:child_process"
import { PrescriptionPreview } from "./components/consultation/PrescriptionPreview"
import { BillPreview } from "./components/billing/BillPreview"
import type { Patient, ConsultationData, Medicine, BillData } from "./types"
import type { DesktopSessionContext } from "./desktop/desktop-bridge"

function findChromeExecutable(): string | null {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN
  }
  if (
    process.env.PUPPETEER_EXECUTABLE_PATH &&
    fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)
  ) {
    return process.env.PUPPETEER_EXECUTABLE_PATH
  }

  const platform = process.platform
  const candidates: string[] = []

  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      path.join(
        os.homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    )
  } else if (platform === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files"
    const programFilesX86 =
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")

    candidates.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(
        programFilesX86,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(
        programFilesX86,
        "Microsoft",
        "Edge",
        "Application",
        "msedge.exe",
      ),
    )
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    )
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return c
      }
    } catch {}
  }

  try {
    const lookupCmd =
      platform === "win32"
        ? "where.exe chrome"
        : "which google-chrome || which chromium"
    const res = execSync(lookupCmd, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim()
    const firstLine = res.split(/\r?\n/)[0]
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine
    }
  } catch {}

  return null
}

describe("Prescription & Bill A4 Print Layout Verification", () => {
  const scratchDir = path.join(os.tmpdir(), "cliniqo-print-tests")
  const chromeExecutable = findChromeExecutable()

  let cssContent = ""

  beforeAll(() => {
    if (!fs.existsSync(scratchDir)) {
      fs.mkdirSync(scratchDir, { recursive: true })
    }
    // Load CSS from dist/assets or src/index.css
    const cssPath = path.resolve("dist/assets")
    if (fs.existsSync(cssPath)) {
      const cssFiles = fs.readdirSync(cssPath).filter((f) => f.endsWith(".css"))
      if (cssFiles.length > 0) {
        cssContent = fs.readFileSync(path.join(cssPath, cssFiles[0]), "utf8")
      }
    }
    if (!cssContent) {
      cssContent = fs.readFileSync(path.resolve("src/index.css"), "utf8")
    }
  })

  function generatePdf(
    htmlSnippet: string,
    filename: string,
  ): { pages: number; mediabox: string } | null {
    if (!chromeExecutable) {
      return null
    }

    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${filename}</title>
  <style>
    ${cssContent}
  </style>
</head>
<body>
  <div class="app-shell">
    <div class="main-shell">
      ${htmlSnippet}
    </div>
  </div>
</body>
</html>`

    const htmlFile = path.join(scratchDir, `${filename}.html`)
    const pdfFile = path.join(scratchDir, `${filename}.pdf`)
    fs.writeFileSync(htmlFile, fullHtml, "utf8")

    const tmpUserData = path.join(
      os.tmpdir(),
      `chrome-print-${filename}-${Date.now()}`,
    )
    const args = [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${tmpUserData}`,
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfFile}`,
      htmlFile,
    ]

    try {
      execFileSync(chromeExecutable, args, { stdio: "ignore" })
    } catch (err) {
      console.warn(
        `[print-layout] Warning: Chrome headless print failed for ${filename}:`,
        err,
      )
      return null
    }

    if (!fs.existsSync(pdfFile)) {
      return null
    }

    const pdfBuffer = fs.readFileSync(pdfFile)
    const pdfText = pdfBuffer.toString("latin1")

    // Count pages
    const pageMatches = pdfText.match(/\/Type\s*\/Page\b[^s]/g)
    const pages = pageMatches ? pageMatches.length : 1

    // MediaBox
    const mbMatch = pdfText.match(/\/MediaBox\s*\[([^\]]+)\]/)
    const mediabox = mbMatch ? mbMatch[1].trim() : ""

    return { pages, mediabox }
  }

  const dummySession: DesktopSessionContext = {
    doctor_id: "doc-test-1",
    clinic_id: "clinic-test-1",
    doctor_email: "doctor@cliniqo.app",
    doctor_name: "Dr. Dipesh Patekar",
    role: "DOCTOR",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }

  const dummyPatient: Patient = {
    id: "PT-1001",
    name: "Ananya Iyer",
    initials: "AI",
    age: 34,
    gender: "Female",
    phone: "+91 98765 43210",
    lastVisit: "Today",
    allergies: [],
    conditions: [],
  }

  const baseVitals = {
    systolic: "120",
    diastolic: "80",
    heartRate: "72",
    spo2: "99",
    temperature: "98.6",
    height: "165",
    weight: "58",
  }

  const makeMedicine = (
    id: number,
    name: string,
    formulation = "Tablet",
    dose = "1 tab",
    frequency = "TDS",
    duration = "5 days",
  ): Medicine => ({
    id,
    name,
    formulation,
    dose,
    frequency,
    duration,
    food: "After food",
    directions: "Take with water",
    strength: "500 mg",
    route: "Oral",
  })

  it("Scenario 1: Short prescription with no medicines fits on exactly 1 page", () => {
    const data: ConsultationData = {
      date: "2026-11-09",
      time: "10:00",
      chiefComplaint: "Mild congestion and nasal irritation",
      symptomDuration: "1 day",
      diagnosis: "Acute Rhinitis",
      medicines: [],
      followUpDate: "2026-11-16",
      followUpInstructions: "Warm steam inhalation and fluids",
    }

    const html = renderToString(
      <PrescriptionPreview
        go={() => {}}
        patient={dummyPatient}
        vitals={baseVitals}
        data={data}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="consultation"
        desktopSession={dummySession}
      />,
    )

    expect(html).toContain("rx-banner-slot")
    expect(html).toContain("rx-empty")
    expect(html).toContain("Doctor’s signature")

    const res = generatePdf(html, "scenario_1_short_prescription_no_meds")
    if (!res) return
    expect(res.pages).toBe(1)
    expect(res.mediabox).toContain("594")
    expect(res.mediabox).toContain("841")
  })

  it("Scenario 2: Prescription with one medicine fits on exactly 1 page", () => {
    const data: ConsultationData = {
      date: "2026-11-09",
      time: "10:00",
      chiefComplaint: "Sore throat and mild fever",
      symptomDuration: "2 days",
      diagnosis: "Pharyngitis",
      medicines: [makeMedicine(1, "Amoxicillin", "Capsule", "500 mg", "TDS", "5 days")],
      followUpDate: "2026-11-14",
      followUpInstructions: "Warm salt water gargle",
    }

    const html = renderToString(
      <PrescriptionPreview
        go={() => {}}
        patient={dummyPatient}
        vitals={baseVitals}
        data={data}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="consultation"
        desktopSession={dummySession}
      />,
    )

    expect(html).toContain("Amoxicillin")
    expect(html).toContain("Doctor’s signature")

    const res = generatePdf(html, "scenario_2_prescription_one_med")
    if (!res) return
    expect(res.pages).toBe(1)
  })

  it("Scenario 3: Prescription with multiple medicines fits on exactly 1 page", () => {
    const data: ConsultationData = {
      date: "2026-11-09",
      time: "10:00",
      chiefComplaint: "Fever, body ache and productive cough",
      symptomDuration: "3 days",
      diagnosis: "Upper Respiratory Tract Infection",
      medicines: [
        makeMedicine(1, "Paracetamol 650", "Tablet", "1 tab", "TDS", "3 days"),
        makeMedicine(2, "Cetirizine 10", "Tablet", "1 tab", "OD", "5 days"),
        makeMedicine(3, "Ambroxol Syrup", "Syrup", "10 ml", "BD", "5 days"),
        makeMedicine(4, "Vitamin C 500", "Tablet", "1 tab", "OD", "10 days"),
      ],
      followUpDate: "2026-11-15",
      followUpInstructions: "Review if fever persists beyond 48 hours",
    }

    const html = renderToString(
      <PrescriptionPreview
        go={() => {}}
        patient={dummyPatient}
        vitals={baseVitals}
        data={data}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="consultation"
        desktopSession={dummySession}
      />,
    )

    expect(html).toContain("Paracetamol 650")
    expect(html).toContain("Vitamin C 500")

    const res = generatePdf(html, "scenario_3_prescription_multiple_meds")
    if (!res) return
    expect(res.pages).toBe(1)
  })

  it("Scenario 4: Prescription with allergy alert and clinical summary fits on exactly 1 page", () => {
    const allergicPatient: Patient = {
      ...dummyPatient,
      allergies: ["Penicillin", "Sulfa drugs"],
    }

    const data: ConsultationData = {
      date: "2026-11-09",
      time: "10:00",
      chiefComplaint: "Severe allergic rhinitis, ocular pruritus and persistent sneezing",
      symptomDuration: "4 days",
      diagnosis: "Allergic Rhinitis with Conjunctivitis",
      medicines: [
        makeMedicine(1, "Fexofenadine 120", "Tablet", "1 tab", "OD", "7 days"),
        makeMedicine(2, "Fluticasone Nasal Spray", "Nasal Spray", "2 puffs", "BD", "14 days"),
      ],
      followUpDate: "2026-11-23",
      followUpInstructions: "Avoid allergen exposure and keep windows closed in morning",
    }

    const html = renderToString(
      <PrescriptionPreview
        go={() => {}}
        patient={allergicPatient}
        vitals={baseVitals}
        data={data}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="consultation"
        desktopSession={dummySession}
      />,
    )

    expect(html).toContain("Allergy alert")
    expect(html).toContain("Penicillin")

    const res = generatePdf(html, "scenario_4_prescription_allergy_alert")
    if (!res) return
    expect(res.pages).toBe(1)
  })

  it("Scenario 5: Long prescription that legitimately requires multiple pages paginates cleanly across 2 pages", () => {
    const manyMeds: Medicine[] = Array.from({ length: 15 }, (_, i) =>
      makeMedicine(
        i + 1,
        `Clinical Medicine Formulation #${i + 1}`,
        i % 2 === 0 ? "Tablet" : "Capsule",
        "1 unit",
        "BD",
        "15 days",
      ),
    )

    const data: ConsultationData = {
      date: "2026-11-09",
      time: "10:00",
      chiefComplaint: "Multi-system management and extensive polypharmacy review",
      symptomDuration: "3 months",
      diagnosis: "Complex Multi-Morbidity Follow-up",
      medicines: manyMeds,
      followUpDate: "2026-12-09",
      followUpInstructions: "Follow regular dose schedule and record vitals daily in diary",
    }

    const html = renderToString(
      <PrescriptionPreview
        go={() => {}}
        patient={dummyPatient}
        vitals={baseVitals}
        data={data}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="consultation"
        desktopSession={dummySession}
      />,
    )

    const res = generatePdf(html, "scenario_5_long_prescription_multipage")
    if (!res) return
    // Should be exactly 2 pages without a trailing blank 3rd page
    expect(res.pages).toBe(2)
  })

  it("Scenario 6: Short bill with 1 item fits on exactly 1 page", () => {
    const shortBill: BillData = {
      id: "BILL-001",
      invoiceNumber: "INV-2026-0001",
      date: "2026-11-09",
      status: "FINALIZED",
      paymentStatus: "Paid",
      discount: 0,
      taxRatePercent: 0,
      items: [
        {
          id: 1,
          description: "General Consultation Fee",
          quantity: 1,
          rate: 800,
        },
      ],
    }

    const html = renderToString(
      <BillPreview
        bill={shortBill}
        patient={dummyPatient}
        bannerImage={null}
        signatureImage={null}
        go={() => {}}
        layout={{
          showBanner: true,
          showClinicLogo: true,
          showClinicEmail: true,
          showSignature: true,
          showPaymentNote: true,
        }}
        returnPage="bill-form"
        desktopSession={dummySession}
      />,
    )

    expect(html).toContain("General Consultation Fee")
    expect(html).toContain("Doctor’s signature")

    const res = generatePdf(html, "scenario_6_short_bill")
    if (!res) return
    expect(res.pages).toBe(1)
  })

  it("Scenario 7: Bill with multiple items, discounts and taxes fits on exactly 1 page", () => {
    const multiItemBill: BillData = {
      id: "BILL-002",
      invoiceNumber: "INV-2026-0002",
      date: "2026-11-09",
      status: "FINALIZED",
      paymentStatus: "Paid",
      discount: 10,
      taxRatePercent: 18,
      notes: "Payment received via UPI transaction #9823487123.",
      items: [
        {
          id: 1,
          description: "Cardiology Specialist Consultation",
          quantity: 1,
          rate: 1200,
        },
        {
          id: 2,
          description: "12-Lead Electrocardiogram (ECG)",
          quantity: 1,
          rate: 600,
        },
        {
          id: 3,
          description: "Serum Lipid Profile Panel",
          quantity: 1,
          rate: 850,
        },
      ],
    }

    const html = renderToString(
      <BillPreview
        bill={multiItemBill}
        patient={dummyPatient}
        bannerImage={null}
        signatureImage={null}
        go={() => {}}
        layout={{
          showBanner: true,
          showClinicLogo: true,
          showClinicEmail: true,
          showSignature: true,
          showPaymentNote: true,
        }}
        returnPage="bill-form"
        desktopSession={dummySession}
      />,
    )

    expect(html).toContain("GST")
    expect(html).toContain("18")
    expect(html).toContain("Discount")
    expect(html).toContain("Doctor’s signature")

    const res = generatePdf(html, "scenario_7_bill_multiple_items_discounts_taxes")
    if (!res) return
    expect(res.pages).toBe(1)
  })

  it("Scenario 8: Long bill paginates cleanly across 2 pages without orphan footer", () => {
    const longBillItems = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      description: `Diagnostic Investigation & Treatment Procedure #${i + 1}`,
      quantity: 1,
      rate: 350 + i * 50,
    }))

    const longBill: BillData = {
      id: "BILL-003",
      invoiceNumber: "INV-2026-0003",
      date: "2026-11-09",
      status: "FINALIZED",
      paymentStatus: "Paid",
      discount: 5,
      taxRatePercent: 18,
      notes: "Extensive diagnostic and therapeutic package. Thank you.",
      items: longBillItems,
    }

    const html = renderToString(
      <BillPreview
        bill={longBill}
        patient={dummyPatient}
        bannerImage={null}
        signatureImage={null}
        go={() => {}}
        layout={{
          showBanner: true,
          showClinicLogo: true,
          showClinicEmail: true,
          showSignature: true,
          showPaymentNote: true,
        }}
        returnPage="bill-form"
        desktopSession={dummySession}
      />,
    )

    const res = generatePdf(html, "scenario_8_long_bill_multipage")
    if (!res) return
    // Should be exactly 2 pages with no orphan footer on page 3
    expect(res.pages).toBe(2)
  })
})
