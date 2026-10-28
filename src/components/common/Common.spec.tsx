import { describe, it, expect } from "vitest"
import { renderToString } from "react-dom/server"
import {
  Button,
  IconButton,
  Field,
  TextInput,
  SelectInput,
  StatusPill,
  Modal,
  ConfirmDialog,
} from "./index"
import { User } from "lucide-react"

describe("Common Components", () => {
  describe("Button", () => {
    it("renders with default props and text", () => {
      const html = renderToString(<Button>Click me</Button>)
      expect(html).toContain("btn")
      expect(html).toContain("btn-primary")
      expect(html).toContain("Click me")
      expect(html).not.toContain("disabled")
    })

    it("renders loading state with spinner and disabled attribute", () => {
      const html = renderToString(<Button loading>Saving...</Button>)
      expect(html).toContain("disabled")
      expect(html).toContain("spin")
      expect(html).toContain("Saving...")
    })

    it("renders icon when provided", () => {
      const html = renderToString(<Button icon={User}>Profile</Button>)
      expect(html).toContain("Profile")
      expect(html).toContain("<svg")
    })

    it("renders different variants and sizes", () => {
      const htmlSecondary = renderToString(
        <Button variant="secondary" size="sm">
          Small
        </Button>,
      )
      expect(htmlSecondary).toContain("btn-secondary")
      expect(htmlSecondary).toContain("btn-sm")

      const htmlDanger = renderToString(
        <Button variant="danger" size="lg">
          Delete
        </Button>,
      )
      expect(htmlDanger).toContain("btn-danger")
      expect(htmlDanger).toContain("btn-lg")
    })
  })

  describe("IconButton", () => {
    it("renders with aria-label and icon", () => {
      const html = renderToString(
        <IconButton label="Edit item">
          <User size={16} />
        </IconButton>,
      )
      expect(html).toContain('aria-label="Edit item"')
      expect(html).toContain('title="Edit item"')
      expect(html).toContain("icon-btn")
    })
  })

  describe("Field & Inputs", () => {
    it("renders Field with label and required star", () => {
      const html = renderToString(
        <Field label="Full name" required hint="Must match official ID">
          <TextInput value="John Doe" onChange={() => {}} />
        </Field>,
      )
      expect(html).toContain("Full name")
      expect(html).toContain("*")
      expect(html).toContain("Must match official ID")
      expect(html).toContain('value="John Doe"')
    })

    it("renders SelectInput with options", () => {
      const html = renderToString(
        <SelectInput value="M" onChange={() => {}}>
          <option value="M">Male</option>
          <option value="F">Female</option>
        </SelectInput>,
      )
      expect(html).toContain("select")
      expect(html).toContain("Male")
      expect(html).toContain("Female")
    })
  })

  describe("StatusPill", () => {
    it("renders correct tone classes", () => {
      const htmlSuccess = renderToString(
        <StatusPill tone="success">Active</StatusPill>,
      )
      expect(htmlSuccess).toContain("status-pill")
      expect(htmlSuccess).toContain("success")
      expect(htmlSuccess).toContain("Active")

      const htmlWarning = renderToString(
        <StatusPill tone="warning">Pending</StatusPill>,
      )
      expect(htmlWarning).toContain("warning")
      expect(htmlWarning).toContain("Pending")
    })
  })

  describe("Modal & ConfirmDialog", () => {
    it("renders Modal with accessible dialog roles and titles", () => {
      const html = renderToString(
        <Modal
          title="Important Notice"
          description="Please review carefully before proceeding."
          onClose={() => {}}
        >
          <p>Dialog body content</p>
        </Modal>,
      )
      expect(html).toContain('role="dialog"')
      expect(html).toContain('aria-modal="true"')
      expect(html).toContain("Important Notice")
      expect(html).toContain("Please review carefully before proceeding.")
      expect(html).toContain("Dialog body content")
    })

    it("renders ConfirmDialog when isOpen is true", () => {
      const html = renderToString(
        <ConfirmDialog
          isOpen={true}
          title="Confirm Patient Record Deletion"
          description="Are you sure you want to permanently delete this record?"
          confirmLabel="Delete Now"
          confirmVariant="danger"
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      )
      expect(html).toContain("Confirm Patient Record Deletion")
      expect(html).toContain(
        "Are you sure you want to permanently delete this record?",
      )
      expect(html).toContain("Delete Now")
      expect(html).toContain("btn-danger")
      expect(html).toContain("Cancel")
    })

    it("renders nothing when ConfirmDialog isOpen is false", () => {
      const html = renderToString(
        <ConfirmDialog
          isOpen={false}
          title="Hidden Dialog"
          description="Hidden"
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      )
      expect(html).toBe("")
    })
  })
})
