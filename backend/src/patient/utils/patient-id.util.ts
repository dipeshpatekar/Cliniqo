export function formatSequentialPatientId(seq: number): string {
  const safeSeq = Math.max(1, Math.floor(seq || 1))
  const zeroIndex = safeSeq - 1
  const prefixIndex = Math.floor(zeroIndex / 9999)
  const numPart = (zeroIndex % 9999) + 1

  const c1 = String.fromCharCode(65 + (Math.floor(prefixIndex / (26 * 26)) % 26))
  const c2 = String.fromCharCode(65 + (Math.floor(prefixIndex / 26) % 26))
  const c3 = String.fromCharCode(65 + (prefixIndex % 26))

  return `${c1}${c2}${c3}-${numPart.toString().padStart(4, "0")}`
}

export function parseSequentialPatientId(id: string): number | null {
  if (!id || typeof id !== "string") return null
  const trimmed = id.trim().toUpperCase()
  const match = trimmed.match(/^([A-Z]{3})-(\d{4})$/)
  if (!match) return null

  const prefix = match[1]
  const num = parseInt(match[2], 10)
  if (num < 1 || num > 9999) return null

  const p0 = prefix.charCodeAt(0) - 65
  const p1 = prefix.charCodeAt(1) - 65
  const p2 = prefix.charCodeAt(2) - 65
  if (p0 < 0 || p0 > 25 || p1 < 0 || p1 > 25 || p2 < 0 || p2 > 25) return null

  const prefixIndex = p0 * 676 + p1 * 26 + p2
  return prefixIndex * 9999 + num
}

