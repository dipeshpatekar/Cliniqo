import { useState, useEffect, useRef, useMemo } from "react"
import {
  Plus,
  ShieldCheck,
  UploadCloud,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Search,
  Filter,
  Eye,
  Trash2,
  Edit2,
  Check,
  X,
  ChevronRight,
  ArrowLeft,
  Pill,
  Layers,
  History,
  FileText,
} from "lucide-react"
import type {
  ClinicalLibrary,
  ClinicalLibraryCategory,
  ClinicalMedicineDefinition,
} from "../../types"
import { clinicalLibraryCategories, formatDateTimeDDMMYYYY } from "../../types"
import { cn } from "../../utils/cn"
import { Button, Field, TextInput, SelectInput, StatusPill } from "../common"
import {
  isTauriDesktop,
  importClinicalLibrary,
  getClinicalLibraryItems,
  getClinicalLibraryBatches,
  rollbackClinicalLibraryBatch,
  saveClinicalLibraryItem,
  archiveClinicalLibraryItem,
  type DesktopSessionContext,
  type ClinicalMedicineRecord,
  type ClinicalImportBatchRecord,
  type ClinicalImportSummary,
} from "../../desktop/desktop-bridge"
import {
  parseSpreadsheetFile,
  validateAndNormalizeRecords,
  type ParsedSpreadsheet,
  type ColumnMapping,
  type ValidationResult,
  type ClinicalFieldKey,
} from "../../utils/excelParser"

export interface ClinicalLibrarySettingsProps {
  library: ClinicalLibrary
  onAdd: (category: ClinicalLibraryCategory, value: string) => void
  onAddMedicine: (medicine: ClinicalMedicineDefinition) => void
  desktopSession?: DesktopSessionContext | null
}

type MainTab = "import" | "history" | "options"
type ImportStep = "upload" | "mapping" | "preview" | "complete"

