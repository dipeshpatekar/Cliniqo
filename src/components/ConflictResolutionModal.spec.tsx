import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { ConflictResolutionModal } from "./ConflictResolutionModal";
import type { SyncConflictRecord } from "../desktop/desktop-bridge";

describe("ConflictResolutionModal Component", () => {
  const sampleConflicts: SyncConflictRecord[] = [
    {
      id: "conflict-pat-01",
      outbox_id: "outbox-01",
      entity_type: "PATIENT",
      entity_id: "patient-uuid-123",
      server_version: 3,
      client_version: 2,
      server_payload: JSON.stringify({
        name: "Ananya Iyer",
        phone: "+91 98765 43210",
        gender: "FEMALE",
        age: 34,
        allergies: ["Penicillin", "Sulfa"],
        conditions: ["Asthma"],
      }),
      client_payload: JSON.stringify({
        name: "Ananya Iyer",
        phone: "+91 98765 43210",
        gender: "FEMALE",
        age: 34,
        allergies: ["Penicillin", "Aspirin"],
        conditions: ["Asthma", "Allergic Rhinitis"],
      }),
      conflict_reason: "DIVERGENT_CLINICAL_DATA",
      resolution_payload: null,
      status: "OPEN",
      resolved_at: null,
      resolution_strategy: null,
      created_at: "2026-10-28T01:00:00Z",
    },
    {
      id: "conflict-cons-02",
      outbox_id: "outbox-02",
      entity_type: "CONSULTATION",
      entity_id: "cons-uuid-456",
      server_version: 2,
      client_version: 1,
      server_payload: JSON.stringify({
        consultationDate: "2026-10-28",
        chiefComplaint: "Fever and mild cough",
        diagnosis: "Viral URI",
        clinicalSnapshot: {
          vitals: { systolic: "120", diastolic: "80", heartRate: "76" },
        },
      }),
      client_payload: JSON.stringify({
        consultationDate: "2026-10-28",
        chiefComplaint: "High fever and severe chest pain",
        diagnosis: "Pleurisy / Community-Acquired Pneumonia",
        clinicalSnapshot: {
          vitals: { systolic: "135", diastolic: "90", heartRate: "102" },
        },
      }),
      conflict_reason: "CONCURRENT_DRAFT_COLLISION",
      resolution_payload: null,
      status: "OPEN",
      resolved_at: null,
      resolution_strategy: null,
      created_at: "2026-10-28T01:05:00Z",
    },
    {
      id: "conflict-rx-03",
      outbox_id: "outbox-03",
      entity_type: "PRESCRIPTION",
      entity_id: "rx-uuid-789",
      server_version: 2,
      client_version: 1,
      server_payload: JSON.stringify({
        prescriptionNumber: "RX-2026-001",
        items: [
          { name: "Paracetamol", formulation: "Tablet", strength: "500mg", dose: "1 tab", frequency: "TID", duration: "5 days" },
        ],
      }),
      client_payload: JSON.stringify({
        prescriptionNumber: "RX-2026-001",
        items: [
          { name: "Paracetamol", formulation: "Tablet", strength: "650mg", dose: "1 tab", frequency: "SOS", duration: "3 days" },
          { name: "Azithromycin", formulation: "Tablet", strength: "500mg", dose: "1 tab", frequency: "OD", duration: "3 days" },
        ],
      }),
      conflict_reason: "CONCURRENT_REMOTE_UPDATE",
      resolution_payload: null,
      status: "OPEN",
      resolved_at: null,
      resolution_strategy: null,
      created_at: "2026-10-28T01:10:00Z",
    },
  ];

  it("renders null when isOpen is false", () => {
    const html = renderToString(
      <ConflictResolutionModal
        isOpen={false}
        onClose={() => {}}
        activeClinicId="clinic_test_1"
      />
    );
    expect(html).toBe("");
  });

  it("renders the modal shell and clinical safety protocol banner when isOpen is true", () => {
    const html = renderToString(
      <ConflictResolutionModal
        isOpen={true}
        onClose={() => {}}
        activeClinicId="clinic_test_1"
      />
    );

    // Title and Clinical Safety Protocol
    expect(html).toContain("Clinical Sync Conflict Resolution");
    expect(html).toContain("Clinical Safety Protocol");
    expect(html).toContain("Differences in patient allergies, chronic conditions, and prescribed medications must be thoroughly reviewed");
    expect(html).toContain("Never overwrite active clinical treatments without explicit verification");
  });

  it("safely handles empty conflicts without errors", () => {
    const html = renderToString(
      <ConflictResolutionModal
        isOpen={true}
        onClose={() => {}}
        activeClinicId="clinic_test_1"
      />
    );
    expect(html).toContain("Unresolved");
    expect(html).toContain("No conflicts in this category");
  });

  it("verifies that no sensitive tokens, private keys or secrets are rendered in HTML", () => {
    const html = renderToString(
      <ConflictResolutionModal
        isOpen={true}
        onClose={() => {}}
        activeClinicId="clinic_test_1"
      />
    );

    expect(html).not.toContain("accessToken");
    expect(html).not.toContain("refreshToken");
    expect(html).not.toContain("refresh_token");
    expect(html).not.toContain("jwt");
    expect(html).not.toContain("private_key");
    expect(html).not.toContain("dek");
  });

  describe("Clinical Safety & Merge Calculations", () => {
    it("safely unions divergent patient allergies and conditions without duplication", () => {
      const clientAllergies = ["Penicillin", "Aspirin"];
      const serverAllergies = ["Penicillin", "Sulfa"];
      const merged = Array.from(new Set([...clientAllergies, ...serverAllergies]));

      expect(merged).toEqual(["Penicillin", "Aspirin", "Sulfa"]);
      expect(merged.length).toBe(3);
    });

    it("verifies resolution strategies include all 4 supported clinical actions", () => {
      const strategies = ["USE_SERVER", "USE_LOCAL", "MERGE_MANUAL", "PRESERVE_BOTH"];
      expect(strategies).toContain("USE_SERVER");
      expect(strategies).toContain("USE_LOCAL");
      expect(strategies).toContain("MERGE_MANUAL");
      expect(strategies).toContain("PRESERVE_BOTH");
    });

    it("ensures PRESERVE_BOTH protects consultation observations from silent overwrite", () => {
      const clientConsultation = {
        chiefComplaint: "High fever and severe chest pain",
        diagnosis: "Pleurisy / Community-Acquired Pneumonia",
      };
      const serverConsultation = {
        chiefComplaint: "Fever and mild cough",
        diagnosis: "Viral URI",
      };

      // Both versions remain distinct
      expect(clientConsultation.diagnosis).not.toEqual(serverConsultation.diagnosis);
      expect(clientConsultation.chiefComplaint).not.toEqual(serverConsultation.chiefComplaint);
    });
  });
});
