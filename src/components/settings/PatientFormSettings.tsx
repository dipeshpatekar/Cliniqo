import type { PatientFormFieldPreferences } from "../../types"
import { cn } from "../../utils/cn"

export interface PatientFormSettingsProps {
  preferences: PatientFormFieldPreferences
  onChange: (preferences: PatientFormFieldPreferences) => void
}

const FIELDS: {
  key: keyof PatientFormFieldPreferences
  label: string
}[] = [
  { key: "showDob", label: "Date of Birth" },
  { key: "showPhone", label: "Mobile Number" },
  { key: "showAlternatePhone", label: "Alternate Mobile Number" },
  { key: "showAddress", label: "Address" },
]

export function PatientFormSettings({
  preferences,
  onChange,
}: PatientFormSettingsProps) {
  const toggle = (key: keyof PatientFormFieldPreferences) => {
    onChange({
      ...preferences,
      [key]: !preferences[key],
    })
  }

  return (
    <section className="settings-section">
      <div className="settings-title">
        <h2>Patient form fields</h2>
      </div>

      <div
        className="settings-toggle-list"
        role="group"
        aria-label="Patient form fields visibility"
      >
        {FIELDS.map(({ key, label }) => {
          const enabled = Boolean(preferences[key])
          return (
            <button
              key={key}
              type="button"
              className="settings-toggle-row"
              role="switch"
              aria-checked={enabled}
              aria-label={`Toggle ${label}`}
              onClick={() => toggle(key)}
            >
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">{label}</span>
              </div>
              <div className="settings-toggle-control">
                <span className={cn("settings-toggle-state", enabled && "on")}>
                  {enabled ? "ON" : "OFF"}
                </span>
                <span
                  className={cn("toggle-switch", enabled && "active")}
                  aria-hidden="true"
                >
                  <span />
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export default PatientFormSettings
