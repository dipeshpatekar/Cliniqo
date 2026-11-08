import { useState, useMemo } from "react"
import { Search, X, Command } from "lucide-react"
import {
  SHORTCUT_DEFINITIONS,
  type ShortcutCategory,
  type ShortcutItem,
} from "../../utils/keyboardShortcuts"

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
          maxWidth: "680px",
          width: "100%",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          padding: 0,
          overflow: "hidden",
        }}
      >
        <div
          className="modal-header"
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "8px",
                backgroundColor: "rgba(6, 141, 148, 0.12)",
                color: "var(--teal-primary, #068D94)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Command size={18} />
            </div>
            <div>
              <h2
                id="shortcut-guide-title"
                style={{ fontSize: "16px", fontWeight: 600, margin: 0 }}
              >
                Keyboard Shortcuts
              </h2>
              <p
                style={{
                  fontSize: "12px",
                  color: "var(--text-muted)",
                  margin: "2px 0 0",
                }}
              >
                Quickly navigate and execute actions without touching your mouse
              </p>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close shortcut reference"
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
          <div className="search-bar" style={{ width: "100%" }}>
            <Search size={16} />
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search shortcuts by action or key (e.g. search, vitals, bill)..."
              aria-label="Search keyboard shortcuts"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-muted)",
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
              marginTop: "12px",
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
                  padding: "5px 12px",
                  borderRadius: "16px",
                  fontSize: "12px",
                  fontWeight: selectedCategory === cat ? 600 : 500,
                  border: "1px solid",
                  borderColor:
                    selectedCategory === cat
                      ? "var(--teal-primary, #068D94)"
                      : "var(--border)",
                  backgroundColor:
                    selectedCategory === cat
                      ? "rgba(6, 141, 148, 0.12)"
                      : "transparent",
                  color:
                    selectedCategory === cat
                      ? "var(--teal-primary, #068D94)"
                      : "var(--text)",
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

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 20px",
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
                color: "var(--text-muted)",
                fontSize: "14px",
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
                  border: "1px solid var(--border)",
                  backgroundColor: "var(--surface)",
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
                        color: "var(--text)",
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
                          color: "var(--teal-primary, #068D94)",
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
                      color: "var(--text-muted)",
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
                          padding: "3px 7px",
                          fontSize: "12px",
                          fontWeight: 600,
                          fontFamily: "monospace",
                          lineHeight: "1",
                          color: "var(--text)",
                          backgroundColor: "var(--surface-muted, rgba(0,0,0,0.06))",
                          border: "1px solid var(--border)",
                          borderRadius: "5px",
                          boxShadow: "0 1px 1px rgba(0,0,0,0.1)",
                        }}
                      >
                        {keyPart}
                      </kbd>
                      {idx < arr.length - 1 && (
                        <span
                          style={{
                            margin: "0 4px",
                            fontSize: "12px",
                            color: "var(--text-muted)",
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

        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
            backgroundColor: "var(--surface-muted, transparent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "12px",
            color: "var(--text-muted)",
          }}
        >
          <span>
            Tip: In consultation, press <kbd style={{ padding: "1px 5px", fontFamily: "monospace", borderRadius: "3px", border: "1px solid var(--border)" }}>1</kbd>–<kbd style={{ padding: "1px 5px", fontFamily: "monospace", borderRadius: "3px", border: "1px solid var(--border)" }}>5</kbd> in Frequency to pick frequency quickly.
          </span>
          <button
            type="button"
            className="button secondary"
            style={{ padding: "6px 14px", fontSize: "12px" }}
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
