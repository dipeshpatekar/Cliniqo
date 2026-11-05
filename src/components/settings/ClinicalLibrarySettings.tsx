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
import { clinicalLibraryCategories } from "../../types"
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

type MainTab = "catalogue" | "import" | "history" | "options"
type ImportStep = "upload" | "mapping" | "preview" | "complete"

export function ClinicalLibrarySettings({
  library,
  onAdd,
  onAddMedicine,
  desktopSession,
}: ClinicalLibrarySettingsProps) {
  const clinicId = desktopSession?.clinic_id || "clinic-default"
  const doctorId = desktopSession?.doctor_id || undefined

  const [activeTab, setActiveTab] = useState<MainTab>("catalogue")

  // --- CATALOGUE STATE ---
  const [medicines, setMedicines] = useState<ClinicalMedicineRecord[]>([])
  const [catalogueLoading, setCatalogueLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [formulationFilter, setFormulationFilter] = useState("ALL")
  const [selectedMedicine, setSelectedMedicine] = useState<ClinicalMedicineRecord | null>(null)
  const [editingMedicine, setEditingMedicine] = useState<ClinicalMedicineRecord | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

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
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [previewFilter, setPreviewFilter] = useState<"valid" | "duplicate" | "error">("valid")
  const [allowUpdateDuplicates, setAllowUpdateDuplicates] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [lastImportSummary, setLastImportSummary] = useState<ClinicalImportSummary | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // --- BATCH HISTORY STATE ---
  const [batches, setBatches] = useState<ClinicalImportBatchRecord[]>([])
  const [rollbackConfirmBatchId, setRollbackConfirmBatchId] = useState<string | null>(null)
  const [isRollingBack, setIsRollingBack] = useState(false)

  // --- STANDARD OPTIONS STATE ---
  const [optionCategory, setOptionCategory] = useState<ClinicalLibraryCategory>("Formulations")
  const [newOptionValue, setNewOptionValue] = useState("")

  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load medicines & batches
  const refreshData = async () => {
    setCatalogueLoading(true)
    try {
      const [items, batchList] = await Promise.all([
        getClinicalLibraryItems(clinicId),
        getClinicalLibraryBatches(clinicId),
      ])
      setMedicines(items)
      setBatches(batchList)
    } catch (err) {
      console.error("Failed to load clinical library:", err)
    } finally {
      setCatalogueLoading(false)
    }
  }

  useEffect(() => {
    refreshData()
  }, [clinicId])

  // Filtered catalogue list
  const filteredMedicines = useMemo(() => {
    // Merge database medicines with any prop-passed library definitions
    const merged: ClinicalMedicineRecord[] = [...medicines]
    if (library?.MedicineDefinitions) {
      for (const def of library.MedicineDefinitions) {
        if (!merged.some((m) => m.name.toLowerCase().trim() === def.name.toLowerCase().trim())) {
          merged.push({
            id: def.id || `def_${def.name}`,
            clinic_id: clinicId,
            name: def.name,
            formulation: def.formulation,
            strength: def.strength,
            generic_name: def.activeIngredient,
            composition: def.activeIngredient,
            brand_name: def.name,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
        }
      }
    }

    return merged.filter((m) => {
      if (!m.is_active) return false
      if (formulationFilter !== "ALL" && m.formulation.toLowerCase() !== formulationFilter.toLowerCase()) {
        return false
      }
      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase().trim()
      return (
        m.name.toLowerCase().includes(q) ||
        (m.generic_name && m.generic_name.toLowerCase().includes(q)) ||
        (m.brand_name && m.brand_name.toLowerCase().includes(q)) ||
        (m.manufacturer && m.manufacturer.toLowerCase().includes(q)) ||
        (m.composition && m.composition.toLowerCase().includes(q))
      )
    })
  }, [medicines, library?.MedicineDefinitions, searchQuery, formulationFilter, clinicId])

  // Handle file upload
  const handleFileUpload = async (file: File) => {
    setImportError(null)
    try {
      const parsed = await parseSpreadsheetFile(file, file.name)
      if (parsed.grid.length <= parsed.detectedHeaderRow) {
        setImportError("The uploaded spreadsheet does not contain any data rows.")
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
      existingMeds
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

  // Handle archive medicine
  const handleArchiveMedicine = async (id: string) => {
    try {
      await archiveClinicalLibraryItem(clinicId, id)
      setDeleteConfirmId(null)
      setSelectedMedicine(null)
      await refreshData()
    } catch (err) {
      console.error("Failed to archive medicine:", err)
    }
  }

  // Available formulations for filter
  const availableFormulations = useMemo(() => {
    const set = new Set<string>()
    for (const m of medicines) {
      if (m.is_active && m.formulation) {
        set.add(m.formulation)
      }
    }
    return Array.from(set).sort()
  }, [medicines])

  return (
    <section className="settings-section">
      <div className="settings-title with-status">
        <div>
          <h2>Clinical Library & Medicine Management</h2>
          <p>
            Upload, validate, and maintain clinic-specific medicines, formulary options,
            and dosage defaults for consultations and prescriptions.
          </p>
        </div>
        <StatusPill tone="info">
          {medicines.length} ACTIVE MEDICINE{medicines.length === 1 ? "" : "S"}
        </StatusPill>
      </div>

      {/* Main Navigation Subtabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 my-4 gap-1">
        <button
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition cursor-pointer",
            activeTab === "catalogue"
              ? "border-teal-600 text-teal-600 dark:border-teal-400 dark:text-teal-400 font-semibold"
              : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          )}
          onClick={() => setActiveTab("catalogue")}
        >
          <Pill size={16} />
          Medicine Catalogue
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold">
            {medicines.length}
          </span>
        </button>

        <button
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition cursor-pointer",
            activeTab === "import"
              ? "border-teal-600 text-teal-600 dark:border-teal-400 dark:text-teal-400 font-semibold"
              : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          )}
          onClick={() => {
            setActiveTab("import")
            setImportStep("upload")
            setParsedFile(null)
            setValidationResult(null)
          }}
        >
          <UploadCloud size={16} />
          Upload Excel / CSV
        </button>

        <button
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition cursor-pointer",
            activeTab === "history"
              ? "border-teal-600 text-teal-600 dark:border-teal-400 dark:text-teal-400 font-semibold"
              : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          )}
          onClick={() => setActiveTab("history")}
        >
          <History size={16} />
          Import History
          {batches.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
              {batches.length}
            </span>
          )}
        </button>

        <button
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition cursor-pointer",
            activeTab === "options"
              ? "border-teal-600 text-teal-600 dark:border-teal-400 dark:text-teal-400 font-semibold"
              : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          )}
          onClick={() => setActiveTab("options")}
        >
          <Layers size={16} />
          Standard Options
        </button>
      </div>

      {/* =======================================================
          TAB 1: MEDICINE CATALOGUE
      ======================================================= */}
      {activeTab === "catalogue" && (
        <div className="space-y-4">
          {/* Controls: Search, Filter, Add Manual */}
          <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
            <div className="flex-1 max-w-md relative">
              <TextInput
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by brand, generic name, molecule, or company..."
              />
            </div>

            <div className="flex items-center gap-2">
              <select
                className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none"
                value={formulationFilter}
                onChange={(e) => setFormulationFilter(e.target.value)}
              >
                <option value="ALL">All Formulations</option>
                {availableFormulations.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>

              <Button
                variant="primary"
                icon={UploadCloud}
                onClick={() => {
                  setActiveTab("import")
                  setImportStep("upload")
                }}
              >
                Import Excel
              </Button>
            </div>
          </div>

          {/* Medicines List / Table */}
          {catalogueLoading ? (
            <div className="p-8 text-center text-slate-500">Loading clinical library...</div>
          ) : filteredMedicines.length === 0 ? (
            <div className="text-center py-12 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-900/30">
              <FileSpreadsheet className="mx-auto h-12 w-12 text-slate-400 mb-3" />
              <h3 className="text-base font-semibold text-slate-700 dark:text-slate-200">
                {searchQuery || formulationFilter !== "ALL"
                  ? "No matching medicines found"
                  : "No medicines in your clinical library"}
              </h3>
              <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                {searchQuery || formulationFilter !== "ALL"
                  ? "Try adjusting your search terms or formulation filter."
                  : "Upload your clinic's medicine catalogue in Excel (XLSX, XLS) or CSV format to populate the library."}
              </p>
              {!searchQuery && formulationFilter === "ALL" && (
                <div className="mt-4">
                  <Button
                    variant="primary"
                    icon={UploadCloud}
                    onClick={() => {
                      setActiveTab("import")
                      setImportStep("upload")
                    }}
                  >
                    Upload Excel Sheet
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900 shadow-sm">
              <div className="overflow-x-auto max-h-[550px]">
                <table className="w-full text-left border-collapse text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 text-xs font-semibold uppercase text-slate-500 tracking-wider sticky top-0 z-10 border-b border-slate-200 dark:border-slate-700">
                    <tr>
                      <th className="py-3 px-4">Medicine Name</th>
                      <th className="py-3 px-4">Formulation</th>
                      <th className="py-3 px-4">Strength</th>
                      <th className="py-3 px-4">Generic / Active Molecule</th>
                      <th className="py-3 px-4">Manufacturer</th>
                      <th className="py-3 px-4">MRP</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-sans">
                    {filteredMedicines.map((m) => (
                      <tr
                        key={m.id}
                        className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition cursor-pointer"
                        onClick={() => setSelectedMedicine(m)}
                      >
                        <td className="py-3 px-4 font-semibold text-slate-900 dark:text-slate-100">
                          {m.name}
                          <small className="block text-xs font-normal text-slate-500 dark:text-slate-400">
                            {m.formulation} · {m.strength || "Unspecified"}
                            {m.generic_name ? ` · (${m.generic_name})` : ""}
                          </small>
                        </td>
                        <td className="py-3 px-4">
                          <span className="inline-block px-2 py-0.5 text-xs font-medium rounded bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 border border-teal-200/60 dark:border-teal-800/60">
                            {m.formulation}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-slate-700 dark:text-slate-300">
                          {m.strength || "—"}
                        </td>
                        <td className="py-3 px-4 text-slate-600 dark:text-slate-300 max-w-[200px] truncate">
                          {m.generic_name || m.composition || "—"}
                        </td>
                        <td className="py-3 px-4 text-slate-500 text-xs">
                          {m.manufacturer || "—"}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300">
                          {m.mrp != null ? `₹${m.mrp.toFixed(2)}` : "—"}
                        </td>
                        <td
                          className="py-3 px-4 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-end gap-1">
                            <button
                              className="p-1.5 text-slate-400 hover:text-teal-600 dark:hover:text-teal-400 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                              title="View Details"
                              onClick={() => setSelectedMedicine(m)}
                            >
                              <Eye size={15} />
                            </button>
                            <button
                              className="p-1.5 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                              title="Archive Medicine"
                              onClick={() => setDeleteConfirmId(m.id)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
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
          TAB 2: UPLOAD & IMPORT EXCEL WIZARD
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
                (step.id === "mapping" && (importStep === "preview" || importStep === "complete")) ||
                (step.id === "preview" && importStep === "complete")
              return (
                <div key={step.id} className="flex items-center gap-2">
                  <div
                    className={cn(
                      "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition",
                      isCurrent && "bg-teal-600 text-white shadow-sm ring-2 ring-teal-200 dark:ring-teal-900",
                      isDone && "bg-teal-500 text-white",
                      !isCurrent && !isDone && "bg-slate-100 dark:bg-slate-800 text-slate-400"
                    )}
                  >
                    {isDone ? <Check size={14} /> : idx + 1}
                  </div>
                  <span
                    className={cn(
                      "text-xs font-medium hidden sm:inline",
                      isCurrent && "text-teal-700 dark:text-teal-300 font-semibold",
                      !isCurrent && "text-slate-500"
                    )}
                  >
                    {step.label}
                  </span>
                  {idx < 3 && <div className="w-8 h-0.5 bg-slate-200 dark:bg-slate-700 mx-1" />}
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
            <div className="border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-xl p-8 text-center bg-slate-50/50 dark:bg-slate-900/30 hover:border-teal-500 transition">
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

              <div className="w-14 h-14 bg-teal-50 dark:bg-teal-950/60 rounded-full flex items-center justify-center mx-auto text-teal-600 dark:text-teal-400 mb-3">
                <FileSpreadsheet size={28} />
              </div>

              <h3 className="text-base font-semibold text-slate-800 dark:text-slate-200">
                Choose Excel or CSV file
              </h3>
              <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                Upload your clinic formulary, stock report, or pharmacy export.
                Supports <strong>.xlsx</strong>, <strong>.xls</strong>, and <strong>.csv</strong>.
              </p>

              <div className="mt-5 flex items-center justify-center gap-3">
                <Button
                  variant="primary"
                  icon={UploadCloud}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Select Spreadsheet File
                </Button>
              </div>

              <div className="mt-6 flex items-center justify-center gap-4 text-xs text-slate-400">
                <span>✓ Intelligent column detection</span>
                <span>•</span>
                <span>✓ Duplicate prevention</span>
                <span>•</span>
                <span>✓ Full batch rollback</span>
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
                    {parsedFile.grid.length - parsedFile.detectedHeaderRow - 1} data rows detected • Header row on Line {parsedFile.detectedHeaderRow + 1}
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
                  <h3 className="font-semibold text-slate-800 dark:text-slate-200">
                    Verify & Adjust Column Mapping
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Match fields in Cliniqo with columns in your uploaded file. Medicine Name is strictly required.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    { key: "name" as ClinicalFieldKey, label: "Medicine Name", required: true },
                    { key: "genericName" as ClinicalFieldKey, label: "Generic / Molecule Name", required: false },
                    { key: "brandName" as ClinicalFieldKey, label: "Brand Name", required: false },
                    { key: "composition" as ClinicalFieldKey, label: "Composition / Salts", required: false },
                    { key: "strength" as ClinicalFieldKey, label: "Strength (e.g. 500 mg)", required: false },
                    { key: "formulation" as ClinicalFieldKey, label: "Formulation (Tablet, Syrup, etc.)", required: false },
                    { key: "manufacturer" as ClinicalFieldKey, label: "Manufacturer / Company", required: false },
                    { key: "category" as ClinicalFieldKey, label: "Category / Schedule", required: false },
                    { key: "packSize" as ClinicalFieldKey, label: "Pack Size", required: false },
                    { key: "mrp" as ClinicalFieldKey, label: "MRP / Price (₹)", required: false },
                    { key: "storageInstructions" as ClinicalFieldKey, label: "Storage Instructions", required: false },
                    { key: "defaultInstructions" as ClinicalFieldKey, label: "Directions / Instructions", required: false },
                  ].map((field) => {
                    const currentIdx = columnMapping[field.key]
                    const sampleValue =
                      currentIdx != null && parsedFile.grid[parsedFile.detectedHeaderRow + 1]
                        ? parsedFile.grid[parsedFile.detectedHeaderRow + 1][currentIdx]
                        : null

                    return (
                      <div
                        key={field.key}
                        className="p-3 rounded-lg border border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900/40 space-y-1.5"
                      >
                        <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
                          <span>
                            {field.label} {field.required && <span className="text-rose-500">*</span>}
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
                            const val = e.target.value === "" ? null : parseInt(e.target.value, 10)
                            setColumnMapping((prev) => ({ ...prev, [field.key]: val }))
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
                  <Button variant="secondary" onClick={() => setImportStep("upload")}>
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
                          : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
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
                          : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
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
                            : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
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
                      onChange={(e) => setAllowUpdateDuplicates(e.target.checked)}
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
                        {validationResult.readyToImport.slice(0, 100).map((item, idx) => (
                          <tr key={idx} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                            <td className="py-2 px-3 text-slate-400">{idx + 1}</td>
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
                              {item.mrp != null ? `₹${item.mrp.toFixed(2)}` : "—"}
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
                            <th className="py-2 px-3">Formulation & Strength</th>
                            <th className="py-2 px-3">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-sans">
                          {validationResult.duplicates.map((dup, idx) => (
                            <tr key={idx} className="hover:bg-amber-50/30 dark:hover:bg-amber-950/20">
                              <td className="py-2 px-3 font-mono text-slate-400">{dup.row}</td>
                              <td className="py-2 px-3 font-semibold text-slate-800 dark:text-slate-200">
                                {dup.item.name}
                              </td>
                              <td className="py-2 px-3 text-slate-600 dark:text-slate-300">
                                {dup.item.formulation} · {dup.item.strength || "Unspecified"}
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
                  <Button variant="secondary" onClick={() => setImportStep("mapping")}>
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
                  <strong>{lastImportSummary.imported_rows}</strong> medicines have been imported
                  into your clinic's library and are now available for prescription autocomplete.
                  {lastImportSummary.skipped_rows > 0 &&
                    ` (${lastImportSummary.skipped_rows} existing duplicate records preserved)`}
                </p>
              </div>

              <div className="p-3 max-w-sm mx-auto bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-500 font-mono">
                Batch ID: {lastImportSummary.batch_id}
              </div>

              <div className="flex items-center justify-center gap-3 pt-2">
                <Button variant="secondary" onClick={() => setImportStep("upload")}>
                  Upload Another File
                </Button>
                <Button variant="primary" icon={Pill} onClick={() => setActiveTab("catalogue")}>
                  View Medicine Catalogue
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
            <h3 className="font-semibold text-slate-800 dark:text-slate-200">
              Import Batch History & Provenance
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Review audit logs of all past Excel and CSV uploads. You can safely roll back
              any batch to deactivate its medicines without affecting other records.
            </p>
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
                      <tr key={b.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                        <td className="py-3 px-4 font-semibold text-slate-900 dark:text-slate-100">
                          {b.file_name}
                          <span className="block text-[11px] font-mono text-slate-400 font-normal">
                            {b.id}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600 dark:text-slate-300">
                          {new Date(b.created_at).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs">{b.total_rows}</td>
                        <td className="py-3 px-4 font-mono text-xs font-semibold text-teal-600 dark:text-teal-400">
                          {b.imported_rows}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-amber-600 dark:text-amber-400">
                          {b.skipped_rows}
                        </td>
                        <td className="py-3 px-4">
                          <StatusPill tone={b.status === "COMPLETED" ? "success" : "neutral"}>
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
                            <span className="text-xs text-slate-400 italic">Rolled back</span>
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
              Standard options populate consultation drop-downs and ensure consistent
              medical charting across the clinic.
            </p>
          </div>

          <div
            className="info-callout"
            style={{
              marginTop: "12px",
              borderLeftColor: "#0284c7",
              backgroundColor: "#f0f9ff",
              color: "#0369a1",
            }}
          >
            <div>
              <strong style={{ display: "block", marginBottom: "4px" }}>
                Common Drug Codes for India (CDCI) Reference Dataset
              </strong>
              <p style={{ fontSize: "12px", lineHeight: "1.5" }}>
                Reference drug terminology provided under{" "}
                <strong>
                  Creative Commons Attribution 4.0 International (CC BY 4.0)
                </strong>{" "}
                by the National Resource Centre for EHR Standards (NRCeS), Centre
                for Development of Advanced Computing (C-DAC) Pune.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* =======================================================
          MODAL: MEDICINE DETAILS
      ======================================================= */}
      {selectedMedicine && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-800 max-w-lg w-full p-6 space-y-4">
            <div className="flex items-start justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  {selectedMedicine.name}
                </h3>
                <span className="inline-block mt-1 px-2 py-0.5 text-xs font-semibold rounded bg-teal-50 dark:bg-teal-950 text-teal-700 dark:text-teal-300">
                  {selectedMedicine.formulation} · {selectedMedicine.strength || "Unspecified"}
                </span>
              </div>
              <button
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded"
                onClick={() => setSelectedMedicine(null)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-slate-400 block">Generic / Molecule</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {selectedMedicine.generic_name || "—"}
                </span>
              </div>

              <div>
                <span className="text-slate-400 block">Brand</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {selectedMedicine.brand_name || "—"}
                </span>
              </div>

              <div className="col-span-2">
                <span className="text-slate-400 block">Composition</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {selectedMedicine.composition || "—"}
                </span>
              </div>

              <div>
                <span className="text-slate-400 block">Manufacturer</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {selectedMedicine.manufacturer || "—"}
                </span>
              </div>

              <div>
                <span className="text-slate-400 block">Category</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {selectedMedicine.category || "—"}
                </span>
              </div>

              <div>
                <span className="text-slate-400 block">Pack Size</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {selectedMedicine.pack_size || "—"}
                </span>
              </div>

              <div>
                <span className="text-slate-400 block">MRP</span>
                <span className="font-semibold text-slate-800 dark:text-slate-100 font-mono">
                  {selectedMedicine.mrp != null ? `₹${selectedMedicine.mrp.toFixed(2)}` : "—"}
                </span>
              </div>

              {selectedMedicine.storage_instructions && (
                <div className="col-span-2">
                  <span className="text-slate-400 block">Storage Instructions</span>
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {selectedMedicine.storage_instructions}
                  </span>
                </div>
              )}

              {selectedMedicine.default_instructions && (
                <div className="col-span-2">
                  <span className="text-slate-400 block">Default Instructions</span>
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {selectedMedicine.default_instructions}
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
              <Button
                variant="secondary"
                icon={Trash2}
                onClick={() => setDeleteConfirmId(selectedMedicine.id)}
              >
                Archive
              </Button>
              <Button variant="primary" onClick={() => setSelectedMedicine(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* =======================================================
          MODAL: CONFIRM ARCHIVE
      ======================================================= */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-800 max-w-sm w-full p-6 space-y-4">
            <div className="w-10 h-10 rounded-full bg-rose-50 dark:bg-rose-950/60 text-rose-600 flex items-center justify-center">
              <AlertTriangle size={20} />
            </div>
            <div>
              <h4 className="font-bold text-slate-900 dark:text-slate-100">
                Archive Medicine?
              </h4>
              <p className="text-xs text-slate-500 mt-1">
                This medicine will be hidden from consultations and autocomplete. Existing prescriptions
                already created will not be affected.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setDeleteConfirmId(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => handleArchiveMedicine(deleteConfirmId)}
              >
                Yes, Archive
              </Button>
            </div>
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
                Are you sure you want to deactivate all medicines imported from this batch?
                Other manual additions and batches will remain untouched.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setRollbackConfirmBatchId(null)}>
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