export function ClinicalLibrarySettings({
  library,
  onAdd,
  onAddMedicine,
  desktopSession,
}: ClinicalLibrarySettingsProps) {
  const clinicId = desktopSession?.clinic_id || "clinic-default"
  const doctorId = desktopSession?.doctor_id || undefined

  const [activeTab, setActiveTab] = useState<MainTab>("import")

  // --- MEDICINES & DATA STATE ---
  const [medicines, setMedicines] = useState<ClinicalMedicineRecord[]>([])

  // --- IMPORT WIZARD STATE ---
  const [importStep, setImportStep] = useState<ImportStep>("upload")
  const [parsedFile, setParsedFile] = useState<ParsedSpreadsheet | null>(null)
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({
    name: null,
    genericName: null,
    brandName: null,
    composition: null,
    strength: null,
    formulation: null,
    dosageForm: null,
    route: null,
    manufacturer: null,
    category: null,
    packSize: null,
    mrp: null,
    storageInstructions: null,
    defaultInstructions: null,
  })
  const [validationResult, setValidationResult] =
    useState<ValidationResult | null>(null)
  const [previewFilter, setPreviewFilter] =
    useState<"valid" | "duplicate" | "error">("valid")
  const [allowUpdateDuplicates, setAllowUpdateDuplicates] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [lastImportSummary, setLastImportSummary] =
    useState<ClinicalImportSummary | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // --- BATCH HISTORY STATE ---
  const [batches, setBatches] = useState<ClinicalImportBatchRecord[]>([])
  const [rollbackConfirmBatchId, setRollbackConfirmBatchId] =
    useState<string | null>(null)
  const [isRollingBack, setIsRollingBack] = useState(false)

  // --- STANDARD OPTIONS STATE ---
  const [optionCategory, setOptionCategory] =
    useState<ClinicalLibraryCategory>("Formulations")
  const [newOptionValue, setNewOptionValue] = useState("")

  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load medicines & batches
  const refreshData = async () => {
    try {
      const [items, batchList] = await Promise.all([
        getClinicalLibraryItems(clinicId),
        getClinicalLibraryBatches(clinicId),
      ])
      setMedicines(items)
      setBatches(batchList)
    } catch (err) {
      console.error("Failed to load clinical library:", err)
    }
  }

  useEffect(() => {
    refreshData()
  }, [clinicId])

  // Handle file upload
  const handleFileUpload = async (file: File) => {
    setImportError(null)
    try {
      const parsed = await parseSpreadsheetFile(file, file.name)
      if (parsed.grid.length <= parsed.detectedHeaderRow) {
        setImportError(
          "The uploaded spreadsheet does not contain any data rows.",
        )
        return
      }
      setParsedFile(parsed)
      setColumnMapping(parsed.suggestedMapping)
      setImportStep("mapping")
    } catch (err: any) {
      console.error("File parse error:", err)
      setImportError(err?.message || "Failed to parse spreadsheet file.")
    }
  }

  // Handle proceeding to preview
  const handleProceedToPreview = () => {
    if (!parsedFile) return
    if (columnMapping.name === null) {
      setImportError("Please map the 'Medicine Name' column before proceeding.")
      return
    }

    const existingMeds = medicines.map((m) => ({
      name: m.name,
      formulation: m.formulation,
      strength: m.strength || "",
    }))

    const valResult = validateAndNormalizeRecords(
      parsedFile.grid,
      parsedFile.detectedHeaderRow,
      columnMapping,
      existingMeds,
    )

    setValidationResult(valResult)
    setImportStep("preview")
  }

  // Handle execute import
  const handleExecuteImport = async () => {
    if (!validationResult || !parsedFile) return
    setIsImporting(true)
    setImportError(null)
    try {
      const summary = await importClinicalLibrary({
        clinic_id: clinicId,
        doctor_id: doctorId,
        file_name: parsedFile.fileName,
        items: validationResult.readyToImport,
        total_rows: validationResult.totalRows,
        invalid_rows: validationResult.invalidRows,
        allow_update: allowUpdateDuplicates,
      })

      setLastImportSummary(summary)
      setImportStep("complete")
      await refreshData()
    } catch (err: any) {
      console.error("Import error:", err)
      setImportError(err?.message || "Failed to complete medicine import.")
    } finally {
      setIsImporting(false)
    }
  }

  // Handle batch rollback
  const handleRollbackBatch = async (batchId: string) => {
    setIsRollingBack(true)
    try {
      await rollbackClinicalLibraryBatch(clinicId, batchId)
      setRollbackConfirmBatchId(null)
      await refreshData()
    } catch (err) {
      console.error("Failed to roll back batch:", err)
    } finally {
      setIsRollingBack(false)
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-title with-status">
        <div>
          <h2>Clinical Library</h2>
        </div>
        <StatusPill tone="info">
          {medicines.length} ACTIVE MEDICINE{medicines.length === 1 ? "" : "S"}
        </StatusPill>
      </div>

      {/* Main Navigation Subtabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 my-5 gap-2 overflow-x-auto">
        <button
          className={cn(
            "library-subtab settings-field-label flex items-center gap-2.5 px-4 py-2.5 text-sm font-semibold border-b-2 transition cursor-pointer whitespace-nowrap",
            activeTab === "import"
              ? "border-teal-600 active text-teal-700 dark:border-teal-400 dark:text-teal-300"
              : "border-transparent text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100",
          )}
          onClick={() => {
            setActiveTab("import")
            setImportStep("upload")
            setParsedFile(null)
            setValidationResult(null)
          }}
        >
          <UploadCloud size={17} />
          Upload Excel / CSV
        </button>

        <button
          className={cn(
            "library-subtab settings-field-label flex items-center gap-2.5 px-4 py-2.5 text-sm font-semibold border-b-2 transition cursor-pointer whitespace-nowrap",
            activeTab === "history"
              ? "border-teal-600 active text-teal-700 dark:border-teal-400 dark:text-teal-300"
              : "border-transparent text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100",
          )}
          onClick={() => setActiveTab("history")}
        >
          <History size={17} />
          Import History
          {batches.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold">
              {batches.length}
            </span>
          )}
        </button>

        <button
          className={cn(
            "library-subtab settings-field-label flex items-center gap-2.5 px-4 py-2.5 text-sm font-semibold border-b-2 transition cursor-pointer whitespace-nowrap",
            activeTab === "options"
              ? "border-teal-600 active text-teal-700 dark:border-teal-400 dark:text-teal-300"
              : "border-transparent text-slate-700 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100",
          )}
          onClick={() => setActiveTab("options")}
        >
          <Layers size={17} />
          Standard Options
        </button>
      </div>

      {/* =======================================================
          TAB 1: UPLOAD & IMPORT EXCEL WIZARD
      ======================================================= */}
      {activeTab === "import" && (
        <div className="space-y-6">
          {/* Wizard Steps Progress Indicator */}
          <div className="flex items-center justify-between max-w-xl mx-auto py-2">
            {[
              { id: "upload", label: "1. Upload File" },
              { id: "mapping", label: "2. Map Columns" },
              { id: "preview", label: "3. Validate & Preview" },
              { id: "complete", label: "4. Complete" },
            ].map((step, idx) => {
              const isCurrent = importStep === step.id
              const isDone =
                (step.id === "upload" && importStep !== "upload") ||
                (step.id === "mapping" &&
                  (importStep === "preview" || importStep === "complete")) ||
                (step.id === "preview" && importStep === "complete")
              return (
                <div key={step.id} className="flex items-center gap-2">
                  <div
                    className={cn(
                      "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition",
                      isCurrent &&
                        "bg-teal-600 text-white shadow-sm ring-2 ring-teal-200 dark:ring-teal-900",
                      isDone && "bg-teal-500 text-white",
                      !isCurrent &&
                        !isDone &&
                        "bg-slate-100 dark:bg-slate-800 text-slate-400",
                    )}
                  >
                    {isDone ? <Check size={14} /> : idx + 1}
                  </div>
                  <span
                    className={cn(
                      "text-xs font-medium hidden sm:inline",
                      isCurrent &&
                        "text-teal-700 dark:text-teal-300 font-semibold",
                      !isCurrent && "text-slate-500",
                    )}
                  >
                    {step.label}
                  </span>
                  {idx < 3 && (
                    <div className="w-8 h-0.5 bg-slate-200 dark:bg-slate-700 mx-1" />
                  )}
                </div>
              )
            })}
          </div>

          {importError && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-lg text-rose-700 dark:text-rose-400 text-sm flex items-center gap-2">
              <AlertCircle size={16} className="shrink-0" />
              <span>{importError}</span>
            </div>
          )}

          {/* STEP 1: UPLOAD FILE */}
          {importStep === "upload" && (
            <div
              className="border-2 border-dashed border-teal-300 dark:border-teal-800 rounded-xl p-10 text-center bg-white dark:bg-slate-900/50 hover:border-teal-500 hover:bg-teal-50/20 dark:hover:bg-teal-950/20 transition cursor-pointer shadow-xs"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                e.currentTarget.classList.add(
                  "border-teal-500",
                  "bg-teal-50/30",
                )
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                e.currentTarget.classList.remove(
                  "border-teal-500",
                  "bg-teal-50/30",
                )
              }}
              onDrop={(e) => {
                e.preventDefault()
                e.currentTarget.classList.remove(
                  "border-teal-500",
                  "bg-teal-50/30",
                )
                const file = e.dataTransfer.files?.[0]
                if (file) handleFileUpload(file)
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv,.tsv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFileUpload(file)
                }}
              />

              <div className="w-16 h-16 bg-teal-50 dark:bg-teal-950/60 rounded-full flex items-center justify-center mx-auto text-teal-600 dark:text-teal-400 mb-4 border border-teal-100 dark:border-teal-900">
                <FileSpreadsheet size={30} />
              </div>

              <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                No medicines in your clinical library
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                Drag and drop your spreadsheet here or click to browse
              </p>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                <Button
                  variant="primary"
                  icon={UploadCloud}
                  onClick={(e) => {
                    e.stopPropagation()
                    fileInputRef.current?.click()
                  }}
                >
                  Upload Excel Sheet
                </Button>
                <a
                  href="/Medicine_Import_Template.xlsx"
                  download="Medicine_Import_Template.xlsx"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border border-teal-600/30 text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-950/40 transition"
                >
                  <FileSpreadsheet size={16} />
                  Download Excel Template
                </a>
              </div>
            </div>
          )}

          {/* STEP 2: COLUMN MAPPING */}
          {importStep === "mapping" && parsedFile && (
            <div className="space-y-4">
              <div className="p-4 bg-teal-50/60 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800 rounded-lg flex items-center justify-between">
                <div>
                  <h4 className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <FileSpreadsheet size={16} className="text-teal-600" />
                    {parsedFile.fileName}
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {parsedFile.grid.length - parsedFile.detectedHeaderRow - 1}{" "}
                    data rows detected • Header row on Line{" "}
                    {parsedFile.detectedHeaderRow + 1}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setImportStep("upload")
                    setParsedFile(null)
                  }}
                >
                  Choose Different File
                </Button>
              </div>

              <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900 p-4 space-y-4">
                <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
                  <h3 className="subsection-title font-semibold text-slate-800 dark:text-slate-200">
                    Verify & Adjust Column Mapping
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Match fields in Cliniqo with columns in your uploaded file.
                    Medicine Name is strictly required.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    {
                      key: "name" as ClinicalFieldKey,
                      label: "Medicine Name",
                      required: true,
                    },
                    {
                      key: "genericName" as ClinicalFieldKey,
                      label: "Generic / Molecule Name",
                      required: false,
                    },
                    {
                      key: "brandName" as ClinicalFieldKey,
                      label: "Brand Name",
                      required: false,
                    },
                    {
                      key: "composition" as ClinicalFieldKey,
                      label: "Composition / Salts",
                      required: false,
                    },
                    {
                      key: "strength" as ClinicalFieldKey,
                      label: "Strength (e.g. 500 mg)",
                      required: false,
                    },
                    {
                      key: "formulation" as ClinicalFieldKey,
                      label: "Formulation (Tablet, Syrup, etc.)",
                      required: false,
                    },
                    {
                      key: "manufacturer" as ClinicalFieldKey,
                      label: "Manufacturer / Company",
                      required: false,
                    },
                    {
                      key: "category" as ClinicalFieldKey,
                      label: "Category / Schedule",
                      required: false,
                    },
                    {
                      key: "packSize" as ClinicalFieldKey,
                      label: "Pack Size",
                      required: false,
                    },
                    {
                      key: "mrp" as ClinicalFieldKey,
                      label: "MRP / Price (₹)",
                      required: false,
                    },
                    {
                      key: "storageInstructions" as ClinicalFieldKey,
                      label: "Storage Instructions",
                      required: false,
                    },
                    {
                      key: "defaultInstructions" as ClinicalFieldKey,
                      label: "Directions / Instructions",
                      required: false,
                    },
                  ].map((field) => {
                    const currentIdx = columnMapping[field.key]
                    const sampleValue =
                      currentIdx != null &&
                      parsedFile.grid[parsedFile.detectedHeaderRow + 1]
                        ? parsedFile.grid[parsedFile.detectedHeaderRow + 1][
                            currentIdx
                          ]
                        : null

                    return (
                      <div
                        key={field.key}
                        className="p-3 rounded-lg border border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900/40 space-y-1.5"
                      >
                        <div className="flex items-center justify-between text-sm font-semibold field-label settings-field-label text-slate-800 dark:text-slate-100">
                          <span>
                            {field.label}{" "}
                            {field.required && (
                              <span className="text-rose-500">*</span>
                            )}
                          </span>
                          {currentIdx != null && (
                            <span className="text-[11px] font-normal text-teal-600 dark:text-teal-400">
                              Mapped
                            </span>
                          )}
                        </div>
                        <select
                          className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100"
                          value={currentIdx ?? ""}
                          onChange={(e) => {
                            const val =
                              e.target.value === ""
                                ? null
                                : parseInt(e.target.value, 10)
                            setColumnMapping((prev) => ({
                              ...prev,
                              [field.key]: val,
                            }))
                          }}
                        >
                          <option value="">— Not in file / Ignore —</option>
                          {parsedFile.headers.map((h, i) => (
                            <option key={i} value={i}>
                              {h}
                            </option>
                          ))}
                        </select>
                        {sampleValue && (
                          <div className="text-[11px] text-slate-500 truncate font-mono">
                            Sample: "{sampleValue}"
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-slate-200 dark:border-slate-800">
                  <Button
                    variant="secondary"
                    onClick={() => setImportStep("upload")}
                  >
                    Back
                  </Button>
                  <Button
                    variant="primary"
                    icon={ChevronRight}
                    onClick={handleProceedToPreview}
                    disabled={columnMapping.name === null}
                  >
                    Proceed to Validation & Preview
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: PREVIEW & VALIDATION REPORT */}
          {importStep === "preview" && validationResult && (
            <div className="space-y-4">
              {/* Summary Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                  <span className="text-xs text-slate-500 uppercase tracking-wider block font-medium">
                    Total Processed
                  </span>
                  <span className="text-2xl font-bold text-slate-800 dark:text-slate-100">
                    {validationResult.totalRows}
                  </span>
                </div>

                <div className="p-3.5 rounded-lg border border-teal-200 dark:border-teal-900/60 bg-teal-50/50 dark:bg-teal-950/20">
                  <span className="text-xs text-teal-700 dark:text-teal-400 uppercase tracking-wider block font-medium">
                    Ready to Import
                  </span>
                  <span className="text-2xl font-bold text-teal-600 dark:text-teal-400">
                    {validationResult.validRows}
                  </span>
                </div>

                <div className="p-3.5 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20">
                  <span className="text-xs text-amber-700 dark:text-amber-400 uppercase tracking-wider block font-medium">
                    Duplicates (Skip)
                  </span>
                  <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                    {validationResult.duplicateRows}
                  </span>
                </div>

                <div className="p-3.5 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/50 dark:bg-rose-950/20">
                  <span className="text-xs text-rose-700 dark:text-rose-400 uppercase tracking-wider block font-medium">
                    Invalid Rows
                  </span>
                  <span className="text-2xl font-bold text-rose-600 dark:text-rose-400">
                    {validationResult.invalidRows}
                  </span>
                </div>
              </div>

              {/* Subtabs for Preview Table */}
              <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
                  <div className="flex gap-2">
                    <button
                      className={cn(
                        "px-3 py-1.5 text-xs font-semibold rounded-md transition",
                        previewFilter === "valid"
                          ? "bg-teal-600 text-white"
                          : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
                      )}
                      onClick={() => setPreviewFilter("valid")}
                    >
                      Ready to Import ({validationResult.validRows})
                    </button>
                    <button
                      className={cn(
                        "px-3 py-1.5 text-xs font-semibold rounded-md transition",
                        previewFilter === "duplicate"
                          ? "bg-amber-600 text-white"
                          : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
                      )}
                      onClick={() => setPreviewFilter("duplicate")}
                    >
                      Duplicates ({validationResult.duplicateRows})
                    </button>
                    {validationResult.invalidRows > 0 && (
                      <button
                        className={cn(
                          "px-3 py-1.5 text-xs font-semibold rounded-md transition",
                          previewFilter === "error"
                            ? "bg-rose-600 text-white"
                            : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
                        )}
                        onClick={() => setPreviewFilter("error")}
                      >
                        Errors ({validationResult.invalidRows})
                      </button>
                    )}
                  </div>

                  <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={allowUpdateDuplicates}
                      onChange={(e) =>
                        setAllowUpdateDuplicates(e.target.checked)
                      }
                      className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                    />
                    <span>Update metadata if duplicate exists</span>
                  </label>
                </div>

                {/* Table View */}
                {previewFilter === "valid" && (
                  <div className="overflow-x-auto max-h-[360px]">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0 border-b border-slate-200 dark:border-slate-700">
                        <tr>
                          <th className="py-2 px-3">#</th>
                          <th className="py-2 px-3">Medicine Name</th>
                          <th className="py-2 px-3">Formulation</th>
                          <th className="py-2 px-3">Strength</th>
                          <th className="py-2 px-3">Generic / Composition</th>
                          <th className="py-2 px-3">Manufacturer</th>
                          <th className="py-2 px-3">MRP</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                        {validationResult.readyToImport
                          .slice(0, 100)
                          .map((item, idx) => (
                            <tr
                              key={idx}
                              className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30"
                            >
                              <td className="py-2 px-3 text-slate-400">
                                {idx + 1}
                              </td>
                              <td className="py-2 px-3 font-semibold font-sans text-slate-900 dark:text-slate-100">
                                {item.name}
                              </td>
                              <td className="py-2 px-3">
                                <span className="px-1.5 py-0.5 rounded bg-teal-50 dark:bg-teal-950 text-teal-700 dark:text-teal-300 text-[11px]">
                                  {item.formulation}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-slate-700 dark:text-slate-300">
                                {item.strength || "—"}
                              </td>
                              <td className="py-2 px-3 text-slate-600 dark:text-slate-400 font-sans max-w-[200px] truncate">
                                {item.generic_name || item.composition || "—"}
                              </td>
                              <td className="py-2 px-3 text-slate-500 font-sans">
                                {item.manufacturer || "—"}
                              </td>
                              <td className="py-2 px-3">
                                {item.mrp != null
                                  ? `₹${item.mrp.toFixed(2)}`
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {previewFilter === "duplicate" && (
                  <div className="overflow-x-auto max-h-[360px]">
                    {validationResult.duplicates.length === 0 ? (
                      <div className="py-8 text-center text-slate-500 text-xs">
                        No duplicates detected in this file.
                      </div>
                    ) : (
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-slate-50 dark:bg-slate-800 sticky top-0 border-b border-slate-200 dark:border-slate-700">
                          <tr>
                            <th className="py-2 px-3">Row #</th>
                            <th className="py-2 px-3">Medicine Name</th>
                            <th className="py-2 px-3">
                              Formulation & Strength
                            </th>
                            <th className="py-2 px-3">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-sans">
                          {validationResult.duplicates.map((dup, idx) => (
                            <tr
                              key={idx}
                              className="hover:bg-amber-50/30 dark:hover:bg-amber-950/20"
                            >
                              <td className="py-2 px-3 font-mono text-slate-400">
                                {dup.row}
                              </td>
                              <td className="py-2 px-3 font-semibold text-slate-800 dark:text-slate-200">
                                {dup.item.name}
                              </td>
                              <td className="py-2 px-3 text-slate-600 dark:text-slate-300">
                                {dup.item.formulation} ·{" "}
                                {dup.item.strength || "Unspecified"}
                              </td>
                              <td className="py-2 px-3 text-amber-700 dark:text-amber-400 font-medium text-xs">
                                {dup.reason}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {previewFilter === "error" && (
                  <div className="overflow-x-auto max-h-[360px] space-y-2">
                    {validationResult.errors.map((err, idx) => (
                      <div
                        key={idx}
                        className="p-2.5 rounded bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-400 text-xs flex items-center justify-between"
                      >
                        <span>
                          <strong>Row {err.row}:</strong> {err.error}
                        </span>
                        <span className="font-mono text-[11px] text-slate-400 truncate max-w-xs">
                          {err.rawRow.slice(0, 3).join(" | ")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Footer Actions */}
                <div className="flex items-center justify-between pt-4 border-t border-slate-200 dark:border-slate-800">
                  <Button
                    variant="secondary"
                    onClick={() => setImportStep("mapping")}
                  >
                    Edit Column Mapping
                  </Button>

                  <Button
                    variant="primary"
                    icon={Check}
                    disabled={validationResult.validRows === 0 || isImporting}
                    onClick={handleExecuteImport}
                  >
                    {isImporting
                      ? "Importing..."
                      : `Confirm & Import ${validationResult.validRows} Medicines`}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: IMPORT COMPLETE BANNER */}
          {importStep === "complete" && lastImportSummary && (
            <div className="border border-teal-200 dark:border-teal-800 rounded-xl p-8 bg-teal-50/40 dark:bg-teal-950/20 text-center space-y-4">
              <div className="w-16 h-16 bg-teal-100 dark:bg-teal-900/60 rounded-full flex items-center justify-center mx-auto text-teal-600 dark:text-teal-300">
                <CheckCircle2 size={36} />
              </div>

              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  Import Completed Successfully
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 max-w-md mx-auto">
                  <strong>{lastImportSummary.imported_rows}</strong> medicines
                  have been imported into your clinic's library and are now
                  available for prescription autocomplete.
                  {lastImportSummary.skipped_rows > 0 &&
                    ` (${lastImportSummary.skipped_rows} existing duplicate records preserved)`}
                </p>
              </div>

              <div className="p-3 max-w-sm mx-auto bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-500 font-mono">
                Batch ID: {lastImportSummary.batch_id}
              </div>

              <div className="flex items-center justify-center gap-3 pt-2">
                <Button
                  variant="secondary"
                  onClick={() => setImportStep("upload")}
                >
                  Upload Another File
                </Button>
                <Button
                  variant="primary"
                  icon={History}
                  onClick={() => setActiveTab("history")}
                >
                  View Import History
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =======================================================
          TAB 3: IMPORT HISTORY & BATCH ROLLBACK
      ======================================================= */}
      {activeTab === "history" && (
        <div className="space-y-4">
          <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
            <h3 className="subsection-title font-semibold text-slate-800 dark:text-slate-200">
              Import Batch History & Provenance
            </h3>
          </div>

          {batches.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-sm border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
              No import batches recorded yet.
            </div>
          ) : (
            <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900 shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm border-collapse">
                  <thead className="bg-slate-50 dark:bg-slate-800 text-xs font-semibold uppercase text-slate-500 tracking-wider border-b border-slate-200 dark:border-slate-700">
                    <tr>
                      <th className="py-3 px-4">File Name</th>
                      <th className="py-3 px-4">Uploaded At</th>
                      <th className="py-3 px-4">Total</th>
                      <th className="py-3 px-4">Imported</th>
                      <th className="py-3 px-4">Skipped</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-sans">
                    {batches.map((b) => (
                      <tr
                        key={b.id}
                        className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30"
                      >
                        <td className="py-3 px-4 font-semibold text-slate-900 dark:text-slate-100">
                          {b.file_name}
                          <span className="block text-[11px] font-mono text-slate-400 font-normal">
                            {b.id}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600 dark:text-slate-300">
                          {formatDateTimeDDMMYYYY(b.created_at)}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs">
                          {b.total_rows}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs font-semibold text-teal-600 dark:text-teal-400">
                          {b.imported_rows}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-amber-600 dark:text-amber-400">
                          {b.skipped_rows}
                        </td>
                        <td className="py-3 px-4">
                          <StatusPill
                            tone={
                              b.status === "COMPLETED" ? "success" : "neutral"
                            }
                          >
                            {b.status}
                          </StatusPill>
                        </td>
                        <td className="py-3 px-4 text-right">
                          {b.status === "COMPLETED" && (
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={RotateCcw}
                              disabled={isRollingBack}
                              onClick={() => setRollbackConfirmBatchId(b.id)}
                            >
                              Rollback Batch
                            </Button>
                          )}
                          {b.status === "ROLLED_BACK" && (
                            <span className="text-xs text-slate-400 italic">
                              Rolled back
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =======================================================
          TAB 4: STANDARD OPTIONS (Formulations, Strengths, Doses)
      ======================================================= */}
      {activeTab === "options" && (
        <div className="space-y-4">
          <div className="library-tabs" role="tablist">
            {clinicalLibraryCategories
              .filter((c) => c !== "Medicines")
              .map((item) => (
                <button
                  key={item}
                  role="tab"
                  aria-selected={optionCategory === item}
                  className={optionCategory === item ? "active" : ""}
                  onClick={() => setOptionCategory(item)}
                >
                  {item}
                  <span>{library[item].length}</span>
                </button>
              ))}
          </div>

          <div className="library-add">
            <TextInput
              value={newOptionValue}
              onChange={(e) => setNewOptionValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  const val = newOptionValue.trim()
                  if (val && !library[optionCategory].includes(val)) {
                    onAdd(optionCategory, val)
                    setNewOptionValue("")
                  }
                }
              }}
              placeholder={`Add custom ${optionCategory.toLowerCase().replace(/s$/, "")}...`}
            />
            <Button
              icon={Plus}
              onClick={() => {
                const val = newOptionValue.trim()
                if (val && !library[optionCategory].includes(val)) {
                  onAdd(optionCategory, val)
                  setNewOptionValue("")
                }
              }}
              disabled={!newOptionValue.trim()}
            >
              Add option
            </Button>
          </div>

          <div className="library-list">
            {library[optionCategory].map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>

          <div className="info-callout">
            <ShieldCheck size={17} />
            <p>
              Standard options populate consultation drop-downs and ensure
              consistent medical charting across the clinic.
            </p>
          </div>
        </div>
      )}

      {/* =======================================================
          MODAL: CONFIRM ROLLBACK BATCH
      ======================================================= */}
      {rollbackConfirmBatchId && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-800 max-w-md w-full p-6 space-y-4">
            <div className="w-10 h-10 rounded-full bg-amber-50 dark:bg-amber-950/60 text-amber-600 flex items-center justify-center">
              <RotateCcw size={20} />
            </div>
            <div>
              <h4 className="font-bold text-slate-900 dark:text-slate-100">
                Rollback Import Batch?
              </h4>
              <p className="text-xs text-slate-500 mt-1">
                Are you sure you want to deactivate all medicines imported from
                this batch? Other manual additions and batches will remain
                untouched.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                onClick={() => setRollbackConfirmBatchId(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={isRollingBack}
                onClick={() => handleRollbackBatch(rollbackConfirmBatchId)}
              >
                {isRollingBack ? "Rolling back..." : "Confirm Rollback"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export default ClinicalLibrarySettings
