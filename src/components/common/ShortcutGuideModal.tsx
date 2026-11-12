import { useState, useMemo, useEffect } from "react"
import { Search, X, Command } from "lucide-react"
import {
  SHORTCUT_DEFINITIONS,
  type ShortcutCategory,
  type ShortcutItem,
} from "../../utils/keyboardShortcuts"
import { Button } from "./index"

interface ShortcutGuideModalProps {
  isOpen: boolean
  onClose: () => void
}

export function ShortcutGuideModal({ isOpen, onClose }: ShortcutGuideModalProps) {
  const [search, setSearch] = useState("")
  const [selectedCategory, setSelectedCategory] = useState<
    ShortcutCategory | "All"
  >("All")

  const categories: (ShortcutCategory | "All")[] = [
    "All",
    "Global",
    "Consultation & Prescription",
    "Billing & Medicine Library",
  ]

  // Direct Escape listener when modal is open
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [isOpen, onClose])

  const filteredShortcuts = useMemo(() => {
    const query = search.trim().toLowerCase()
    return SHORTCUT_DEFINITIONS.filter((item) => {
      const matchesCategory =
        selectedCategory === "All" || item.category === selectedCategory
      if (!matchesCategory) return false

      if (!query) return true
      return (
        item.label.toLowerCase().includes(query) ||
        item.displayKeys.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.category.toLowerCase().includes(query) ||
        (item.context && item.context.toLowerCase().includes(query))
      )
    })
  }, [search, selectedCategory])

  if (!isOpen) return null

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcut-guide-title"
    >
      <div
        className="modal-card shortcut-guide-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 94vw)",
          height: "min(620px, 85vh)",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          padding: 0,
          overflow: "hidden",
          borderRadius: "14px",
          background: "var(--surface, #ffffff)",
          border: "1px solid var(--line, #e2e8f0)",
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.2)",
        }}
      >
        {/* Header */}
        <div
          className="modal-head"
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--line, #e2e8f0)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "8px",
                backgroundColor: "var(--primary-soft, rgba(6, 141, 148, 0.12))",
                color: "var(--primary, #068D94)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Command size={18} />
            </div>
            <div>
              <h2
                id="shortcut-guide-title"
                style={{
                  fontSize: "16px",
                  fontWeight: 600,
                  margin: 0,
                  color: "var(--ink, #0f172a)",
                }}
              >
                Keyboard Shortcuts
              </h2>
              <p
                style={{
                  fontSize: "12px",
                  color: "var(--muted, #64748b)",
                  margin: "2px 0 0",
                }}
              >
                Quickly navigate and execute actions without touching your mouse
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shortcut reference"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--muted, #64748b)",
              cursor: "pointer",
              padding: "6px",
              borderRadius: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Filter bar & Search */}
        <div
          style={{
            padding: "14px 20px",
            borderBottom: "1px solid var(--line, #e2e8f0)",
            background: "var(--surface-alt, #f8fafc)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              background: "var(--surface, #ffffff)",
              border: "1px solid var(--line, #e2e8f0)",
              borderRadius: "8px",
              padding: "0 12px",
              height: "38px",
            }}
          >
            <Search size={16} style={{ color: "var(--muted, #64748b)", flexShrink: 0 }} />
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search shortcuts by action or key (e.g. search, vitals, bill)..."
              aria-label="Search keyboard shortcuts"
              style={{
                border: "none",
                outline: "none",
                background: "transparent",
                width: "100%",
                fontSize: "13px",
                color: "var(--ink, #0f172a)",
              }}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--muted, #64748b)",
                  padding: "2px",
                }}
                aria-label="Clear shortcut search"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div
            style={{
              display: "flex",
              gap: "8px",
              marginTop: "10px",
              overflowX: "auto",
              paddingBottom: "2px",
            }}
          >
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                style={{
                  padding: "4px 12px",
                  borderRadius: "16px",
                  fontSize: "12px",
                  fontWeight: selectedCategory === cat ? 600 : 500,
                  border: "1px solid",
                  borderColor:
                    selectedCategory === cat
                      ? "var(--primary, #068D94)"
                      : "var(--line, #e2e8f0)",
                  backgroundColor:
                    selectedCategory === cat
                      ? "var(--primary-soft, rgba(6, 141, 148, 0.12))"
                      : "var(--surface, #ffffff)",
                  color:
                    selectedCategory === cat
                      ? "var(--primary, #068D94)"
                      : "var(--ink, #0f172a)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "all 0.15s ease",
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable Shortcut List */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "14px 20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          {filteredShortcuts.length === 0 ? (
            <div
              style={{
                padding: "36px 0",
                textAlign: "center",
                color: "var(--muted, #64748b)",
                fontSize: "13px",
              }}
            >
              No keyboard shortcuts found matching &quot;{search}&quot;.
            </div>
          ) : (
            filteredShortcuts.map((item: ShortcutItem) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  border: "1px solid var(--line, #e2e8f0)",
                  backgroundColor: "var(--surface, #ffffff)",
                  gap: "14px",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "2px",
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: "13px",
                        color: "var(--ink, #0f172a)",
                      }}
                    >
                      {item.label}
                    </span>
                    {item.context && (
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          backgroundColor: "rgba(6, 141, 148, 0.08)",
                          color: "var(--primary, #068D94)",
                        }}
                      >
                        {item.context}
                      </span>
                    )}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "var(--muted, #64748b)",
                      lineHeight: "1.4",
                    }}
                  >
                    {item.description}
                  </p>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    flexShrink: 0,
                  }}
                >
                  {item.displayKeys.split(" + ").map((keyPart, idx, arr) => (
                    <span
                      key={keyPart}
                      style={{ display: "inline-flex", alignItems: "center" }}
                    >
                      <kbd
                        style={{
                          display: "inline-block",
                          padding: "3px 8px",
                          fontSize: "12px",
                          fontWeight: 600,
                          fontFamily: "ui-monospace, monospace",
                          lineHeight: "1",
                          color: "var(--ink, #0f172a)",
                          backgroundColor: "#f1f5f9",
                          border: "1px solid var(--line, #e2e8f0)",
                          borderRadius: "5px",
                          boxShadow: "0 1px 1px rgba(0,0,0,0.06)",
                        }}
                      >
                        {keyPart}
                      </kbd>
                      {idx < arr.length - 1 && (
                        <span
                          style={{
                            margin: "0 4px",
                            fontSize: "12px",
                            color: "var(--muted, #64748b)",
                          }}
                        >
                          +
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--line, #e2e8f0)",
            backgroundColor: "var(--surface-alt, #f8fafc)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "12px",
            color: "var(--muted, #64748b)",
            flexShrink: 0,
          }}
        >
          <span>
            Tip: In consultation, press{" "}
            <kbd
              style={{
                padding: "1px 5px",
                fontFamily: "monospace",
                borderRadius: "3px",
                border: "1px solid var(--line, #e2e8f0)",
                background: "white",
              }}
            >
              1
            </kbd>
            –
            <kbd
              style={{
                padding: "1px 5px",
                fontFamily: "monospace",
                borderRadius: "3px",
                border: "1px solid var(--line, #e2e8f0)",
                background: "white",
              }}
            >
              5
            </kbd>{" "}
            in Frequency to pick frequency quickly.
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={onClose}
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}
