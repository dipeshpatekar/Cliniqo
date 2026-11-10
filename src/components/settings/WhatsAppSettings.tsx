import { useState } from "react"
import { MessageCircle } from "lucide-react"
import { Button, StatusPill } from "../common"

export function WhatsAppSettings() {
  const [tested, setTested] = useState(false)

  return (
    <section className="settings-section">
      <div className="settings-title with-status">
        <div>
          <h2>WhatsApp configuration</h2>
        </div>
        <StatusPill tone="warning">Not connected</StatusPill>
      </div>
      <div className="integration-card">
        <span>
          <MessageCircle size={21} />
        </span>
        <div>
          <strong>WhatsApp Business provider</strong>
          {tested && <p>Frontend check complete · No provider request sent</p>}
        </div>
        <Button size="sm" variant="secondary" onClick={() => setTested(true)}>
          {tested ? "UI checked" : "Check UI state"}
        </Button>
      </div>
      <h3 className="subsection-title">Delivery history</h3>
      <div className="empty-state compact">
        <MessageCircle size={24} />
        <h2>No provider delivery data</h2>
        <p>
          Delivery records will appear only after a backend integration is
          connected.
        </p>
      </div>
    </section>
  )
}

export default WhatsAppSettings
