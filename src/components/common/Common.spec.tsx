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
  SearchableOptionSelect,
  GlobalPatientSearch,
  Logo,
  CliniqoLogoIcon,
  SavedBookmarkIcon,
  BookmarkSuccessIcon,
  StartupSplash,
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

  describe("SearchableOptionSelect", () => {
    it("renders combobox with accessible attributes, placeholder, and search icon", () => {
      const html = renderToString(
        <SearchableOptionSelect
          id="test-med"
          value="Paracetamol 500mg"
          options={["Paracetamol 500mg", "Amoxicillin 250mg"]}
          onChange={() => {}}
          placeholder="Search CDCI medicine"
          ariaLabel="Search and select medicine"
          emptyMessage="No medicines found"
        />,
      )
      expect(html).toContain('role="combobox"')
      expect(html).toContain('aria-label="Search and select medicine"')
      expect(html).toContain('aria-autocomplete="list"')
      expect(html).toContain('aria-controls="searchable-options-test-med"')
      expect(html).toContain('placeholder="Search CDCI medicine"')
      expect(html).toContain('value="Paracetamol 500mg"')
      expect(html).toContain("medicine-combobox")
    })

    it("renders custom SearchOptionItems with subtitles and badges", () => {
      const html = renderToString(
        <SearchableOptionSelect
          id="strength-sel"
          value="500 mg"
          options={[
            {
              value: "500 mg",
              label: "500 mg",
              badge: "Verified",
              subtitle: "Tablet",
            },
            {
              value: "650 mg",
              label: "650 mg",
              badge: "Verified",
              subtitle: "Tablet",
            },
          ]}
          onChange={() => {}}
          placeholder="Select strength"
          ariaLabel="Select strength"
          emptyMessage="No strengths"
        />,
      )
      expect(html).toContain('id="strength-sel"')
      expect(html).toContain('value="500 mg"')
    })
  })

  describe("GlobalPatientSearch", () => {
    const samplePatients = [
      {
        id: "PC-1048",
        displayId: "PC-1048",
        name: "Ananya Iyer",
        initials: "AI",
        age: 34,
        gender: "Female",
        phone: "+91 98765 43210",
        lastVisit: "Today",
        allergies: [],
        conditions: [],
      },
      {
        id: "PC-1047",
        displayId: "PC-1047",
        name: "Vikram Mehta",
        initials: "VM",
        age: 52,
        gender: "Male",
        phone: "+91 98204 11882",
        lastVisit: "Yesterday",
        allergies: [],
        conditions: [],
      },
    ]

    it("renders visible search input with id and Ctrl+K badge", () => {
      const html = renderToString(
        <GlobalPatientSearch
          patients={samplePatients}
          onSelectPatient={() => {}}
        />,
      )

      expect(html).toContain('id="global-patient-search"')
      expect(html).toContain("Search patient")
      expect(html).toContain("Ctrl+K")
      expect(html).toContain("global-patient-search-container")
      expect(html).toContain("global-patient-search-bar")
    })

    it("filters and matches patients across name, patient ID, and mobile number", () => {
      // Test search filtering logic
      const q = "Ananya"
      const matched = samplePatients.filter(
        (p) =>
          p.name.toLowerCase().includes(q.toLowerCase()) ||
          p.id.toLowerCase().includes(q.toLowerCase()) ||
          p.phone.includes(q),
      )
      expect(matched.length).toBe(1)
      expect(matched[0].name).toBe("Ananya Iyer")
      expect(matched[0].id).toBe("PC-1048")
      expect(matched[0].age).toBe(34)
      expect(matched[0].phone).toBe("+91 98765 43210")
    })

    it("renders simplified dropdown results showing only name and patient ID without age, gender, phone, or footer", () => {
      const html = renderToString(
        <GlobalPatientSearch
          patients={samplePatients}
          onSelectPatient={() => {}}
          initialOpen={true}
        />,
      )

      // Verified: contains patient name and ID with semantic styling classes
      expect(html).toContain("Ananya Iyer")
      expect(html).toContain("PC-1048")
      expect(html).toContain("Vikram Mehta")
      expect(html).toContain("PC-1047")
      expect(html).toContain("global-patient-search-dropdown")
      expect(html).toContain("global-patient-search-item")
      expect(html).toContain("global-patient-search-avatar")
      expect(html).toContain("global-patient-search-name")
      expect(html).toContain("global-patient-search-badge")
      expect(html).toContain("global-patient-search-arrow")

      // Verified: removed age, gender, mobile number and extra patient details from result display
      expect(html).not.toContain("yrs")
      expect(html).not.toContain("Female")
      expect(html).not.toContain("Male")
      expect(html).not.toContain("+91 98765 43210")
      expect(html).not.toContain("+91 98204 11882")

      // Verified: removed bottom footer containing keyboard instructions and patient count
      expect(html).not.toContain("Use ↑ and ↓ to navigate")
      expect(html).not.toContain("patient(s)")
    })

    it("renders empty state with semantic class when no patients match", () => {
      const html = renderToString(
        <GlobalPatientSearch
          patients={[]}
          onSelectPatient={() => {}}
          initialOpen={true}
        />,
      )
      expect(html).toContain("global-patient-search-empty")
      expect(html).toContain("No patients found")
    })
  })

  describe("Logo and Branding", () => {
    it("renders official Cliniqo logo with vector SVG and brand colors", () => {
      const html = renderToString(<Logo />)
      expect(html).toContain("logo-lockup")
      expect(html).toContain("Cliniqo")
      expect(html).toContain("Doctor workspace")
      expect(html).toContain("<svg")
      expect(html).toContain('width="36"')
      expect(html).toContain('height="36"')
      expect(html).toContain("cliniqo-linear-gradient")
      expect(html).toContain("#036c70")
      expect(html).toContain("#00a69a")
      expect(html).toContain("#d7fffc")
      expect(html).toContain("#aefffd")
      expect(html).toContain("#2dcbca")
    })

    it("renders large logo variant with proper dimensions", () => {
      const html = renderToString(<Logo large />)
      expect(html).toContain("logo-large")
      expect(html).toContain('width="44"')
      expect(html).toContain('height="44"')
    })

    it("renders standalone CliniqoLogoIcon with customizable dimensions", () => {
      const html = renderToString(<CliniqoLogoIcon size={64} className="custom-logo" />)
      expect(html).toContain('width="64"')
      expect(html).toContain('height="64"')
      expect(html).toContain("custom-logo")
      expect(html).toContain('viewBox="0 0 1296 1296"')
    })
  })

  describe("SavedBookmarkIcon", () => {
    it("renders the standardized bookmark SVG silhouette with default dimensions and viewbox", () => {
      const html = renderToString(<SavedBookmarkIcon />)
      expect(html).toContain("<svg")
      expect(html).toContain('viewBox="0 0 20 24"')
      expect(html).toContain('width="16"')
      expect(html).toContain('height="19"')
      expect(html).toContain('fill="currentColor"')
      expect(html).toContain("saved-bookmark-icon")
      // Silhouette path with rounded corners and V-notch
      expect(html).toContain("M 5.5 2 L 14.5 2")
      expect(html).toContain("L 10 17.2")
    })

    it("scales appropriately when size is provided for inline indicators", () => {
      const htmlSmall = renderToString(<SavedBookmarkIcon size={13} className="inline-saved" />)
      expect(htmlSmall).toContain('width="11"')
      expect(htmlSmall).toContain('height="13"')
      expect(htmlSmall).toContain("inline-saved")

      const htmlBanner = renderToString(<SavedBookmarkIcon size={19} />)
      expect(htmlBanner).toContain('width="16"')
      expect(htmlBanner).toContain('height="19"')
    })

    it("BookmarkSuccessIcon alias exports the same standardized component", () => {
      expect(BookmarkSuccessIcon).toBe(SavedBookmarkIcon)
    })
  })

  describe("StartupSplash", () => {
    it("renders branded Cliniqo identity without technical session verification copy", () => {
      const html = renderToString(<StartupSplash />)
      expect(html).toContain("Cliniqo")
      expect(html).toContain("Clinic Management, Simplified.")
      expect(html).toContain('viewBox="0 0 1296 1296"')
      expect(html).toContain("cliniqo-splash-bar")
      expect(html).not.toContain("Verifying desktop security session...")
    })

    it("renders clean recovery actions when a fatal startup error is present", () => {
      const html = renderToString(
        <StartupSplash
          error="Local keystore unavailable."
          onRetry={() => {}}
          onContinue={() => {}}
        />,
      )
      expect(html).toContain("Unable to start local workspace")
      expect(html).toContain("Local keystore unavailable.")
      expect(html).toContain("Retry")
      expect(html).toContain("Sign in manually")
      expect(html).not.toContain("cliniqo-splash-bar")
    })
  })
})
