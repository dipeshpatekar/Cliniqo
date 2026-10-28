import { cn } from "../../utils/cn"

export interface CompactFieldProps {
  label: string
  suffix: string
  placeholder: string
  secondaryPlaceholder?: string
  value: string
  secondaryValue?: string
  onChange: (value: string) => void
  onSecondaryChange?: (value: string) => void
  step?: string
  wide?: boolean
}

export function CompactField({
  label,
  suffix,
  placeholder,
  secondaryPlaceholder,
  value,
  secondaryValue = "",
  onChange,
  onSecondaryChange,
  step = "1",
  wide = false,
}: CompactFieldProps) {
  return (
    <label className={cn("compact-field", wide && "wide")}>
      <span>{label}</span>
      <div>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={secondaryPlaceholder ? `${label} systolic` : label}
        />
        {secondaryPlaceholder && (
          <>
            <b>/</b>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              value={secondaryValue}
              onChange={(event) => onSecondaryChange?.(event.target.value)}
              placeholder={secondaryPlaceholder}
              aria-label={`${label} diastolic`}
            />
          </>
        )}
        <em>{suffix}</em>
      </div>
    </label>
  )
}

export default CompactField
