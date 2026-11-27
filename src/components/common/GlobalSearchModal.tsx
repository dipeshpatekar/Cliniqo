import { useState, useMemo, useEffect, useRef, memo } from "react"
import { Search, X, User, ArrowRight } from "lucide-react"
import type { Patient } from "../../types"
import { getPublicPatientId, mapLocalRecordToPatient } from "../../types"
import { getLocalPatientsPage, isTauriDesktop } from "../../desktop/desktop-bridge"

export interface GlobalPatientSearchProps {
  patients: Patient[]
  onSelectPatient: (patient: Patient) => void
  clinicId?: string | null
  placeholder?: string
  className?: string
  initialOpen?: boolean
}

export const GlobalPatientSearch = memo(function GlobalPatientSearch({
  patients,
  onSelectPatient,
  clinicId,
  placeholder = "Search patient by name, ID, or phone...",
  className,
  initialOpen = false,
}: GlobalPatientSearchProps) {
  const [query, setQuery] = useState("")
  const [isOpen, setIsOpen] = useState(initialOpen)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [remoteResults, setRemoteResults] = useState<Patient[] | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestSeqRef = useRef(0)

  const useDesktopSearch = Boolean(clinicId && isTauriDesktop())

  useEffect(() => {
    if (!useDesktopSearch || !clinicId || !isOpen) {
      return
    }
    const seq = ++requestSeqRef.current
    const trimmed = query.trim()
    const timer = window.setTimeout(() => {
      setIsSearching(true)
      getLocalPatientsPage({
        clinic_id: clinicId,
        query: trimmed || null,
        sort: "Created Date (newest first)",
        limit: trimmed ? 15 : 8,
        offset: 0,
      })
        .then((res) => {
          if (requestSeqRef.current !== seq) return
          setRemoteResults(res.items.map(mapLocalRecordToPatient))
        })
        .catch(() => {
          if (requestSeqRef.current !== seq) return
          setRemoteResults(null)
        })
        .finally(() => {
          if (requestSeqRef.current === seq) {
            setIsSearching(false)
          }
        })
    }, trimmed ? 140 : 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [useDesktopSearch, clinicId, isOpen, query])

  // Filter patients by name, ID, or phone (uses SQLite-indexed search when running in Tauri desktop)
  const filteredPatients = useMemo(() => {
    if (useDesktopSearch && remoteResults !== null) {
      return remoteResults
    }
    const q = query.trim().toLowerCase()
    if (!q) return patients.slice(0, 8)
    const qClean = q.replace(/\s+/g, "")
    return patients
      .filter((p) => {
        const publicId = getPublicPatientId(p).toLowerCase()
        const id = p.id.toLowerCase()
        const name = p.name.toLowerCase()
        const phone = (p.phone || "").toLowerCase().replace(/\s+/g, "")
        return (
          name.includes(q) ||
          id.includes(q) ||
          publicId.includes(q) ||
          phone.includes(qClean) ||
          (p.phone || "").toLowerCase().includes(q)
        )
      })
      .slice(0, 15)
  }, [useDesktopSearch, remoteResults, patients, query])

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [filteredPatients.length])

  // Auto-scroll selected item into view
  useEffect(() => {
    if (isOpen && listRef.current && filteredPatients.length > 0) {
      const activeEl = listRef.current.children[
        selectedIndex
      ] as HTMLElement | undefined
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest" })
      }
    }
  }, [selectedIndex, isOpen, filteredPatients.length])

  // Click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [])

  // Listen for global shortcut (Ctrl + K)
  useEffect(() => {
    const handleGlobalShortcut = (e: Event) => {
      const customEvent = e as CustomEvent<{ action: string }>
      if (customEvent.detail?.action === "global-patient-search") {
        inputRef.current?.focus()
        inputRef.current?.select()
        setIsOpen(true)
      }
    }
    window.addEventListener("cliniqo-shortcut", handleGlobalShortcut)
    return () => {
      window.removeEventListener("cliniqo-shortcut", handleGlobalShortcut)
    }
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      if (!isOpen) {
        setIsOpen(true)
      } else {
        setSelectedIndex((prev) =>
          prev < filteredPatients.length - 1 ? prev + 1 : 0,
        )
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      if (!isOpen) {
        setIsOpen(true)
      } else {
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : filteredPatients.length - 1,
        )
      }
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (isOpen && filteredPatients[selectedIndex]) {
        onSelectPatient(filteredPatients[selectedIndex])
        setIsOpen(false)
        setQuery("")
        inputRef.current?.blur()
      }
    } else if (e.key === "Escape") {
      e.preventDefault()
      setIsOpen(false)
      inputRef.current?.blur()
    }
  }

  const handleSelect = (patient: Patient) => {
    onSelectPatient(patient)
    setIsOpen(false)
    setQuery("")
    inputRef.current?.blur()
  }

  return (
    <div
      ref={containerRef}
      className={`global-patient-search-container ${className || ""}`.trim()}
      style={{ position: "relative" }}
    >
      <div
        className="global-patient-search-bar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          backgroundColor: "var(--surface, #ffffff)",
          border: isOpen
            ? "1.5px solid var(--teal-primary, #068D94)"
            : "1px solid var(--border, #e2e8f0)",
          borderRadius: "13px",
          padding: "0 12px",
          height: "40px",
          width: "280px",
          maxWidth: "100%",
          boxShadow: isOpen
            ? "0 0 0 2px rgba(6, 141, 148, 0.15)"
            : "0 1px 2px rgba(0, 0, 0, 0.03)",
          transition: "border-color 0.15s ease, box-shadow 0.15s ease",
        }}
      >
        <Search
          size={16}
          style={{ color: "var(--teal-primary, #068D94)", flexShrink: 0 }}
        />
        <input
          id="global-patient-search"
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIsOpen(true)
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="Global patient search"
          autoComplete="off"
          className="global-patient-search-input"
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            fontSize: "13px",
            background: "transparent",
            color: "var(--ink, #0f172a)",
          }}
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("")
              inputRef.current?.focus()
            }}
            className="global-patient-search-clear"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--muted, #64748b)",
              display: "flex",
              alignItems: "center",
              padding: 0,
            }}
            aria-label="Clear patient search"
          >
            <X size={14} />
          </button>
        ) : (
          <span
            className="global-patient-search-shortcut"
            style={{
              fontSize: "10.5px",
              color: "var(--muted, #64748b)",
              backgroundColor: "var(--surface-muted, #f1f5f9)",
              border: "1px solid var(--line, #e2e8f0)",
              borderRadius: "4px",
              padding: "1px 5px",
              lineHeight: "1.2",
              fontWeight: 500,
              userSelect: "none",
              flexShrink: 0,
            }}
          >
            Ctrl+K
          </span>
        )}
      </div>

      {isOpen && (
        <div
          className="global-patient-search-dropdown"
          role="listbox"
          aria-label="Patient search results"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: "350px",
            maxWidth: "calc(100vw - 32px)",
            backgroundColor: "var(--surface, #ffffff)",
            border: "1px solid var(--line, #e2e8f0)",
            borderRadius: "10px",
            boxShadow:
              "0 12px 30px -4px rgba(0, 0, 0, 0.16), 0 4px 12px -2px rgba(0, 0, 0, 0.06)",
            zIndex: 9999,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            ref={listRef}
            className="global-patient-search-list"
            style={{
              maxHeight: "360px",
              overflowY: "auto",
              padding: "4px",
              display: "flex",
              flexDirection: "column",
              gap: "2px",
            }}
          >
            {filteredPatients.length === 0 ? (
              <div
                className="global-patient-search-empty"
                style={{
                  padding: "20px 16px",
                  textAlign: "center",
                  color: "var(--muted, #64748b)",
                  fontSize: "13px",
                }}
              >
                {isSearching
                  ? "Searching patients..."
                  : `No patients found matching "${query}".`}
              </div>
            ) : (
              filteredPatients.map((p, idx) => {
                const isSelected = idx === selectedIndex
                return (
                  <div
                    key={p.id}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(p)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`global-patient-search-item ${isSelected ? "selected" : ""}`.trim()}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "7px 10px",
                      borderRadius: "6px",
                      cursor: "pointer",
                      backgroundColor: isSelected
                        ? "rgba(6, 141, 148, 0.12)"
                        : "transparent",
                      border: isSelected
                        ? "1px solid rgba(6, 141, 148, 0.25)"
                        : "1px solid transparent",
                      transition: "background-color 0.1s ease",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        minWidth: 0,
                      }}
                    >
                      <div
                        className="global-patient-search-avatar"
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          backgroundColor: "rgba(6, 141, 148, 0.1)",
                          color: "var(--teal-primary, #068D94)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: 600,
                          fontSize: "11px",
                          flexShrink: 0,
                        }}
                      >
                        {p.initials || <User size={13} />}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          minWidth: 0,
                        }}
                      >
                        <span
                          className="global-patient-search-name"
                          style={{
                            fontWeight: 600,
                            fontSize: "13px",
                            color: "var(--ink, #0f172a)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p.name}
                        </span>
                        <span
                          className="global-patient-search-badge"
                          style={{
                            fontSize: "11px",
                            fontWeight: 500,
                            color: "var(--muted, #64748b)",
                            backgroundColor:
                              "var(--surface-muted, rgba(0,0,0,0.05))",
                            padding: "1px 5px",
                            borderRadius: "4px",
                            flexShrink: 0,
                          }}
                        >
                          {getPublicPatientId(p)}
                        </span>
                      </div>
                    </div>
                    <div
                      className="global-patient-search-arrow"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        color: isSelected
                          ? "var(--teal-primary, #068D94)"
                          : "var(--muted, #94a3b8)",
                        marginLeft: "8px",
                        flexShrink: 0,
                      }}
                    >
                      <ArrowRight size={14} />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
})

// Backward-compatible alias
export const GlobalSearchModal = GlobalPatientSearch
export default GlobalPatientSearch
