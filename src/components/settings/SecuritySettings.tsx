import { ShieldCheck } from "lucide-react"
import { Button, StatusPill } from "../common"
import { formatDateTimeDDMMYYYY } from "../../types"
import type { DesktopSessionContext } from "../../desktop/desktop-bridge"

export interface SecuritySettingsProps {
  logout: () => void
  desktopSession?: DesktopSessionContext | null
}

export function SecuritySettings({
  logout,
  desktopSession,
}: SecuritySettingsProps) {
  return (
    <section className="settings-section">
      <div className="settings-title">
        <h2>Security</h2>
        {!desktopSession && (
          <p>Authentication and clinic access controls require a backend.</p>
        )}
      </div>
      <div className="security-row">
        <span>
          <ShieldCheck size={20} />
        </span>
        <div>
          <strong>
            {desktopSession
              ? `Verified Session: ${desktopSession.doctor_name}`
              : "Frontend authentication demo"}
          </strong>
          <p>
            {desktopSession
              ? `Clinic: ${desktopSession.clinic_id} • Role: ${
                  desktopSession.role
                } • Expires: ${formatDateTimeDDMMYYYY(
                  new Date(desktopSession.expires_at * 1000),
                )}`
              : "No verified session, account, role, or clinic access boundary is active."}
          </p>
        </div>
        <StatusPill tone={desktopSession ? "success" : "warning"}>
          {desktopSession ? "Active (RS256)" : "Demo only"}
        </StatusPill>
      </div>
      <div className="danger-zone">
        <div>
          <strong>
            {desktopSession ? "End desktop session" : "Return to sign in"}
          </strong>
          {!desktopSession && (
            <p>
              This clears the current UI route; no server session exists to
              revoke.
            </p>
          )}
        </div>
        <Button variant="danger" onClick={logout}>
          Log out
        </Button>
      </div>
    </section>
  )
}

export default SecuritySettings
