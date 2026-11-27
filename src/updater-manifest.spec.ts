import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { resolveUpdaterManifest } from "../scripts/generate-updater-manifest.js"

describe("Cliniqo Updater Manifest & Release Packaging", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cliniqo-updater-test-"))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("selects installer using exact current package version and matching signature", () => {
    const version = "1.0.1"
    const expectedExe = `Cliniqo_${version}_x64-setup.exe`
    const expectedSig = `${expectedExe}.sig`

    // Create current version files
    fs.writeFileSync(path.join(tempDir, expectedExe), "DUMMY_EXE_BYTES_101")
    fs.writeFileSync(path.join(tempDir, expectedSig), "VALID_SIG_CONTENT_101\n")

    const res = resolveUpdaterManifest({
      pkgVersion: version,
      bundleDir: tempDir,
      repo: "dipeshpatekar/Cliniqo",
      refType: "branch",
      refName: "main",
      ref: "refs/heads/main",
    })

    expect(res.expectedExe).toBe("Cliniqo_1.0.1_x64-setup.exe")
    expect(res.expectedSig).toBe("Cliniqo_1.0.1_x64-setup.exe.sig")
    expect(res.manifest.version).toBe("1.0.1")
    expect(res.manifest.platforms["windows-x86_64"].signature).toBe("VALID_SIG_CONTENT_101")
    // Non-tag build must point to v1.0.1, never main
    expect(res.manifest.platforms["windows-x86_64"].url).toBe(
      "https://github.com/dipeshpatekar/Cliniqo/releases/download/v1.0.1/Cliniqo_1.0.1_x64-setup.exe",
    )
    expect(res.manifest.platforms["windows-x86_64"].url).not.toContain("/main/")
  })

  it("removes stale NSIS installer output from previous builds without selecting arbitrary older .exe", () => {
    const version = "1.0.1"
    const currentExe = `Cliniqo_${version}_x64-setup.exe`
    const currentSig = `${currentExe}.sig`

    // Stale 1.0.0 artifacts that might exist from cargo cache
    const staleExe = "Cliniqo_1.0.0_x64-setup.exe"
    const staleSig = "Cliniqo_1.0.0_x64-setup.exe.sig"

    fs.writeFileSync(path.join(tempDir, staleExe), "OLD_100_BYTES")
    fs.writeFileSync(path.join(tempDir, staleSig), "OLD_100_SIG")
    fs.writeFileSync(path.join(tempDir, currentExe), "NEW_101_BYTES")
    fs.writeFileSync(path.join(tempDir, currentSig), "NEW_101_SIG")

    const res = resolveUpdaterManifest({
      pkgVersion: version,
      bundleDir: tempDir,
      repo: "dipeshpatekar/Cliniqo",
      refType: "branch",
      refName: "main",
      ref: "refs/heads/main",
    })

    // Must strictly select 1.0.1
    expect(res.manifest.version).toBe("1.0.1")
    expect(res.manifest.platforms["windows-x86_64"].url).toBe(
      "https://github.com/dipeshpatekar/Cliniqo/releases/download/v1.0.1/Cliniqo_1.0.1_x64-setup.exe",
    )
    expect(res.manifest.platforms["windows-x86_64"].signature).toBe("NEW_101_SIG")

    // Stale files must have been purged from directory
    expect(fs.existsSync(path.join(tempDir, staleExe))).toBe(false)
    expect(fs.existsSync(path.join(tempDir, staleSig))).toBe(false)
    // Current files must still exist
    expect(fs.existsSync(path.join(tempDir, currentExe))).toBe(true)
    expect(fs.existsSync(path.join(tempDir, currentSig))).toBe(true)
  })

  it("for a tag release, uses GITHUB_REF_NAME as the release tag", () => {
    const version = "1.0.1"
    const currentExe = `Cliniqo_${version}_x64-setup.exe`
    const currentSig = `${currentExe}.sig`

    fs.writeFileSync(path.join(tempDir, currentExe), "BYTES")
    fs.writeFileSync(path.join(tempDir, currentSig), "SIG")

    const res = resolveUpdaterManifest({
      pkgVersion: version,
      bundleDir: tempDir,
      repo: "dipeshpatekar/Cliniqo",
      refType: "tag",
      refName: "v1.0.1",
      ref: "refs/tags/v1.0.1",
    })

    expect(res.tag).toBe("v1.0.1")
    expect(res.manifest.platforms["windows-x86_64"].url).toBe(
      "https://github.com/dipeshpatekar/Cliniqo/releases/download/v1.0.1/Cliniqo_1.0.1_x64-setup.exe",
    )
  })

  it("fails if the expected current version installer executable is missing", () => {
    const version = "1.0.1"
    // Only an old arbitrary exe exists
    fs.writeFileSync(path.join(tempDir, "Cliniqo_1.0.0_x64-setup.exe"), "OLD")
    fs.writeFileSync(path.join(tempDir, "Cliniqo_1.0.0_x64-setup.exe.sig"), "OLD_SIG")

    expect(() =>
      resolveUpdaterManifest({
        pkgVersion: version,
        bundleDir: tempDir,
      }),
    ).toThrowError(/Expected installer "Cliniqo_1.0.1_x64-setup.exe" not found/)
  })

  it("fails if the expected installer signature is missing", () => {
    const version = "1.0.1"
    fs.writeFileSync(path.join(tempDir, `Cliniqo_${version}_x64-setup.exe`), "EXE_NO_SIG")

    expect(() =>
      resolveUpdaterManifest({
        pkgVersion: version,
        bundleDir: tempDir,
      }),
    ).toThrowError(/Expected signature "Cliniqo_1.0.1_x64-setup.exe.sig" not found/)
  })

  it("fails if the signature file is empty", () => {
    const version = "1.0.1"
    const exe = `Cliniqo_${version}_x64-setup.exe`
    fs.writeFileSync(path.join(tempDir, exe), "EXE")
    fs.writeFileSync(path.join(tempDir, `${exe}.sig`), "   \n\t  ")

    expect(() =>
      resolveUpdaterManifest({
        pkgVersion: version,
        bundleDir: tempDir,
      }),
    ).toThrowError(/Signature file .* is empty/)
  })

  it("enforces consistent 1.0.5 version, app identifier, perMachine installMode, and updater configuration", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
    const tauriConf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"))
    const cargoToml = fs.readFileSync("src-tauri/Cargo.toml", "utf8")
    const cargoVersionMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)

    expect(cargoVersionMatch).not.toBeNull()
    expect(pkg.version).toBe("1.0.5")
    expect(pkg.version).toBe(tauriConf.version)
    expect(pkg.version).toBe(cargoVersionMatch![1])
    expect(tauriConf.identifier).toBe("com.cliniqo.desktop")
    expect(tauriConf.bundle?.windows?.nsis?.installMode).toBe("perMachine")
    expect(tauriConf.bundle?.createUpdaterArtifacts).toBe(true)
    expect(tauriConf.plugins?.updater?.endpoints?.[0]).toContain("/releases/latest/download/latest.json")
  })

  it("generates a valid v1.0.5 Windows updater manifest targeting v1.0.5 installer assets", () => {
    const version = "1.0.5"
    const exe = `Cliniqo_${version}_x64-setup.exe`
    fs.writeFileSync(path.join(tempDir, exe), "BIN_105")
    fs.writeFileSync(path.join(tempDir, `${exe}.sig`), "SIG_105\n")

    const res = resolveUpdaterManifest({
      pkgVersion: version,
      bundleDir: tempDir,
      repo: "dipeshpatekar/Cliniqo",
      refType: "tag",
      refName: "v1.0.5",
      ref: "refs/tags/v1.0.5",
    })

    expect(res.manifest.version).toBe("1.0.5")
    expect(res.manifest.platforms["windows-x86_64"].url).toBe(
      "https://github.com/dipeshpatekar/Cliniqo/releases/download/v1.0.5/Cliniqo_1.0.5_x64-setup.exe",
    )
    expect(res.manifest.platforms["windows-x86_64"].signature).toBe("SIG_105")
  })
})
