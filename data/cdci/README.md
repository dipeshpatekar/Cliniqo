# Common Drug Codes for India (CDCI) — Dataset Setup & Licensing Guide

This directory documents the reference medicine terminology dataset used by Cliniqo for catalogue search, auto-strength resolution, and clinical prescription verification.

---

## 1. Dataset Overview

The **Common Drug Codes for India (CDCI)** is published by the **National Resource Centre for EHR Standards (NRCeS)** at the **Centre for Development of Advanced Computing (C-DAC), Pune**.

The package contains 7 Tab-Separated Value (TSV) master files:
1. `GenericMaster.txt` — Unique generic concepts, dose forms, and routes.
2. `BrandMaster.txt` — Commercial brand names mapped to generic identifiers.
3. `ProductMaster.txt` — Formulated clinical products.
4. `SubstanceMaster.txt` — Active pharmaceutical substances.
5. `SupplierMaster.txt` — Pharmaceutical manufacturers and suppliers.
6. `DrugFormMaster.txt` — Standard dosage forms (tablets, capsules, syrups, etc.).
7. `RouteOfAdministrationMaster.txt` — Clinical routes (oral, intravenous, topical, etc.).

---

## 2. Licensing, Attribution & Territorial Scope

- **Primary License:** Creative Commons Attribution 4.0 International ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
- **SNOMED CT® Terms:** Contains concepts and terms from the SNOMED CT International Release. Use is governed by the SNOMED CT Affiliate License extended to users of this package.
- **Territorial Restriction:** Authorized for implementation and deployment **within India**.
- **Data Protection:** The raw flat files contain proprietary brand references and are strictly excluded from git tracking (`.gitignore`), client-side bundles, and public repositories.

---

## 3. Fresh Development Environment Setup

When cloning or setting up a fresh development machine:

1. Obtain the official `CommonDrugCodesForIndia_FlatFilePackage.zip` from the authorized NRCeS portal ([https://www.nrces.in](https://www.nrces.in)).
2. Unpack the flat files into:
   ```bash
   data/cdci/CommonDrugCodesForIndia_FlatFilePackage/
   ```
   Expected files:
   ```
   data/cdci/CommonDrugCodesForIndia_FlatFilePackage/
   ├── BrandMaster.txt
   ├── DrugFormMaster.txt
   ├── GenericMaster.txt
   ├── License.txt
   ├── ProductMaster.txt
   ├── README.txt
   ├── RouteOfAdministrationMaster.txt
   ├── SubstanceMaster.txt
   └── SupplierMaster.txt
   ```
3. Alternatively, if the dataset is stored in a custom path (e.g. `~/Downloads/CommonDrugCodesForIndia_FlatFilePackage/` or a network drive), set the environment variable:
   ```bash
   export CDCI_DATA_DIR="/path/to/CommonDrugCodesForIndia_FlatFilePackage"
   ```

---

## 4. Continuous Integration (CI) Configuration

In automated CI environments:
- Set `CDCI_DATA_DIR` pointing to a cached copy of the dataset:
  ```yaml
  env:
    CDCI_DATA_DIR: ${{ github.workspace }}/data/cdci/CommonDrugCodesForIndia_FlatFilePackage
  ```
- Or run the dry-run validation using synthetic or mocked test fixtures (such as those in `backend/src/catalogue/catalogue-import.service.spec.ts`).

---

## 5. Execution & Ingestion

To trigger an import or dry-run validation via backend CLI or authenticated API:
- **Dry-run validation:**
  ```http
  POST /catalogue/import
  Authorization: Bearer <TOKEN>
  Content-Type: application/json

  {
    "dryRun": true
  }
  ```
- **Full database ingestion:**
  ```http
  POST /catalogue/import
  Authorization: Bearer <TOKEN>
  Content-Type: application/json

  {
    "dryRun": false
  }
  ```
