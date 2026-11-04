import { describe, it, expect } from "vitest"
import { renderToString } from "react-dom/server"
import { InventoryStockSettings } from "./InventoryStockSettings"

describe("InventoryStockSettings Component", () => {
  it("renders stock management section with metrics and separation note", () => {
    const rawHtml = renderToString(
      <InventoryStockSettings
        desktopSession={{
          doctor_id: "doc-1",
          clinic_id: "clinic-test-stock",
          doctor_name: "Dr. Smith",
          doctor_email: "smith@clinic.com",
          role: "OWNER",
          expires_at: 9999999999,
        }}
      />,
    )
    const html = rawHtml.replace(/<!-- -->/g, "")

    expect(html).toContain("Inventory &amp; Stock Management")
    expect(html).toContain("Total Unique Products")
    expect(html).toContain("Total Quantity on Hand")
    expect(html).toContain("Total Valuation")
    expect(html).toContain("Import Stock Report (18-10-26)")
    expect(html).toContain("Strict Architectural Separation Safeguard")
    expect(html).toContain("local_inventory_stock_v1")
  })
})
