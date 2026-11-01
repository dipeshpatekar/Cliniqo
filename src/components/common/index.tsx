import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react"
import { cn } from "../../utils/cn"
import {
  Check,
  ChevronDown,
  HeartPulse,
  Search,
  X,
  Loader2,
} from "lucide-react"

export function Button({
  children,
  variant = "primary",
  size = "md",
  icon: Icon,
  className,
  loading = false,
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger"
  size?: "sm" | "md" | "lg"
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>
  loading?: boolean
}) {
  return (
    <button
      className={cn(
        "btn",
        `btn-${variant}`,
        size === "sm" && "btn-sm",
        size === "lg" && "btn-lg",
        loading && "opacity-80 cursor-wait",
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <Loader2 size={size === "sm" ? 15 : 17} className="animate-spin" />
      ) : (
        Icon && <Icon size={size === "sm" ? 15 : 17} strokeWidth={2} />
      )}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  children: ReactNode
}) {
  return (
    <button
      className={cn("icon-btn", className)}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  required,
  hint,
  error,
  children,
  className,
}: {
  label: string
  required?: boolean
  hint?: string
  error?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn("field", className)}>
      <span className="field-label">
        {label}
        {required && <span className="required"> *</span>}
      </span>
      {children}
      {(error || hint) && (
        <span className={cn("field-hint", error && "error-text")}>
          {error || hint}
        </span>
      )}
    </label>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />
}

export function SelectInput(
  props: React.SelectHTMLAttributes<HTMLSelectElement>,
) {
  return <select className="input select-input" {...props} />
}

export type SearchOptionItem = {
  value: string
  label?: string
  badge?: string
  subtitle?: string
  meta?: any
}

