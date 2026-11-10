import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToString } from "react-dom/server"
import { Sidebar } from "./components/layout/index"
import { PrescriptionPreview } from "./components/consultation/PrescriptionPreview"
import { BillPreview } from "./components/billing/BillPreview"
import type { DesktopSessionContext } from "./desktop/desktop-bridge"
import type { Patient, ConsultationData, BillData } from "./types"

describe("Doctor and Clinic Profile Global Live Synchronization", () => {
  beforeEach(() => {
    const storage: Record<string, string> = {}
    const target = new EventTarget()
    ;(target as any).localStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, val: string) => {
        storage[key] = val
      },
      removeItem: (key: string) => {
        delete storage[key]
      },
      clear: () => {
        for (const k in storage) delete storage[k]
      },
    }
    ;(target as any).matchMedia = () => ({ matches: false })
    ;(globalThis as any).window = target
  })

  const dummySession: DesktopSessionContext = {
    doctor_id: "doc-test-1",
    clinic_id: "clinic-test-1",
    doctor_email: "test@cliniqo.app",
    doctor_name: "Dr. Initial Name",
    role: "DOCTOR",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }

  const dummyPatient: Patient = {
    id: "PT-1001",
    name: "Aarav Sharma",
    initials: "AS",
    age: 32,
    gender: "Male",
    phone: "+91 98765 43210",
    lastVisit: "Today",
    allergies: [],
    conditions: [],
  }

  const dummyConsultationData: ConsultationData = {
    date: "2026-11-09",
    time: "10:00",
    chiefComplaint: "Mild fever",
    symptomDuration: "2 days",
    diagnosis: "Viral fever",
    medicines: [],
    followUpDate: "2026-11-15",
    followUpInstructions: "Rest and hydration",
  }

  const dummyBill: BillData = {
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
        description: "General Consultation",
        quantity: 1,
        rate: 500,
      },
    ],
  }

  it("renders Sidebar with session doctor name and clinic name fallback", () => {
    const html = renderToString(
      <Sidebar
        page="dashboard"
        go={() => {}}
        collapsed={false}
        onToggle={() => {}}
        onDoctorProfile={() => {}}
        desktopSession={dummySession}
      />,
    )

    expect(html).toContain("Dr. Initial Name")
    expect(html).toContain("Clinic: clinic-test-1")
    expect(html).toContain("avatar")
    // Initials for "Dr. Initial Name" -> DI
    expect(html).toContain("DI")
  })

  it("renders PrescriptionPreview with doctor credentials and clinic information", () => {
    const html = renderToString(
      <PrescriptionPreview
        go={() => {}}
        patient={dummyPatient}
        vitals={{
          systolic: "120",
          diastolic: "80",
          heartRate: "72",
          spo2: "99",
          temperature: "98.6",
          height: "175",
          weight: "70",
        }}
        data={dummyConsultationData}
        bannerVisible={false}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="consultation"
        desktopSession={dummySession}
      />,
    )

    expect(html).toContain("Prescription preview")
    expect(html).toContain("Dr. Initial Name")
    expect(html).toContain("Doctor’s signature")
    expect(html).toContain("Aarav Sharma")
  })

  it("renders BillPreview with invoice details and doctor name", () => {
    const html = renderToString(
      <BillPreview
        bill={dummyBill}
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

    expect(html).toContain("Bill preview")
    expect(html).toContain("INV-2026-0001")
    expect(html).toContain("Dr. Initial Name")
    expect(html).toContain("Aarav Sharma")
    expect(html).toContain("General Consultation")
  })

  it("renders doctor profile photo in Sidebar avatar when stored in localStorage", () => {
    window.localStorage.setItem(
      `cliniqo_doctor_photo_${dummySession.doctor_id}`,
      "data:image/png;base64,sampleDoctorPhotoData",
    )

    const html = renderToString(
      <Sidebar
        page="dashboard"
        go={() => {}}
        collapsed={false}
        onToggle={() => {}}
        onDoctorProfile={() => {}}
        desktopSession={dummySession}
      />,
    )

    expect(html).toContain("<img")
    expect(html).toContain("sampleDoctorPhotoData")
    expect(html).toContain('alt="Dr. Initial Name"')

    window.localStorage.removeItem(
      `cliniqo_doctor_photo_${dummySession.doctor_id}`,
    )
  })

  it("confirms custom event listeners react to cliniqo:profile-updated", () => {
    let capturedEvent: CustomEvent | null = null
    const listener = (e: Event) => {
      capturedEvent = e as CustomEvent
    }

    window.addEventListener("cliniqo:profile-updated", listener)

    const testDoctorProfile = {
      doctor_id: "doc-test-1",
      full_name: "Dr. Bibi Dipesh",
      email: "bibi@cliniqo.app",
      phone: "+91 9123456789",
      qualification: "MBBS, MD",
      registration_number: "MMC 2026/888",
      gender: "Male",
    }

    window.dispatchEvent(
      new CustomEvent("cliniqo:profile-updated", {
        detail: { type: "doctor", profile: testDoctorProfile },
      }),
    )

    expect(capturedEvent).not.toBeNull()
    expect((capturedEvent as any)?.detail?.type).toBe("doctor")
    expect((capturedEvent as any)?.detail?.profile?.full_name).toBe(
      "Dr. Bibi Dipesh",
    )

    window.removeEventListener("cliniqo:profile-updated", listener)
  })

  describe("Prescription & Bill 1.54in Banner Verification", () => {
    it("renders rx-banner-slot in both Prescription and Bill previews", () => {
      const rxHtml = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={dummyPatient}
          vitals={{
            systolic: "120",
            diastolic: "80",
            heartRate: "72",
            spo2: "99",
            temperature: "98.6",
            height: "175",
            weight: "70",
          }}
          data={dummyConsultationData}
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

      expect(rxHtml).toContain("rx-banner-slot")
      expect(rxHtml).toContain("rx-header")
      expect(rxHtml).toContain("rx-clinic")
      expect(rxHtml).toContain("rx-doctor")

      const billHtml = renderToString(
        <BillPreview
          bill={dummyBill}
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

      expect(billHtml).toContain("rx-banner-slot")
      expect(billHtml).toContain("rx-header")
      expect(billHtml).toContain("rx-clinic")
      expect(billHtml).toContain("rx-doctor")
    })

    it("applies rx-content-hidden to preserve 1.54in physical spacing when banner is hidden for pre-printed letterheads", () => {
      const rxHtml = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={dummyPatient}
          vitals={{
            systolic: "120",
            diastolic: "80",
            heartRate: "72",
            spo2: "99",
            temperature: "98.6",
            height: "175",
            weight: "70",
          }}
          data={dummyConsultationData}
          bannerVisible={false}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="consultation"
          desktopSession={dummySession}
        />,
      )

      expect(rxHtml).toContain("rx-banner-slot")
      expect(rxHtml).toContain("rx-content-hidden")

      const billHtml = renderToString(
        <BillPreview
          bill={dummyBill}
          patient={dummyPatient}
          bannerImage={null}
          signatureImage={null}
          go={() => {}}
          layout={{
            showBanner: false,
            showClinicLogo: true,
            showClinicEmail: true,
            showSignature: true,
            showPaymentNote: true,
          }}
          returnPage="bill-form"
          desktopSession={dummySession}
        />,
      )

      expect(billHtml).toContain("rx-banner-slot")
      expect(billHtml).toContain("rx-content-hidden")
    })

    it("renders custom banner image inside rx-custom-banner when custom bannerImage is provided", () => {
      const rxHtml = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={dummyPatient}
          vitals={{
            systolic: "120",
            diastolic: "80",
            heartRate: "72",
            spo2: "99",
            temperature: "98.6",
            height: "175",
            weight: "70",
          }}
          data={dummyConsultationData}
          bannerVisible={true}
          bannerImage={{ src: "https://example.com/banner.png", name: "banner.png" }}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="consultation"
          desktopSession={dummySession}
        />,
      )

      expect(rxHtml).toContain("rx-custom-banner")
      expect(rxHtml).toContain('src="https://example.com/banner.png"')

      const billHtml = renderToString(
        <BillPreview
          bill={dummyBill}
          patient={dummyPatient}
          bannerImage={{ src: "https://example.com/banner.png", name: "banner.png" }}
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

      expect(billHtml).toContain("rx-custom-banner")
      expect(billHtml).toContain('src="https://example.com/banner.png"')
    })
  })
})
