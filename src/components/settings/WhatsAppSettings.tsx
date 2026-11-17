import { MessageCircle } from "lucide-react"
import { StatusPill } from "../common"

export function WhatsAppSettings() {
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
        </div>
        <button
          type="button"
          disabled
          className="btn btn-sm btn-secondary opacity-50 cursor-not-allowed select-none"
          aria-disabled="true"
        >
          Connect
        </button>
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
