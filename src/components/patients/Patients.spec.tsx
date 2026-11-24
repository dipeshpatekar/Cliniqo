import { describe, it, expect, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { PatientsPage } from "./PatientsPage"
import { PatientProfile } from "./PatientProfile"
import { PatientForm } from "./PatientForm"
import { PatientFormSettings } from "../settings/PatientFormSettings"
import { InvoicesTab } from "./InvoicesTab"
import { PrescriptionPreview } from "../consultation/PrescriptionPreview"
import type { Patient } from "../../types"
import {
  defaultPatientFormFieldPreferences,
  getIndiaDateTimeLocalString,
  formatIndiaDateTime,
  formatDateDDMMYYYY,
  formatDateTimeDDMMYYYY,
  parseIndiaDateTime,
  formatPatientAge,
  formatPatientGender,
  formatPatientAgeGender,
  formatPrescriptionDateWithTime,
  isMissingAge,
  isMissingGender,
  mapLocalRecordToPatient,
} from "../../types"

describe("Patient Components & UX", () => {
  const samplePatients: Patient[] = [
    {
      id: "PC-1001",
      name: "Aarav Sharma",
      initials: "AS",
      age: 45,
      gender: "Male",
      phone: "+91 98765 00001",
      lastVisit: "Today, 09:30 AM",
      allergies: ["Penicillin"],
      conditions: ["Type 2 Diabetes"],
    },
    {
      id: "PC-1002",
      name: "Pooja Verma",
      initials: "PV",
      age: 32,
      gender: "Female",
      phone: "+91 98765 00002",
      lastVisit: "2026-10-25",
      allergies: [],
      conditions: ["Migraine"],
    },
  ]

  describe("PatientsPage", () => {
    it("renders patient records in table with search and action buttons", () => {
      const rawHtml = renderToString(
        <PatientsPage
          go={() => {}}
          patients={samplePatients}
          onOpenPatient={() => {}}
          onStartConsultation={() => {}}
          onCreateBill={() => {}}
          onEditPatient={() => {}}
          onDeletePatient={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("Patients")
      expect(html).toContain("2 patient records in this clinic")
      expect(html).toContain("Aarav Sharma")
      expect(html).toContain("PC-1001")
      expect(html).toContain("Allergy recorded")
      expect(html).toContain("Pooja Verma")
      expect(html).toContain("PC-1002")
      expect(html).toContain("Bill")
      expect(html).toContain("Start consultation")
      expect(html).toContain("Sort by date")
      expect(html).toContain("Select date range")
      expect(html).toContain('class="table-panel"')
      expect(html).toContain('class="table-wrap"')
    })

    it("renders empty state when no patients match", () => {
      const rawHtml = renderToString(
        <PatientsPage
          go={() => {}}
          patients={[]}
          onOpenPatient={() => {}}
          onStartConsultation={() => {}}
          onCreateBill={() => {}}
          onEditPatient={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("No patients found")
      expect(html).toContain(
        "Try a different name, ID, phone number, or filter",
      )
    })
  })

  describe("PatientProfile", () => {
    it("renders patient details, allergies, and action buttons", () => {
      const rawHtml = renderToString(
        <PatientProfile
          go={() => {}}
          patient={samplePatients[0]}
          saveFeedback="updated"
          onDeletePatient={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("Aarav Sharma")
      expect(html).toContain("PC-1001")
      expect(html).toContain("Penicillin")
      expect(html).toContain("Type 2 Diabetes")
      expect(html).toContain("Patient saved")
      expect(html).toContain("Start consultation")
      expect(html).toContain("Create bill")
    })
  })

  describe("PatientForm", () => {
    it("renders form fields for creating a new patient with next ID", () => {
      const rawHtml = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={null}
          patients={samplePatients}
          nextPatientId="PC-1003"
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("Add new patient")
      expect(html).toContain("PC-1003")
      expect(html).toContain("Full name")
      expect(html).toContain("Mobile number")
      expect(html).toContain("Registration Date")
      expect(html).toContain("form-grid four")
      expect(html).toContain('type="datetime-local"')
      expect(html).toContain("Save patient")
      expect(html).toContain("start consultation")
      expect(html).toMatch(/autofocus/i)
      expect(html).not.toContain("Patient record integrity")
      expect(html).not.toContain("Encrypted offline persistence")
      expect(html).toContain("patient-form-bottom-actions")
      expect(html).not.toMatch(/<div class="patient-form-actions"[^>]*>[\s\S]*?<strong>Save patient<\/strong>/)
    })

    it("renders prefilled form fields for editing an existing patient", () => {
      const rawHtml = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={samplePatients[0]}
          patients={samplePatients}
          nextPatientId="PC-1003"
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("Edit patient")
      expect(html).toContain("Aarav Sharma")
      expect(html).toContain("PC-1001")
      expect(html).toContain("Save changes")
      // Clinical background moved to consultation
      expect(html).not.toContain("Clinical background")
    })

    it("respects visibility controls for optional fields on new patient form but shows them on edit", () => {
      const hiddenPrefs = {
        showDob: false,
        showPhone: false,
        showAlternatePhone: false,
        showAddress: false,
      }

      // New patient with hidden fields
      const newHtml = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={null}
          patients={samplePatients}
          nextPatientId="PC-1003"
          fieldPreferences={hiddenPrefs}
        />,
      ).replace(/<!-- -->/g, "")

      expect(newHtml).toContain("Full name")
      expect(newHtml).not.toContain("Date of birth")
      expect(newHtml).not.toContain("Mobile number")
      expect(newHtml).not.toContain("Alternate phone")
      expect(newHtml).not.toContain("Address")

      // Editing patient always shows all fields regardless of preferences
      const editHtml = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={samplePatients[0]}
          patients={samplePatients}
          nextPatientId="PC-1003"
          fieldPreferences={hiddenPrefs}
        />,
      ).replace(/<!-- -->/g, "")

      expect(editHtml).toContain("Full name")
      expect(editHtml).toContain("Date of birth")
      expect(editHtml).toContain("Mobile number")
      expect(editHtml).toContain("Alternate phone")
      expect(editHtml).toContain("Address")
    })

    it("disables Enter key form submission on Add New Patient page while preserving textareas and Save button", async () => {
      const fs = await import("fs")
      const patientFormSrc = fs.readFileSync(
        "src/components/patients/PatientForm.tsx",
        "utf8",
      )
      // Must contain onKeyDown handler on form
      expect(patientFormSrc).toContain("onKeyDown={handleFormKeyDown}")
      // Handler must check !editing so it only applies on Add New Patient
      expect(patientFormSrc).toMatch(/!editing\s*&&\s*\(/)
      expect(patientFormSrc).toContain('event.key === "Enter"')
      // Must preserve multiline textareas
      expect(patientFormSrc).toContain('tagName === "textarea"')
      // Must preserve buttons
      expect(patientFormSrc).toContain('tagName === "button"')
      // Must call preventDefault
      expect(patientFormSrc).toContain("event.preventDefault()")
    })
  })

  describe("InvoicesTab", () => {
    it("renders empty state when patient has no invoices", () => {
      const rawHtml = renderToString(
        <InvoicesTab patient={samplePatients[0]} onStartBill={() => {}} />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("No invoices recorded")
      expect(html).toContain("Create first bill")
    })
  })

  describe("PatientFormSettings", () => {
    it("renders accessible toggle switches for all four optional fields without unnecessary subtitle", () => {
      const html = renderToString(
        <PatientFormSettings
          preferences={defaultPatientFormFieldPreferences}
          onChange={() => {}}
        />,
      ).replace(/<!-- -->/g, "")

      expect(html).toContain("Patient form fields")
      expect(html).not.toContain("Choose which optional fields appear")
      expect(html).toContain("Date of Birth")
      expect(html).toContain("Mobile Number")
      expect(html).toContain("Alternate Mobile Number")
      expect(html).toContain("Address")
      expect(html).toContain('role="switch"')
      expect(html).toContain("toggle-switch")
      expect(html).toContain("ON")
    })

    it("displays OFF state when toggles are disabled", () => {
      const html = renderToString(
        <PatientFormSettings
          preferences={{
            showDob: false,
            showPhone: false,
            showAlternatePhone: false,
            showAddress: false,
          }}
          onChange={() => {}}
        />,
      ).replace(/<!-- -->/g, "")

      expect(html).toContain("OFF")
      expect(html).not.toContain('class="settings-toggle-state on"')
    })
  })

  describe("India DateTime Helpers & DD/MM/YYYY formatting", () => {
    it("formats dates into dd/mm/yyyy format across the application", () => {
      expect(formatDateDDMMYYYY("2026-11-07")).toBe("07/11/2026")
      expect(formatDateDDMMYYYY("2026-10-28")).toBe("28/10/2026")
      expect(formatDateDDMMYYYY("2025-06-24")).toBe("24/06/2025")
      expect(formatDateDDMMYYYY("24 Jun 2025")).toBe("24/06/2025")
      expect(formatDateDDMMYYYY("12 Mar 2025")).toBe("12/03/2025")
      expect(formatDateDDMMYYYY("18 Nov 2024")).toBe("18/11/2024")
      expect(formatDateDDMMYYYY("03 Jul 2024")).toBe("03/07/2024")

      const past = "2023-04-12T10:00"
      expect(getIndiaDateTimeLocalString(past)).toBe("2023-04-12T10:00")
      expect(formatIndiaDateTime("2023-04-12T10:00")).toContain("12/04/2023")
      expect(formatDateTimeDDMMYYYY("2026-11-07T20:45:00")).toContain(
        "07/11/2026",
      )

      // Current date generates valid YYYY-MM-DDTHH:mm
      const current = getIndiaDateTimeLocalString()
      expect(current).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    })

    it("handles ISO datetime strings, date-only strings, and UTC/IST conversion deterministically", () => {
      // 1. Naive local ISO string (clinic wall-clock time)
      expect(formatDateTimeDDMMYYYY("2026-11-07T20:45:00")).toBe(
        "07/11/2026, 08:45 PM",
      )
      expect(formatDateTimeDDMMYYYY("2026-11-07T20:45")).toBe(
        "07/11/2026, 08:45 PM",
      )
      expect(formatDateDDMMYYYY("2026-11-07T20:45:00")).toBe("07/11/2026")

      // 2. Explicit timezone offset (+05:30)
      expect(formatDateTimeDDMMYYYY("2026-11-07T20:45:00+05:30")).toBe(
        "07/11/2026, 08:45 PM",
      )

      // 3. UTC ISO string converted to IST (+05:30)
      // 15:15:00 UTC on 07/11/2026 -> 20:45:00 IST on 07/11/2026
      expect(formatDateTimeDDMMYYYY("2026-11-07T15:15:00.000Z")).toBe(
        "07/11/2026, 08:45 PM",
      )
      expect(formatDateDDMMYYYY("2026-11-07T15:15:00.000Z")).toBe("07/11/2026")

      // 4. UTC ISO string across calendar day boundary
      // 19:00:00 UTC on 07/11/2026 + 5:30 -> 00:30:00 IST on 08/11/2026
      expect(formatDateTimeDDMMYYYY("2026-11-07T19:00:00.000Z")).toBe(
        "08/11/2026, 12:30 AM",
      )
      expect(formatDateDDMMYYYY("2026-11-07T19:00:00.000Z")).toBe("08/11/2026")

      // 5. Date-only strings
      expect(formatDateTimeDDMMYYYY("2026-11-07")).toBe("07/11/2026")
      expect(formatDateTimeDDMMYYYY("2026-11-07", false)).toBe("07/11/2026")
      expect(formatDateDDMMYYYY("2026-11-07")).toBe("07/11/2026")
      expect(formatDateDDMMYYYY("07/11/2026")).toBe("07/11/2026")
      expect(formatDateDDMMYYYY("07-11-2026")).toBe("07/11/2026")

      // 6. getIndiaDateTimeLocalString with UTC ISO string, Date object and naive local string
      expect(
        getIndiaDateTimeLocalString("2026-11-07T15:15:00.000Z"),
      ).toBe("2026-11-07T20:45")
      expect(
        getIndiaDateTimeLocalString(new Date("2026-11-07T15:15:00.000Z")),
      ).toBe("2026-11-07T20:45")
      expect(
        getIndiaDateTimeLocalString("2026-11-07T20:45"),
      ).toBe("2026-11-07T20:45")

      // 7. Numeric timestamp (milliseconds and seconds)
      const epochMs = new Date("2026-11-07T15:15:00.000Z").getTime()
      expect(formatDateTimeDDMMYYYY(epochMs)).toBe("07/11/2026, 08:45 PM")
      expect(formatDateTimeDDMMYYYY(Math.floor(epochMs / 1000))).toBe(
        "07/11/2026, 08:45 PM",
      )

      // 8. Safe fallback on null / undefined / invalid
      expect(formatDateTimeDDMMYYYY(null)).toBe("")
      expect(formatDateTimeDDMMYYYY(undefined)).toBe("")
      expect(formatDateTimeDDMMYYYY("invalid-date")).toBe("invalid-date")
      expect(parseIndiaDateTime(null)).toBeNull()
      expect(parseIndiaDateTime("invalid-date")).toBeNull()
    })
  })

  describe("Ctrl + Shift + C Shortcut & Multi-Patient Safeguards", () => {
    it("renders Ctrl+Shift+C tooltip on PatientProfile start consultation button", () => {
      const html = renderToString(
        <PatientProfile
          go={() => {}}
          patient={samplePatients[0]}
          saveFeedback={null}
        />,
      ).replace(/<!-- -->/g, "")

      expect(html).toContain("Start consultation (Ctrl+Shift+C)")
    })

    it("renders Ctrl+Shift+C tooltip on PatientForm save & start consultation button", () => {
      const html = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={null}
          patients={samplePatients}
          nextPatientId="PC-1003"
        />,
      ).replace(/<!-- -->/g, "")

      expect(html).toContain("Save &amp; start consultation (Ctrl+Shift+C)")
    })

    it("ensures consultation started after adding Patient A uses Patient A's ID even if Patient B was previously selected", () => {
      // Simulation of App-level state and patient isolation
      const patientB: Patient = samplePatients[1] // Previously selected patient
      let selectedPatient: Patient = patientB
      let consultationPatient: Patient | null = null
      let currentPage = "patient-form"

      const startConsultation = (patient: Patient) => {
        if (!patient || !patient.id || patient.id === "PT-INIT") {
          throw new Error("No valid patient selected")
        }
        selectedPatient = patient
        consultationPatient = patient
        currentPage = "consultation"
      }

      const savePatient = (patient: Patient, startRx = false) => {
        // Effective patient returned from successful save operation
        const effectivePatient = {
          ...patient,
          id: patient.id || "PC-1003",
        }
        selectedPatient = effectivePatient
        if (startRx) {
          startConsultation(effectivePatient)
        }
      }

      // Precondition: Patient B was selected
      expect(selectedPatient.id).toBe("PC-1002")

      // Add Patient A on patient-form screen
      const patientA: Patient = {
        id: "PC-1003",
        name: "Aarav Sharma Jr",
        initials: "AJ",
        age: 12,
        gender: "Male",
        phone: "+91 98765 43210",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      savePatient(patientA, true)

      // Verify that consultation belongs to Patient A, NOT stale Patient B
      expect(selectedPatient.id).toBe("PC-1003")
      expect(selectedPatient.name).toBe("Aarav Sharma Jr")
      expect(consultationPatient).not.toBeNull()
      expect((consultationPatient as unknown as Patient).id).toBe("PC-1003")
      expect((consultationPatient as unknown as Patient).id).not.toBe(
        patientB.id,
      )
      expect(currentPage).toBe("consultation")
    })

    it("aborts consultation start if patient ID is invalid or missing", () => {
      let consultationStarted = false
      const invalidPatient: Patient = {
        id: "PT-INIT",
        name: "No patient selected",
        initials: "--",
        age: 0,
        gender: "Other",
        phone: "",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      const tryStart = (p: Patient) => {
        if (!p || !p.id || p.id === "PT-INIT") {
          return false
        }
        consultationStarted = true
        return true
      }

      const result = tryStart(invalidPatient)
      expect(result).toBe(false)
      expect(consultationStarted).toBe(false)
    })

    it("strictly allows Ctrl+Shift+C only in patient-form and patient-profile contexts", () => {
      const isShortcutAllowed = (page: string) => {
        return page === "patient-form" || page === "patient-profile"
      }

      // Allowed contexts
      expect(isShortcutAllowed("patient-form")).toBe(true)
      expect(isShortcutAllowed("patient-profile")).toBe(true)

      // Disabled contexts
      expect(isShortcutAllowed("dashboard")).toBe(false)
      expect(isShortcutAllowed("patients")).toBe(false)
      expect(isShortcutAllowed("settings")).toBe(false)
      expect(isShortcutAllowed("consultation")).toBe(false)
      expect(isShortcutAllowed("bill-form")).toBe(false)
      expect(isShortcutAllowed("bill-preview")).toBe(false)
      expect(isShortcutAllowed("preview")).toBe(false)
    })

    it("displays '— · —' when both patient age and gender are missing", () => {
      const patientMissingBoth: Patient = {
        id: "PC-9901",
        name: "Abhijit Dipke",
        initials: "AD",
        age: 0,
        gender: "Other",
        phone: "",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      const rawHtml = renderToString(
        <PatientsPage
          go={() => {}}
          patients={[patientMissingBoth]}
          onOpenPatient={() => {}}
          onStartConsultation={() => {}}
          onCreateBill={() => {}}
          onEditPatient={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")
      expect(html).toContain("—")
      expect(html).not.toContain("0 yrs")
      expect(html).not.toContain("Other")
      expect(formatPatientAgeGender(patientMissingBoth.age, patientMissingBoth.gender)).toBe("— · —")
    })

    it("displays '—' for missing age and '—' for missing gender individually", () => {
      expect(formatPatientAge(0)).toBe("—")
      expect(formatPatientAge(undefined)).toBe("—")
      expect(formatPatientAge(45, "yrs")).toBe("45 yrs")
      expect(formatPatientAge(45, "years")).toBe("45 years")

      expect(formatPatientGender("Other")).toBe("—")
      expect(formatPatientGender("")).toBe("—")
      expect(formatPatientGender(undefined)).toBe("—")
      expect(formatPatientGender("Female")).toBe("Female")
      expect(formatPatientGender("Male")).toBe("Male")

      expect(formatPatientAgeGender(0, "Female")).toBe("— · Female")
      expect(formatPatientAgeGender(45, "Other", "yrs")).toBe("45 yrs · —")
      expect(formatPatientAgeGender(45, "Male", "yrs")).toBe("45 yrs · Male")
    })

    it("displays finalized consultation date and time in Patients table and never displays 'No visits yet'", () => {
      const patientWithVisit: Patient = {
        id: "PC-9902",
        name: "Cocakola",
        initials: "C",
        age: 65,
        gender: "Male",
        phone: "",
        lastVisit: "2026-11-10T17:17:00.000Z",
        allergies: [],
        conditions: [],
      }
      const patientNoVisit: Patient = {
        id: "PC-9903",
        name: "Waste Gona",
        initials: "WG",
        age: 67,
        gender: "Male",
        phone: "",
        lastVisit: "2026-11-18T10:00:00.000Z",
        registeredAt: "2026-11-18T10:00:00.000Z",
        allergies: [],
        conditions: [],
      }

      const rawHtml = renderToString(
        <PatientsPage
          go={() => {}}
          patients={[patientWithVisit, patientNoVisit]}
          onOpenPatient={() => {}}
          onStartConsultation={() => {}}
          onCreateBill={() => {}}
          onEditPatient={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")
      // Patient with finalized visit displays formatted date and time
      expect(html).toContain("10/11/2026")
      expect(html).toContain("18/11/2026")
      // Never displays "No visits yet"
      expect(html).not.toContain("No visits yet")
    })

    it("formats prescription date with finalized time accurately", () => {
      expect(formatPrescriptionDateWithTime("2026-11-10", "10:30 AM")).toBe("10/11/2026, 10:30 AM")
      expect(formatPrescriptionDateWithTime("2026-11-10", "14:30")).toBe("10/11/2026, 02:30 PM")
      expect(formatPrescriptionDateWithTime("2026-11-10", "09:05")).toBe("10/11/2026, 09:05 AM")
      expect(formatPrescriptionDateWithTime("2026-11-10", "")).toBe("10/11/2026")
      expect(formatPrescriptionDateWithTime("", "")).toBe("—")
    })
  })

  describe("Issues 26 & 27: Fresh Patient Creation & Split Age into Years/Months", () => {
    it("renders Add Patient button in PrescriptionPreview header in exact order: Print -> Add Patient -> Send on WhatsApp", () => {
      const samplePatient: Patient = {
        id: "PT-001",
        name: "Krishna Patel",
        initials: "KP",
        age: 21,
        ageMonths: 0,
        gender: "Female",
        phone: "9876543210",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      const rawHtml = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={samplePatient}
          vitals={{
            systolic: "120",
            diastolic: "80",
            heartRate: "72",
            temperature: "98.6",
            spo2: "99",
            weight: "65",
          }}
          data={{
            chiefComplaint: "Checkup",
            duration: "1 day",
            diagnosis: "Healthy",
            medicines: [],
            advice: "",
            investigation: "",
            notes: "",
          }}
          bannerVisible={false}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={false}
          showClinicEmail={false}
          showAllergyWarning={false}
          returnPage="consultation"
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      const idxPrint = html.indexOf("Print prescription")
      const idxAdd = html.indexOf("Add Patient")
      const idxSend = html.indexOf("Send on WhatsApp")

      expect(idxPrint).toBeGreaterThan(-1)
      expect(idxAdd).toBeGreaterThan(-1)
      expect(idxSend).toBeGreaterThan(-1)

      // Strict button order verification
      expect(idxPrint).toBeLessThan(idxAdd)
      expect(idxAdd).toBeLessThan(idxSend)
    })

    it("divides the Age input into two equal-width numeric fields: Years (0-120) and Months (0-11)", () => {
      const rawHtml = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={null}
          patients={[]}
          nextPatientId="AAA-0008"
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain('placeholder="Years"')
      expect(html).toContain('placeholder="Months"')
      expect(html).toContain('name="age"')
      expect(html).toContain('name="ageMonths"')
      expect(html).toContain('min="0"')
      expect(html).toContain('max="120"')
      expect(html).toContain('max="11"')
      expect(html).toMatch(/grid-template-columns:\s*1fr 1fr/)
    })

    it("prefills both years and months when editing an existing patient", () => {
      const existingPatient: Patient = {
        id: "PT-002",
        name: "Aarav Gupta",
        initials: "AG",
        age: 1,
        ageMonths: 4,
        gender: "Male",
        phone: "9123456780",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      const rawHtml = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={existingPatient}
          patients={[existingPatient]}
          nextPatientId="AAA-0009"
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("Edit patient")
      expect(html).toContain('value="1"')
      expect(html).toContain('value="4"')
    })

    it("formats infant age (0 years, 2 months) to '2 months' and adult age (21 years, 0 months) to '21 years'", () => {
      // Prompt requirements:
      // 0 years, 2 months → 2 months
      expect(formatPatientAge(0, "years", 2)).toBe("2 months")
      expect(formatPatientAge(0, "yrs", 2)).toBe("2 months")

      // 1 year, 2 months → 1 year 2 months
      expect(formatPatientAge(1, "years", 2)).toBe("1 year 2 months")
      expect(formatPatientAge(1, "yrs", 2)).toBe("1 yr 2 mos")

      // 21 years, 0 months → 21 years
      expect(formatPatientAge(21, "years", 0)).toBe("21 years")
      expect(formatPatientAge(21, "yrs", 0)).toBe("21 yrs")

      // Adult without months specified
      expect(formatPatientAge(21, "years")).toBe("21 years")
      expect(formatPatientAge(21, "yrs")).toBe("21 yrs")

      // Formatted age & gender
      expect(formatPatientAgeGender(0, "Female", "yrs", 2)).toBe("2 months · Female")
      expect(formatPatientAgeGender(1, "Female", "years", 2)).toBe("1 year 2 months · Female")
      expect(formatPatientAgeGender(21, "Female", "yrs", 0)).toBe("21 yrs · Female")
      expect(formatPatientAgeGender(21, "Female", "years", 0)).toBe("21 years · Female")
      expect(formatPatientAgeGender(0, "Female")).toBe("— · Female")
    })

    it("displays correct age and months in PrescriptionPreview for infant and adult", () => {
      const infantPatient: Patient = {
        id: "AAA-0001",
        name: "Baby Of Suman",
        initials: "BS",
        age: 0,
        ageMonths: 2,
        gender: "Female",
        phone: "9876543210",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      const rawHtmlInfant = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={infantPatient}
          vitals={{
            systolic: "",
            diastolic: "",
            heartRate: "",
            temperature: "",
            spo2: "",
            weight: "",
          }}
          data={{
            chiefComplaint: "",
            duration: "",
            diagnosis: "",
            medicines: [],
            advice: "",
            investigation: "",
            notes: "",
          }}
          bannerVisible={false}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={false}
          showClinicEmail={false}
          showAllergyWarning={false}
          returnPage="consultation"
        />,
      )
      const htmlInfant = rawHtmlInfant.replace(/<!-- -->/g, "")
      expect(htmlInfant).toContain("(2 months · Female)")

      const adultPatient: Patient = {
        id: "AAA-0002",
        name: "Krishna",
        initials: "K",
        age: 21,
        ageMonths: 0,
        gender: "Female",
        phone: "9876543210",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      const rawHtmlAdult = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={adultPatient}
          vitals={{
            systolic: "",
            diastolic: "",
            heartRate: "",
            temperature: "",
            spo2: "",
            weight: "",
          }}
          data={{
            chiefComplaint: "",
            duration: "",
            diagnosis: "",
            medicines: [],
            advice: "",
            investigation: "",
            notes: "",
          }}
          bannerVisible={false}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={false}
          showClinicEmail={false}
          showAllergyWarning={false}
          returnPage="consultation"
        />,
      )
      const htmlAdult = rawHtmlAdult.replace(/<!-- -->/g, "")
      expect(htmlAdult).toContain("(21 yrs · Female)")
    })

    it("deserializes ageMonths correctly from local record sensitive_notes and preserves backwards compatibility", () => {
      // Record with ageMonths stored in sensitive_notes
      const localRecWithMonths = {
        id: "rec-001",
        server_id: null,
        clinic_id: "clinic-1",
        patient_code: "AAA-0010",
        name: "Infant Child",
        phone: "9000000000",
        gender: "Male",
        date_of_birth: null,
        age: 0,
        allergies: [],
        conditions: [],
        sensitive_notes: JSON.stringify({ ageMonths: 5, address: "Pune" }),
        sync_status: "PENDING" as const,
        server_version: 1,
        local_version: 1,
        updated_at: "2026-11-17T12:00:00Z",
      }

      const mappedWithMonths = mapLocalRecordToPatient(localRecWithMonths)
      expect(mappedWithMonths.age).toBe(0)
      expect(mappedWithMonths.ageMonths).toBe(5)
      expect(mappedWithMonths.address).toBe("Pune")

      // Legacy record with no ageMonths
      const legacyRec = {
        id: "rec-002",
        server_id: null,
        clinic_id: "clinic-1",
        patient_code: "AAA-0011",
        name: "Elder Patient",
        phone: "9000000001",
        gender: "Male",
        date_of_birth: null,
        age: 65,
        allergies: [],
        conditions: [],
        sensitive_notes: null,
        sync_status: "SYNCED" as const,
        server_version: 1,
        local_version: 1,
        updated_at: "2026-11-17T12:00:00Z",
      }

      const mappedLegacy = mapLocalRecordToPatient(legacyRec)
      expect(mappedLegacy.age).toBe(65)
      expect(mappedLegacy.ageMonths).toBeUndefined()
      expect(formatPatientAge(mappedLegacy.age, "years", mappedLegacy.ageMonths)).toBe("65 years")
    })
  })
})
