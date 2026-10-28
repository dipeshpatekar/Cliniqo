import { describe, it, expect } from "vitest"
import { renderToString } from "react-dom/server"
import { PatientsPage } from "./PatientsPage"
import { PatientProfile } from "./PatientProfile"
import { PatientForm } from "./PatientForm"
import { InvoicesTab } from "./InvoicesTab"
import type { Patient } from "../../types"

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
      expect(html).toContain("Save patient")
      expect(html).toContain("start consultation")
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
    })
  })

  describe("InvoicesTab", () => {
    it("renders empty state when patient has no invoices", () => {
      const rawHtml = renderToString(
        <InvoicesTab
          patient={samplePatients[0]}
          invoices={[]}
          onCreateBill={() => {}}
          onViewInvoice={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("No invoices recorded")
      expect(html).toContain("Create first bill")
    })
  })
})
