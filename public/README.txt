================================================================================
CLINIQO CLINIC MANAGEMENT SYSTEM — DESKTOP APPLICATION GUIDE
================================================================================
Version: 1.0.0
Architecture: Windows Desktop (x86_64) Native Shell with Encrypted SQLite & DPAPI
Distribution: Production Release Package

--------------------------------------------------------------------------------
1. INSTALLATION & SYSTEM REQUIREMENTS
--------------------------------------------------------------------------------
- Operating System: Windows 10 (64-bit) or Windows 11 (64-bit)
- WebView2: Microsoft Edge WebView2 Evergreen Runtime (pre-installed on Windows 10/11)
- RAM: Minimum 4 GB (8 GB recommended)
- Disk Space: 300 MB free space

Installation Steps:
1. Double-click the installer: `Cliniqo-Setup-x64.exe`.
2. When prompted by Windows User Account Control (UAC), click "Yes".
3. Cliniqo installs system-wide to:
   `C:\Program Files\Cliniqo\`
4. A shortcut is placed on your Desktop and Start Menu.

Data Safety & Privacy:
- Patient records, encrypted SQLite database, and cryptographic keys are NEVER stored
  in Program Files.
- All local clinical data is isolated in your secure user directory:
  `%LOCALAPPDATA%\com.cliniqo.desktop\`
- The local database is encrypted using AES-256-GCM.
- Cryptographic keys are protected using native Windows DPAPI (CryptProtectData).
- Updating or uninstalling Cliniqo NEVER deletes your local patient records.

--------------------------------------------------------------------------------
2. FIRST-TIME SETUP
--------------------------------------------------------------------------------
1. Launch Cliniqo from your Desktop or Start Menu.
2. Sign in with your registered Doctor credentials or create a new Clinic account.
3. Once authenticated:
   - Your clinic profile and doctor credentials are cryptographically verified.
   - The local encrypted SQLite database initializes automatically.
   - You can immediately use Cliniqo offline or online.

--------------------------------------------------------------------------------
3. MEDICINE EXCEL IMPORT FORMAT & TEMPLATE
--------------------------------------------------------------------------------
Cliniqo includes a high-performance offline spreadsheet importer for your clinic's
formulary and medicine inventory.

Included Template Files:
- `Medicine_Import_Template.xlsx` (Standard Excel spreadsheet)
- `Medicine_Import_Template.csv`  (Comma-separated values)

Standard Supported Columns:
1. Medicine Name (Required)
   Example: "Paracetamol 650mg Tablet", "Amoxicillin 500mg Capsule"
2. Generic Name (Active Ingredient / Salt)
   Example: "Paracetamol", "Amoxicillin"
3. Brand Name
   Example: "Dolo 650", "Mox 500"
4. Formulation (Form)
   Supported: Tablet, Capsule, Syrup, Suspension, Injection, Drops, Ointment, Cream, Gel, Inhaler, Respule, Powder, Spray
5. Strength
   Example: "650 mg", "500 mg", "10 mg", "5% w/w", "100 mcg"
6. Route of Administration
   Supported: Oral, Topical, Inhalation, Intravenous, Intramuscular, Subcutaneous, Ophthalmic, Otic, Nasal
7. Category
   Example: "Analgesic / Antipyretic", "Antibiotic", "Antihistamine", "Antacid / PPI"
8. Manufacturer / Company
   Example: "Micro Labs Ltd", "Sun Pharma", "Cipla"
9. Pack Size
   Example: "10 Tablets", "15 Tablets", "100 ml", "1 Inhaler"
10. MRP (Maximum Retail Price in INR)
    Example: 30.50, 75.00, 145.00
11. Storage Instructions
    Example: "Store below 25°C", "Protect from light and moisture"
12. Default Instructions
    Example: "1 tablet after food twice daily", "Take before breakfast"

How to Import:
1. Open Cliniqo → Settings → Clinical Library.
2. Drag and drop your `.xlsx` or `.csv` file into the upload zone, or click Browse.
3. Review the column mapping (Cliniqo auto-detects standard columns).
4. Review the preview and click "Import Medicines".
5. Your medicines are immediately available offline for prescription writing.

--------------------------------------------------------------------------------
4. KEYBOARD SHORTCUTS QUICK REFERENCE
--------------------------------------------------------------------------------
Press `Ctrl + /` anywhere in Cliniqo to open the keyboard shortcuts reference:
- `Ctrl + N`: New Consultation
- `Ctrl + P`: Print Prescription / Bill
- `Ctrl + S`: Save Record / Finalize
- `Ctrl + D`: Navigate to Dashboard
- `Ctrl + Shift + P`: Navigate to Patients
- `1` – `5` (in Frequency field): Fast Frequency Presets:
  - 1: 1-0-0 (Once daily, morning)
  - 2: 1-0-1 (Twice daily, morning & night)
  - 3: 1-1-1 (Thrice daily)
  - 4: 0-0-1 (Once daily, night)
  - 5: SOS / As needed

--------------------------------------------------------------------------------
5. SUPPORT & TECHNICAL CONTACT
--------------------------------------------------------------------------------
For support, feedback, or technical assistance:
- Website: https://cliniqo.app
- Email: support@cliniqo.app
================================================================================
