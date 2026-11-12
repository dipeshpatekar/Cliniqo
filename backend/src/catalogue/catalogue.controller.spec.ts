import { describe, it, expect, beforeEach, vi } from "vitest"
import { CatalogueController } from "./catalogue.controller.js"
import { CatalogueSearchType } from "./dto/search-catalogue.dto.js"

describe("CatalogueController", () => {
  let controller: CatalogueController
  let mockCatalogueService: any
  let mockImportService: any

  beforeEach(() => {
    mockCatalogueService = {
      search: vi.fn(),
      getStrengthsForMedicine: vi.fn(),
      getFeed: vi.fn(),
    }
    mockImportService = {
      runImport: vi.fn(),
      getImportHistory: vi.fn(),
    }

    controller = new CatalogueController(
      mockCatalogueService,
      mockImportService,
    )
  })

  it("delegates search query to catalogueService.search", async () => {
    const query = {
      q: "Paracetamol",
      type: CatalogueSearchType.BRAND,
      page: 1,
      limit: 10,
    }
    mockCatalogueService.search.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 10,
      totalPages: 0,
      attribution: "Attribution",
    })

    const res = await controller.search(query)
    expect(mockCatalogueService.search).toHaveBeenCalledWith(query)
    expect(res.total).toBe(0)
  })

  it("delegates getStrengths query to catalogueService.getStrengthsForMedicine", async () => {
    const query = { name: "Dolo 650", formulation: "Tablet" }
    mockCatalogueService.getStrengthsForMedicine.mockResolvedValue({
      strengths: ["650 mg"],
      variantsCount: 1,
      isSingleMatch: true,
    })

    const res = await controller.getStrengths(query)
    expect(mockCatalogueService.getStrengthsForMedicine).toHaveBeenCalledWith(
      query,
    )
    expect(res.isSingleMatch).toBe(true)
  })

  it("delegates feed query to catalogueService.getFeed", async () => {
    const query = { cursor: "B10", limit: 50 }
    mockCatalogueService.getFeed.mockResolvedValue({
      items: [],
      nextCursor: null,
      total: 0,
      attribution: "Attribution",
    })

    const res = await controller.getFeed(query)
    expect(mockCatalogueService.getFeed).toHaveBeenCalledWith("B10", 50)
    expect(res.total).toBe(0)
  })

  it("delegates triggerImport to importService.runImport with defaults", async () => {
    mockImportService.runImport.mockResolvedValue({
      jobId: "job_123",
      status: "COMPLETED",
      isDryRun: true,
    })

    const res = await controller.triggerImport({ dryRun: true })
    expect(mockImportService.runImport).toHaveBeenCalledWith({
      sourcePath: undefined,
      dryRun: true,
    })
    expect(res.jobId).toBe("job_123")
  })

  it("delegates getImportHistory to importService.getImportHistory", async () => {
    mockImportService.getImportHistory.mockResolvedValue([
      { jobId: "job_123", status: "COMPLETED" },
    ])

    const res = await controller.getImportHistory()
    expect(mockImportService.getImportHistory).toHaveBeenCalled()
    expect(res.length).toBe(1)
  })
})
