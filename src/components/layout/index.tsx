import { useState, useEffect } from "react"
import type { ReactNode } from "react"
import { cn } from "../../utils/cn"
import { IconButton, Logo } from "../common"
export { Logo } from "../common"
import {
  AlertCircle,
  LayoutDashboard,
  Menu,
  Settings,
  Users,
  X,
} from "lucide-react"
import type { Page } from "../../types"
import {
  type DesktopSessionContext,
  getClinicProfile,
  getDoctorProfile,
} from "../../desktop/desktop-bridge"

export function Sidebar({
  page,
  go,
  collapsed,
  onToggle,
  onDoctorProfile,
  desktopSession,
  conflictsCount,
  onOpenConflicts,
}: {
  page: Page
  go: (page: Page) => void
  collapsed: boolean
  onToggle: () => void
  onDoctorProfile: () => void
  desktopSession?: DesktopSessionContext | null
  conflictsCount?: number
  onOpenConflicts?: () => void
}) {
  const [clinicName, setClinicName] = useState<string | null>(null)
  const [doctorName, setDoctorName] = useState<string>(() => {
    return desktopSession?.doctor_name || "Doctor"
  })
  const [doctorPhoto, setDoctorPhoto] = useState<string | null>(() => {
    if (typeof window === "undefined" || !window.localStorage) return null
    return (
      (desktopSession?.doctor_id &&
        window.localStorage.getItem(
          `cliniqo_doctor_photo_${desktopSession.doctor_id}`,
        )) ||
      window.localStorage.getItem("cliniqo_doctor_photo") ||
      null
    )
  })

  useEffect(() => {
    if (!desktopSession?.clinic_id) {
      setClinicName(null)
      return
    }
    getClinicProfile(desktopSession.clinic_id).then((profile) => {
      if (profile?.name) {
        setClinicName(profile.name)
      }
    })
  }, [desktopSession?.clinic_id])

  useEffect(() => {
    if (desktopSession?.doctor_id) {
      getDoctorProfile(desktopSession.doctor_id).then((profile) => {
        if (profile?.full_name) {
          setDoctorName(profile.full_name)
        }
      })
    } else if (desktopSession?.doctor_name) {
      setDoctorName(desktopSession.doctor_name)
    }
  }, [desktopSession?.doctor_id, desktopSession?.doctor_name])

  useEffect(() => {
    if (typeof window === "undefined" || !window.localStorage) return
    const stored =
      (desktopSession?.doctor_id &&
        window.localStorage.getItem(
          `cliniqo_doctor_photo_${desktopSession.doctor_id}`,
        )) ||
      window.localStorage.getItem("cliniqo_doctor_photo")
    setDoctorPhoto(stored || null)
  }, [desktopSession?.doctor_id])

  // Global profile live synchronization listener
  useEffect(() => {
    if (typeof window === "undefined") return
    const handleProfileUpdate = (e: Event) => {
      const customEvent = e as CustomEvent
      const detail = customEvent.detail
      if (!detail) return
      if (detail.type === "doctor" && detail.profile?.full_name) {
        setDoctorName(detail.profile.full_name)
      } else if (detail.type === "clinic" && detail.profile?.name) {
        setClinicName(detail.profile.name)
      } else if (detail.type === "doctor-photo") {
        setDoctorPhoto(detail.photo ?? null)
      }
    }

    window.addEventListener("cliniqo:profile-updated", handleProfileUpdate)
    return () => {
      window.removeEventListener("cliniqo:profile-updated", handleProfileUpdate)
    }
  }, [])

  const nav = [
    { id: "dashboard" as Page, label: "Dashboard", icon: LayoutDashboard },
    { id: "patients" as Page, label: "Patients", icon: Users },
    { id: "settings" as Page, label: "Settings", icon: Settings },
  ]

  return (
    <aside className="sidebar">
      <button
        className="sidebar-logo"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={onToggle}
      >
        <Logo />
      </button>
      {!collapsed && (
        <IconButton
          className="sidebar-close"
          label="Collapse sidebar"
          onClick={onToggle}
        >
          <X size={17} />
        </IconButton>
      )}
      <nav aria-label="Main navigation">
        {nav.map((item) => {
          const isActive =
            page === item.id ||
            (item.id === "patients" &&
              [
                "patient-form",
                "patient-profile",
                "consultation",
                "preview",
                "bill-form",
                "bill-preview",
              ].includes(page))
          return (
            <button
              key={item.id}
              className={cn("nav-item", isActive && "active")}
              onClick={() => go(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>
      {conflictsCount !== undefined && conflictsCount > 0 && (
        <button
          className="mx-3 mb-2.5 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs font-semibold flex items-center gap-1.5 cursor-pointer text-left transition hover:bg-amber-100 dark:hover:bg-amber-900/60"
          onClick={onOpenConflicts}
          title="Review unresolved synchronization conflicts"
        >
          <AlertCircle size={15} className="shrink-0" />
          <span>
            {conflictsCount} Sync Conflict{conflictsCount > 1 ? "s" : ""}
          </span>
        </button>
      )}
      <div className="sidebar-bottom">
        <div className="doctor-card">
          <span
            className="avatar"
            style={{
              overflow: "hidden",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {doctorPhoto ? (
              <img
                src={doctorPhoto}
                alt={doctorName}
                style={{
                  width: "100%",
                  height: "100%",
                  borderRadius: "50%",
                  objectFit: "cover",
                }}
              />
            ) : doctorName ? (
              doctorName
                .split(" ")
                .filter(Boolean)
                .map((n) => n[0])
                .slice(0, 2)
                .join("")
                .toUpperCase()
            ) : (
              "DR"
            )}
          </span>
          <button onClick={onDoctorProfile}>
            <strong>{doctorName || "Doctor"}</strong>
            <small>
              {clinicName ||
                (desktopSession?.clinic_id
                  ? /^[0-9a-fA-F]{24}$/.test(desktopSession.clinic_id)
                    ? "Medical Clinic"
                    : `Clinic: ${desktopSession.clinic_id}`
                  : "No active clinic")}
            </small>
          </button>
        </div>
      </div>
    </aside>
  )
}

export function AppHeader({
  title,
  subtitle,
  children,
  onMenu,
  conflictsCount,
  onOpenConflicts,
}: {
  title: string
  subtitle?: string
  children?: ReactNode
  onMenu?: () => void
  conflictsCount?: number
  onOpenConflicts?: () => void
}) {
  return (
    <header className="app-header">
      <div className="page-heading">
        {onMenu && (
          <IconButton
            label="Open navigation"
            onClick={onMenu}
            className="mobile-menu"
          >
            <Menu size={20} />
          </IconButton>
        )}
        <div>
          <div className="flex items-center gap-2.5">
            <h1>{title}</h1>
            {conflictsCount !== undefined && conflictsCount > 0 && (
              <button
                className="btn btn-sm inline-flex items-center gap-1.5 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300 dark:border-amber-700 rounded-full px-2 py-0.5 text-xs font-semibold cursor-pointer"
                onClick={onOpenConflicts}
                title="Review unresolved sync conflicts"
              >
                <AlertCircle size={13} />
                {conflictsCount} Conflict{conflictsCount > 1 ? "s" : ""}
              </button>
            )}
          </div>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      <div className="header-actions">{children}</div>
    </header>
  )
}