export function SearchableOptionSelect({
  id,
  value,
  options,
  onChange,
  onSelectOption,
  placeholder,
  ariaLabel,
  emptyMessage,
}: {
  id: string
  value: string
  options: (string | SearchOptionItem)[]
  onChange: (value: string) => void
  onSelectOption?: (option: SearchOptionItem) => void
  placeholder: string
  ariaLabel: string
  emptyMessage: string
}) {
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = `searchable-options-${id}`

  // Normalize options into SearchOptionItem
  const normalizedOptions: SearchOptionItem[] = options.map((opt) =>
    typeof opt === "string" ? { value: opt, label: opt } : opt,
  )

  // Deduplicate by value
  const uniqueOptions = Array.from(
    new Map(normalizedOptions.map((item) => [item.value, item])).values(),
  )

  const lowerVal = value.toLowerCase()
  const filteredOptions = uniqueOptions.filter((option) =>
    (option.label || option.value).toLowerCase().includes(lowerVal) ||
    (option.subtitle && option.subtitle.toLowerCase().includes(lowerVal)),
  )

  // Ensure highlighted index stays in bounds when filteredOptions change
  useEffect(() => {
    if (open && filteredOptions.length > 0) {
      if (highlightedIndex < 0 || highlightedIndex >= filteredOptions.length) {
        setHighlightedIndex(0)
      }
    } else if (!open) {
      setHighlightedIndex(-1)
    }
  }, [open, filteredOptions.length])

  // Auto-scroll highlighted option into view
  useEffect(() => {
    if (open && highlightedIndex >= 0 && listRef.current) {
      const activeEl = listRef.current.children[highlightedIndex] as HTMLElement
      if (activeEl && typeof activeEl.scrollIntoView === "function") {
        activeEl.scrollIntoView({ block: "nearest" })
      }
    }
  }, [highlightedIndex, open])

  const selectOption = (option: SearchOptionItem) => {
    onChange(option.value)
    if (onSelectOption) {
      onSelectOption(option)
    }
    setOpen(false)
    setHighlightedIndex(-1)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        setHighlightedIndex(0)
      } else if (filteredOptions.length > 0) {
        setHighlightedIndex((prev) =>
          prev < filteredOptions.length - 1 ? prev + 1 : 0,
        )
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      if (open && filteredOptions.length > 0) {
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : filteredOptions.length - 1,
        )
      }
    } else if (e.key === "Enter") {
      if (open && highlightedIndex >= 0 && highlightedIndex < filteredOptions.length) {
        e.preventDefault()
        selectOption(filteredOptions[highlightedIndex])
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault()
        setOpen(false)
        setHighlightedIndex(-1)
      }
    }
  }

  return (
    <div className="medicine-combobox">
      <div className="medicine-search-input">
        <Search size={15} />
        <input
          id={id}
          value={value}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && highlightedIndex >= 0
              ? `${listId}-opt-${highlightedIndex}`
              : undefined
          }
          autoComplete="off"
          placeholder={placeholder}
          onFocus={() => {
            setOpen(true)
            const matchIdx = filteredOptions.findIndex(
              (o) =>
                o.value.toLowerCase() === lowerVal ||
                (o.label && o.label.toLowerCase() === lowerVal),
            )
            setHighlightedIndex(matchIdx >= 0 ? matchIdx : 0)
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
          onChange={(event) => {
            onChange(event.target.value)
            setOpen(true)
            setHighlightedIndex(0)
          }}
        />
        <ChevronDown size={15} />
      </div>
      {open && (
        <div ref={listRef} className="medicine-options" id={listId} role="listbox">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option, idx) => {
              const isHighlighted = idx === highlightedIndex
              const isSelected = value === option.value
              return (
                <button
                  key={option.value}
                  id={`${listId}-opt-${idx}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected || isHighlighted}
                  className={cn(isHighlighted && "highlighted")}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectOption(option)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "2px",
                    padding: "8px 12px",
                    textAlign: "left",
                    width: "100%",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                    <span style={{ fontWeight: 500 }}>{option.label || option.value}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      {option.badge && (
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            padding: "1px 6px",
                            borderRadius: "4px",
                            backgroundColor: "#e0f2fe",
                            color: "#0369a1",
                          }}
                        >
                          {option.badge}
                        </span>
                      )}
                      {isSelected && <Check size={15} />}
                    </div>
                  </div>
                  {option.subtitle && (
                    <span style={{ fontSize: "11px", color: "#64748b" }}>
                      {option.subtitle}
                    </span>
                  )}
                </button>
              )
            })
          ) : (
            <div className="medicine-no-results">{emptyMessage}</div>
          )}
        </div>
      )}
    </div>
  )
}


export function TextArea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  return <textarea className="input textarea" {...props} />
}

export function StatusPill({
  tone = "neutral",
  children,
}: {
  tone?: "success" | "warning" | "danger" | "info" | "neutral"
  children: ReactNode
}) {
  return <span className={cn("status-pill", `status-${tone}`)}>{children}</span>
}

export function Modal({
  title,
  description,
  onClose,
  children,
  width = "medium",
}: {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  width?: "small" | "medium"
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className={cn("modal", width === "small" && "modal-small")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-head">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        {children}
      </section>
    </div>
  )
}

export function Logo({ large = false }: { large?: boolean }) {
  return (
    <div className={cn("logo-lockup", large && "logo-large")}>
      <span className="logo-mark">
        <HeartPulse size={large ? 24 : 20} strokeWidth={2.25} />
      </span>
      <span>
        <strong>Cliniqo</strong>
        <small>Doctor workspace</small>
      </span>
    </div>
  )
}

export function FormSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: ComponentType<{ size?: number }>
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="form-section">
      <div className="form-section-head">
        <span>
          <Icon size={18} />
        </span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmText = "Confirm",
  confirmLabel,
  cancelText = "Cancel",
  isDangerous = false,
  confirmVariant,
  isLoading = false,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean
  title: string
  description: string
  confirmText?: string
  confirmLabel?: string
  cancelText?: string
  isDangerous?: boolean
  confirmVariant?: "primary" | "secondary" | "danger"
  isLoading?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!isOpen) return null

  const resolvedConfirmText = confirmLabel || confirmText
  const resolvedDangerous = isDangerous || confirmVariant === "danger"

  return (
    <Modal
      title={title}
      onClose={isLoading ? () => {} : onCancel}
      width="small"
    >
      <div className="p-4 space-y-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {description}
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="secondary"
            disabled={isLoading}
            onClick={onCancel}
          >
            {cancelText}
          </Button>
          <Button
            type="button"
            variant={resolvedDangerous ? "danger" : "primary"}
            loading={isLoading}
            onClick={onConfirm}
          >
            {resolvedConfirmText}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
