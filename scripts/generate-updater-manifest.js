import fs from "node:fs"
import path from "node:path"

export function resolveUpdaterManifest({
  pkgVersion,
  bundleDir,
  repo = process.env.GITHUB_REPOSITORY || "dipeshpatekar/Cliniqo",
  refType = process.env.GITHUB_REF_TYPE,
  refName = process.env.GITHUB_REF_NAME,
  ref = process.env.GITHUB_REF || "",
}) {
  if (!pkgVersion) {
    throw new Error("Package version is required")
  }

  // 1. Exact expected filenames
  const expectedExe = `Cliniqo_${pkgVersion}_x64-setup.exe`
  const expectedSig = `${expectedExe}.sig`

  if (!fs.existsSync(bundleDir)) {
    throw new Error(`Bundle directory does not exist: ${bundleDir}`)
  }

  const exePath = path.join(bundleDir, expectedExe)
  if (!fs.existsSync(exePath)) {
    throw new Error(`Expected installer "${expectedExe}" not found in ${bundleDir}`)
  }

  const sigPath = path.join(bundleDir, expectedSig)
  if (!fs.existsSync(sigPath)) {
    throw new Error(`Expected signature "${expectedSig}" not found in ${bundleDir}`)
  }

  const signatureContent = fs.readFileSync(sigPath, "utf8").trim()
  if (!signatureContent) {
    throw new Error(`Signature file ${sigPath} is empty`)
  }

  // 2. Remove any stale/unexpected .exe or .sig files from bundle directory
  const allFiles = fs.readdirSync(bundleDir)
  for (const f of allFiles) {
    if (f.endsWith(".exe") && f !== expectedExe) {
      try {
        fs.unlinkSync(path.join(bundleDir, f))
      } catch {}
    }
    if (f.endsWith(".sig") && f !== expectedSig) {
      try {
        fs.unlinkSync(path.join(bundleDir, f))
      } catch {}
    }
  }

  // 3. Determine release tag and download URL
  // For a tag release, use GITHUB_REF_NAME as the release tag.
  // For non-tag builds, do not point to branch name (e.g. 'main'); use 'v' + version.
  const isTag = refType === "tag" || ref.startsWith("refs/tags/")
  const tag = isTag && refName ? refName : `v${pkgVersion}`
  const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/${expectedExe}`

  const manifest = {
    version: pkgVersion,
    notes: `Production release for Cliniqo Clinic Management System v${pkgVersion}`,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: signatureContent,
        url: downloadUrl,
      },
    },
  }

  const outPath = path.join(bundleDir, "latest.json")
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2), "utf8")

  return {
    manifest,
    expectedExe,
    expectedSig,
    exePath,
    sigPath,
    outPath,
    downloadUrl,
    tag,
  }
}

// Standalone CLI execution
const isMainModule =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")))

if (isMainModule) {
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
    const version = pkg.version
    const expectedExe = `Cliniqo_${version}_x64-setup.exe`

    const candidateDirs = [
      path.resolve("src-tauri/target/release/bundle/nsis"),
      path.resolve("src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"),
    ]

    const bundleDir = candidateDirs.find((d) =>
      fs.existsSync(path.join(d, expectedExe)),
    )

    if (!bundleDir) {
      console.error(
        `::error::Expected installer "${expectedExe}" not found in NSIS bundle directories.`,
      )
      for (const d of candidateDirs) {
        if (fs.existsSync(d)) {
          console.error(`Contents of ${d}:`, fs.readdirSync(d))
        }
      }
      process.exit(1)
    }

    const res = resolveUpdaterManifest({
      pkgVersion: version,
      bundleDir,
    })

    // Mirror latest.json to any secondary candidate dirs
    for (const d of candidateDirs) {
      if (d !== bundleDir && fs.existsSync(d)) {
        fs.writeFileSync(
          path.join(d, "latest.json"),
          JSON.stringify(res.manifest, null, 2),
          "utf8",
        )
      }
    }

    console.log(`Successfully generated latest.json at ${res.outPath}`)
    console.log(`- Version: ${res.manifest.version}`)
    console.log(`- Installer: ${res.expectedExe}`)
    console.log(`- Signature: ${res.expectedSig}`)
    console.log(`- Download URL: ${res.downloadUrl}`)
  } catch (err) {
    console.error(`::error::Failed to generate updater manifest: ${err.message}`)
    process.exit(1)
  }
}
