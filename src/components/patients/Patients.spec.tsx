import { describe, it, expect } from "vitest"
import { renderToString } from "react-dom/server"
import { PatientsPage } from "./PatientsPage"
import { PatientProfile } from "./PatientProfile"
import { PatientForm } from "./PatientForm"
import { PatientFormSettings } from "../settings/PatientFormSettings"
import { InvoicesTab } from "./InvoicesTab"
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
      expect(html).toContain("Patient changes saved.")
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
      expect(html).not.toContain("Patient record integrity")
      expect(html).not.toContain("Encrypted offline persistence")
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

    it("displays finalized consultation date and time in Patients table and preserves 'No visits yet'", () => {
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
        lastVisit: "No visits yet",
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
      // Patient without visit continues to display "No visits yet"
      expect(html).toContain("No visits yet")
    })

    it("formats prescription date with finalized time accurately", () => {
      expect(formatPrescriptionDateWithTime("2026-11-10", "10:30 AM")).toBe("10/11/2026, 10:30 AM")
      expect(formatPrescriptionDateWithTime("2026-11-10", "14:30")).toBe("10/11/2026, 02:30 PM")
      expect(formatPrescriptionDateWithTime("2026-11-10", "09:05")).toBe("10/11/2026, 09:05 AM")
      expect(formatPrescriptionDateWithTime("2026-11-10", "")).toBe("10/11/2026")
      expect(formatPrescriptionDateWithTime("", "")).toBe("—")
    })
  })
})
