import { Moon, Sun } from "lucide-react"
import { cn } from "../../utils/cn"

export interface AppearanceSettingsProps {
  darkMode: boolean
  onDarkModeChange: (enabled: boolean) => void
}

export function AppearanceSettings({
  darkMode,
  onDarkModeChange,
}: AppearanceSettingsProps) {
  return (
    <section className="settings-section">
      <div className="settings-title">
        <h2>Appearance</h2>
        <p>Choose how the clinic workspace appears on this device.</p>
      </div>
      <div className="appearance-card">
        <span className="appearance-icon">
          {darkMode ? <Moon size={21} /> : <Sun size={21} />}
        </span>
        <div>
          <strong>Dark mode</strong>
          <p>
            Use a darker interface to reduce glare in low-light environments.
          </p>
        </div>
        <button
          className={cn("theme-switch", darkMode && "active")}
          role="switch"
          aria-checked={darkMode}
          aria-label="Toggle dark mode"
          onClick={() => onDarkModeChange(!darkMode)}
        >
          <span />
        </button>
      </div>
      <div className="appearance-preview" aria-hidden="true">
        <div className="preview-sidebar">
          <span />
          <span />
          <span />
        </div>
        <div className="preview-workspace">
          <span />
          <div>
            <i />
            <i />
            <i />
          </div>
          <div>
            <i />
            <i />
          </div>
        </div>
      </div>
      <div className="info-callout">
        <Sun size={17} />
        <p>
          Your appearance preference is saved on this device and applied
          automatically the next time you open Cliniqo.
        </p>
      </div>
    </section>
  )
}

export default AppearanceSettings
