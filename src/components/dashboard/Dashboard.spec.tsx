import { describe, it, expect, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { Dashboard } from "./Dashboard"
import type { Patient } from "../../types"

describe("Dashboard Patient Creation & Real-Time Visibility", () => {
  const initialPatient: Patient = {
    id: "PT-001",
    displayId: "PT-001",
    name: "Aarav Sharma",
    initials: "AS",
    age: 32,
    gender: "Male",
    phone: "9876543210",
    lastVisit: "2026-10-15",
    allergies: [],
    conditions: ["Hypertension"],
  }

  const newlyAddedPatient: Patient = {
    id: "PT-002",
    displayId: "PT-002",
    name: "Priya Nair",
    initials: "PN",
    age: 28,
    gender: "Female",
    phone: "9811223344",
    lastVisit: "No visits yet",
    allergies: ["Penicillin"],
    conditions: [],
  }

  it("updates patient records count and displays newly added patient immediately", () => {
    // 1. Initial render with 1 patient
    const html1 = renderToString(
      <Dashboard
        go={vi.fn()}
        patients={[initialPatient]}
        onOpenPatient={vi.fn()}
      />,
    )

    // Patient record stat should be 1
    expect(html1).toContain("Patient records")
    expect(html1).toContain("<strong>1</strong>")
    expect(html1).toContain("Aarav Sharma")

    // 2. Simulate patient creation: rerender with both patients (newly added first)
    const rawHtml2 = renderToString(
      <Dashboard
        go={vi.fn()}
        patients={[newlyAddedPatient, initialPatient]}
        onOpenPatient={vi.fn()}
      />,
    )
    const html2 = rawHtml2.replace(/<!-- -->/g, "")

    // Updated patient count must immediately reflect 2
    expect(html2).toContain("<strong>2</strong>")

    // Panel title must say "Recent patients" when no consultations exist
    expect(html2).toContain("Recent patients")

    // Newly added patient must be displayed
    expect(html2).toContain("Priya Nair")
    expect(html2).toContain("PT-002 · 28 yrs")
    expect(html2).toContain("Newly registered patient")
    expect(html2).toContain("New Patient")
    expect(html2).toContain("Recently added")
  })

  it("renders empty state only when patient array is completely empty", () => {
    const html = renderToString(
      <Dashboard go={vi.fn()} patients={[]} onOpenPatient={vi.fn()} />,
    )

    expect(html).toContain("No patients or consultations recorded yet.")
    expect(html).toContain("<strong>0</strong>")
  })

  it("renders visible global patient search input in top-right header next to Add Patient button", () => {
    const rawHtml = renderToString(
      <Dashboard
        go={vi.fn()}
        patients={[initialPatient]}
        onOpenPatient={vi.fn()}
      />,
    )
    const html = rawHtml.replace(/<!-- -->/g, "")

    // Verify search input is present
    expect(html).toContain('id="global-patient-search"')
    expect(html).toContain("Search patient")
    expect(html).toContain("global-patient-search-bar")
    expect(html).toContain("Add patient")

    // Verify the search input appears immediately before Add patient in header-actions
    const searchIdx = html.indexOf("global-patient-search-container")
    const addPatientIdx = html.indexOf("Add patient")
    expect(searchIdx).toBeGreaterThan(0)
    expect(addPatientIdx).toBeGreaterThan(searchIdx)

    // Verify the old search icon button is removed
    expect(html).not.toContain('title="Search patients (Ctrl+K)"')
  })
})
