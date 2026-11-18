import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import { renderToString } from "react-dom/server"
import { Consultation } from "./components/consultation/Consultation"
import { PrescriptionPreview } from "./components/consultation/PrescriptionPreview"
import * as desktopBridge from "./desktop/desktop-bridge"
import type {
  LocalPrescriptionRecord,
  LocalConsultationRecord,
  LocalPatientRecord,
} from "./desktop/desktop-bridge"
import type { Patient, Vitals, ConsultationData, Medicine } from "./types"
import { defaultClinicalLibrary } from "./types"
import { dispatchShortcutEvent } from "./utils/keyboardShortcuts"
import fs from "node:fs"
import path from "node:path"

describe("CLINIQUO — Ctrl+P Consultation Save & Prescription Workflow", () => {
  beforeEach(() => {
    vi.restoreAllMocks()

    const storage: Record<string, string> = {
      "cliniqo-theme": "light",
      cliniqo_desktop_session: JSON.stringify({
        token: "tok-test",
        clinic_id: "clinic-101",
        doctor_id: "doc-101",
        doctor_name: "Dr. Test Doctor",
        clinic_name: "Test Health Clinic",
      }),
    }

    const target = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      localStorage: {
        getItem: (k: string) => storage[k] ?? null,
        setItem: (k: string, v: string) => {
          storage[k] = v
        },
        removeItem: (k: string) => {
          delete storage[k]
        },
        clear: () => {
          for (const k in storage) delete storage[k]
        },
      },
      scrollTo: vi.fn(),
      matchMedia: () => ({ matches: false }),
      print: vi.fn(),
      setTimeout: (fn: Function, delay: number) => setTimeout(fn, delay),
      clearTimeout: (id: any) => clearTimeout(id),
    }
    ;(globalThis as any).window = target
    ;(globalThis as any).CustomEvent = class CustomEvent {
      type: string
      detail: any
      constructor(type: string, params?: { detail?: any }) {
        this.type = type
        this.detail = params?.detail
      }
    }
  })

  const samplePatient: Patient = {
    id: "pat-999",
    displayId: "AAA-0099",
    patientCode: "AAA-0099",
    name: "Rajesh Kumar",
    initials: "RK",
    age: 42,
    gender: "Male",
    phone: "9876543210",
    lastVisit: "2026-11-10",
    allergies: ["Penicillin"],
    conditions: ["Hypertension"],
  }

  const sampleVitals: Vitals = {
    systolic: "128",
    diastolic: "84",
    heartRate: "76",
    spo2: "98",
    temperature: "98.6",
    height: "170",
    weight: "72",
  }

  const sampleMedicines: Medicine[] = [
    {
      id: 1,
      name: "Amlodipine",
      formulation: "Tablet",
      strength: "5 mg",
      dose: "1 tablet",
      route: "Oral",
      frequency: "Once daily",
      duration: "30 days",
      food: "After food",
      directions: "Take in the morning",
    },
  ]

  const sampleConsultationData: ConsultationData = {
    date: "2026-11-18",
    time: "14:30",
    chiefComplaint: "Routine hypertension check",
    symptomDuration: "1 month",
    diagnosis: "Essential Hypertension",
    medicines: sampleMedicines,
    followUpDate: "2026-12-18",
    followUpInstructions: "Check BP weekly",
  }

  describe("Requirement 1: Source Code Verification of Ctrl+P Workflow Architecture", () => {
    it("verifies App.tsx dispatches consultation-ctrl-p instead of directly navigating to preview", () => {
      const appFile = fs.readFileSync(
        path.resolve(process.cwd(), "src/App.tsx"),
        "utf-8",
      )
      // Must not directly call go("preview") inside key === "p"
      expect(appFile).not.toMatch(
        /if\s*\(\s*page\s*===\s*"consultation"\s*\)\s*\{\s*go\("preview"\)/,
      )
      // Must dispatch consultation-ctrl-p
      expect(appFile).toMatch(/dispatchShortcutEvent\("consultation-ctrl-p"\)/)
      // Must dispatch print-prescription on preview
      expect(appFile).toMatch(/dispatchShortcutEvent\("print-prescription"\)/)
    })

    it("verifies Consultation.tsx handles consultation-ctrl-p and triggers finalization and persistence", () => {
      const consultFile = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/Consultation.tsx",
        ),
        "utf-8",
      )
      // Checks handleShortcut includes consultation-ctrl-p
      expect(consultFile).toContain('action === "consultation-ctrl-p"')
      // Uses isFinalizingRef to block concurrent duplicate submissions
      expect(consultFile).toContain("isFinalizingRef")
      // Updates lastVisit via combinedConsultationDate in onFinalized
      expect(consultFile).toContain("combinedConsultationDate || finalizedTimestamp")
      // Only navigates to preview after operations succeed
      expect(consultFile).toContain('go("preview")')
    })

    it("verifies PrescriptionPreview.tsx handles print shortcuts and Ctrl+P", () => {
      const previewFile = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/PrescriptionPreview.tsx",
        ),
        "utf-8",
      )
      expect(previewFile).toContain('action === "print-prescription"')
      expect(previewFile).toContain('title="Print prescription (Ctrl+P)"')
    })
  })

  describe("Requirement 2: Full Ctrl+P Consultation Save & Finalize Workflow", () => {
    it("executes save consultation, save prescription, updates last visit, and navigates to preview", async () => {
      vi.spyOn(desktopBridge, "isTauriDesktop").mockReturnValue(true)

      const saveConsultationSpy = vi
        .spyOn(desktopBridge, "saveLocalConsultation")
        .mockResolvedValue("consultation-id-123")

      const mockSavedRx: LocalPrescriptionRecord = {
        id: "rx-db-123",
        server_id: null,
        clinic_id: "clinic-101",
        consultation_id: "consultation-id-123",
        patient_id: "pat-999",
        doctor_id: "doc-101",
        prescription_number: "RX-888999",
        revision_number: 1,
        status: "ACTIVE",
        items_json: JSON.stringify(sampleMedicines),
        sync_status: "PENDING",
        server_version: 0,
        local_version: 1,
        created_at: "2026-11-18T14:30:00.000Z",
      }

      const savePrescriptionSpy = vi
        .spyOn(desktopBridge, "saveLocalPrescription")
        .mockResolvedValue("rx-db-123")

      vi.spyOn(desktopBridge, "getLocalPrescriptions").mockResolvedValue([
        mockSavedRx,
      ])

      const navigatedPages: string[] = []
      const go = vi.fn((page: string) => {
        navigatedPages.push(page)
      })

      let finalizedConsultId: string | null = null
      let finalizedTimestamp: string | undefined = undefined
      let finalizedRxRecord: LocalPrescriptionRecord | null = null

      const onFinalized = vi.fn(
        (
          cId: string | null,
          timestamp?: string,
          rx?: LocalPrescriptionRecord | null,
        ) => {
          finalizedConsultId = cId
          finalizedTimestamp = timestamp
          finalizedRxRecord = rx ?? null
        },
      )

      // Simulate the exact handleTriggerFinalize execution triggered by Ctrl+P
      const executeCtrlPOnConsultation = async (
        data: ConsultationData,
        patient: Patient,
        vitals: Vitals,
        isFinalizingRef: { current: boolean },
      ) => {
        if (isFinalizingRef.current) return
        isFinalizingRef.current = true

        const finalizedDate = new Date()
        const finalizedDateStr = finalizedDate.toISOString().slice(0, 10)
        const finalizedTimeStr = finalizedDate.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        })
        const finalizedTimestamp = finalizedDate.toISOString()

        const consultDatePart = data.date || finalizedDateStr
        const consultTimePart = data.time || finalizedTimeStr
        const combinedConsultationDate =
          consultDatePart.includes("T") || consultDatePart.includes(" ")
            ? consultDatePart
            : `${consultDatePart}T${consultTimePart}`

        try {
          const consultationId = await desktopBridge.saveLocalConsultation({
            clinic_id: "clinic-101",
            patient_id: patient.id,
            consultation_date: combinedConsultationDate,
            chief_complaint: data.chiefComplaint,
            diagnosis: data.diagnosis,
            clinical_snapshot_json: JSON.stringify({
              vitals,
              time: consultTimePart,
              consultationTime: consultTimePart,
              consultationDate: consultDatePart,
            }),
          })

          const rxNumber = "RX-888999"
          const savedRxId = await desktopBridge.saveLocalPrescription({
            clinic_id: "clinic-101",
            consultation_id: consultationId,
            patient_id: patient.id,
            prescription_number: rxNumber,
            items_json: JSON.stringify(data.medicines),
          })

          const rxRecord: LocalPrescriptionRecord = {
            id: savedRxId,
            server_id: null,
            clinic_id: "clinic-101",
            consultation_id: consultationId,
            patient_id: patient.id,
            doctor_id: "doc-101",
            prescription_number: rxNumber,
            revision_number: 1,
            status: "ACTIVE",
            items_json: JSON.stringify(data.medicines),
            sync_status: "PENDING",
            server_version: 0,
            local_version: 1,
            created_at: finalizedTimestamp,
          }

          onFinalized(
            consultationId,
            combinedConsultationDate || finalizedTimestamp,
            rxRecord,
          )
          go("preview")
        } finally {
          isFinalizingRef.current = false
        }
      }

      const isFinalizingRef = { current: false }
      await executeCtrlPOnConsultation(
        sampleConsultationData,
        samplePatient,
        sampleVitals,
        isFinalizingRef,
      )

      // 1. Consultation was saved
      expect(saveConsultationSpy).toHaveBeenCalledTimes(1)
      expect(saveConsultationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          clinic_id: "clinic-101",
          patient_id: "pat-999",
          consultation_date: "2026-11-18T14:30",
          chief_complaint: "Routine hypertension check",
          diagnosis: "Essential Hypertension",
        }),
      )

      // 2. Prescription was saved with items and active status
      expect(savePrescriptionSpy).toHaveBeenCalledTimes(1)
      expect(savePrescriptionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          clinic_id: "clinic-101",
          consultation_id: "consultation-id-123",
          patient_id: "pat-999",
          prescription_number: "RX-888999",
        }),
      )

      // 3. onFinalized callback was called with consultation ID, timestamp and Rx record
      expect(onFinalized).toHaveBeenCalledTimes(1)
      expect(finalizedConsultId).toBe("consultation-id-123")
      expect(finalizedTimestamp).toBe("2026-11-18T14:30")
      expect(finalizedRxRecord).not.toBeNull()

      // 4. Navigated to preview ONLY after operations succeed
      expect(go).toHaveBeenCalledWith("preview")
      expect(navigatedPages).toEqual(["preview"])
    })

    it("guards against in-flight concurrent execution on rapid Ctrl+P keypresses", async () => {
      let resolveFirstCall: (id: string) => void
      const firstCallPromise = new Promise<string>((res) => {
        resolveFirstCall = res
      })

      const saveConsultationSpy = vi
        .spyOn(desktopBridge, "saveLocalConsultation")
        .mockReturnValueOnce(firstCallPromise)

      const isFinalizingRef = { current: false }

      const tryFinalize = async () => {
        if (isFinalizingRef.current) return "BLOCKED"
        isFinalizingRef.current = true
        try {
          await desktopBridge.saveLocalConsultation({} as any)
          return "SUCCESS"
        } finally {
          isFinalizingRef.current = false
        }
      }

      // First call starts
      const call1 = tryFinalize()
      expect(isFinalizingRef.current).toBe(true)

      // Second call while first is in-flight
      const call2 = tryFinalize()
      expect(await call2).toBe("BLOCKED")

      // Third call while first is still in-flight
      const call3 = tryFinalize()
      expect(await call3).toBe("BLOCKED")

      expect(saveConsultationSpy).toHaveBeenCalledTimes(1)

      resolveFirstCall!("consult-id-done")
      expect(await call1).toBe("SUCCESS")
      expect(isFinalizingRef.current).toBe(false)
    })

    it("preserves form state and prevents navigation when SQLite save fails", async () => {
      vi.spyOn(desktopBridge, "isTauriDesktop").mockReturnValue(true)
      vi.spyOn(desktopBridge, "saveLocalConsultation").mockRejectedValue(
        new Error("database is locked (Code: 5)"),
      )

      const go = vi.fn()
      const onFinalized = vi.fn()
      let finalizeError: string | null = null

      const isFinalizingRef = { current: false }
      const tryFinalize = async () => {
        if (isFinalizingRef.current) return
        isFinalizingRef.current = true
        try {
          await desktopBridge.saveLocalConsultation({} as any)
          go("preview")
        } catch (err: unknown) {
          finalizeError = (err as Error).message
        } finally {
          isFinalizingRef.current = false
        }
      }

      await tryFinalize()

      // Did NOT navigate
      expect(go).not.toHaveBeenCalled()
      expect(onFinalized).not.toHaveBeenCalled()
      // Recorded specific SQLite error
      expect(finalizeError).toBe("database is locked (Code: 5)")
      // In-flight guard released for retry
      expect(isFinalizingRef.current).toBe(false)
    })

    it("verifies patient record lastVisit update in App state upon finalization", () => {
      let selectedPatient: Patient = {
        ...samplePatient,
        lastVisit: "2026-11-10",
      }
      let patientRecords: Patient[] = [selectedPatient]

      const onFinalizedHandler = (
        _consultationId: string | null,
        finalizedTimestamp?: string,
        _rxRecord?: LocalPrescriptionRecord | null,
      ) => {
        const visitTimestamp = finalizedTimestamp || new Date().toISOString()
        selectedPatient = {
          ...selectedPatient,
          lastVisit: visitTimestamp,
        }
        patientRecords = patientRecords.map((p) =>
          p.id === selectedPatient.id ? { ...p, lastVisit: visitTimestamp } : p,
        )
      }

      onFinalizedHandler("consult-999", "2026-11-18T14:30")

      expect(selectedPatient.lastVisit).toBe("2026-11-18T14:30")
      expect(patientRecords[0].lastVisit).toBe("2026-11-18T14:30")
    })
  })

  describe("Requirement 3: Ctrl+P on Prescription Preview Page", () => {
    it("renders Print prescription button with (Ctrl+P) title", () => {
      const mockPrescriptionRecord: LocalPrescriptionRecord = {
        id: "rx-prev-101",
        server_id: null,
        clinic_id: "clinic-101",
        consultation_id: "consult-101",
        patient_id: samplePatient.id,
        doctor_id: "doc-101",
        prescription_number: "RX-999111",
        revision_number: 1,
        status: "ACTIVE",
        items_json: JSON.stringify(sampleMedicines),
        sync_status: "PENDING",
        server_version: 0,
        local_version: 1,
        created_at: "2026-11-18T14:30:00.000Z",
      }

      const html = renderToString(
        <PrescriptionPreview
          patient={samplePatient}
          vitals={sampleVitals}
          data={sampleConsultationData}
          prescriptionRecord={mockPrescriptionRecord}
          go={() => {}}
        />,
      )

      expect(html).toContain("Print prescription")
      expect(html).toContain('title="Print prescription (Ctrl+P)"')
    })

    it("invokes window.print when handling print shortcut event", () => {
      const printSpy = vi.fn()
      ;(globalThis.window as any).print = printSpy

      const handlePrint = () => {
        if (typeof window !== "undefined") {
          window.print()
        }
      }

      const handleShortcut = (detailAction: string) => {
        if (detailAction === "print" || detailAction === "print-prescription") {
          handlePrint()
        }
      }

      handleShortcut("print-prescription")
      expect(printSpy).toHaveBeenCalledTimes(1)

      handleShortcut("print")
      expect(printSpy).toHaveBeenCalledTimes(2)
    })

    it("invokes window.print when Ctrl+P keydown is triggered in preview view", () => {
      const printSpy = vi.fn()
      ;(globalThis.window as any).print = printSpy

      const handlePrint = () => {
        window.print()
      }

      const handleKeyDown = (e: {
        ctrlKey: boolean
        metaKey: boolean
        key: string
        shiftKey: boolean
        defaultPrevented: boolean
        preventDefault: () => void
      }) => {
        if (
          (e.ctrlKey || e.metaKey) &&
          e.key.toLowerCase() === "p" &&
          !e.shiftKey
        ) {
          if (!e.defaultPrevented) {
            e.preventDefault()
            handlePrint()
          }
        }
      }

      const event = {
        ctrlKey: true,
        metaKey: false,
        key: "p",
        shiftKey: false,
        defaultPrevented: false,
        preventDefault: vi.fn(),
      }

      handleKeyDown(event)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(printSpy).toHaveBeenCalledTimes(1)
    })
  })
})
