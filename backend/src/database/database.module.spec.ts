import { describe, it, expect, vi } from "vitest"
import { DatabaseModule } from "./database.module.js"
import type { Connection } from "mongoose"

describe("DatabaseModule Lifecycle", () => {
  it("should register event listeners on the connection at initialization", () => {
    const listeners: Record<string, (...args: any[]) => void> = {}
    const onSpy = vi.fn((event: string, cb: (...args: any[]) => void) => {
      listeners[event] = cb
    })
    const mockConn = {
      readyState: 1,
      on: onSpy,
      close: vi.fn(),
    } as unknown as Connection

    new DatabaseModule(mockConn)

    expect(onSpy).toHaveBeenCalledWith("connected", expect.any(Function))
    expect(onSpy).toHaveBeenCalledWith("reconnected", expect.any(Function))
    expect(onSpy).toHaveBeenCalledWith("error", expect.any(Function))
    expect(onSpy).toHaveBeenCalledWith("disconnected", expect.any(Function))

    // Verify error event does not throw and handles error message safely
    expect(() => {
      listeners["error"](
        new Error(
          "mongodb+srv://admin:pass123@cluster0.mongodb.net network error",
        ),
      )
    }).not.toThrow()

    // Verify reconnected event does not throw
    expect(() => {
      listeners["reconnected"]()
    }).not.toThrow()
  })

  it("should gracefully close the connection on application shutdown when connection is open", async () => {
    const mockClose = vi.fn().mockResolvedValue(undefined)
    const mockConn = {
      readyState: 1,
      on: vi.fn(),
      close: mockClose,
    } as unknown as Connection

    const module = new DatabaseModule(mockConn)
    await module.onApplicationShutdown("SIGTERM")

    expect(mockClose).toHaveBeenCalledWith(false)
  })

  it("should not attempt to close connection if readyState is 0 (already disconnected)", async () => {
    const mockClose = vi.fn().mockResolvedValue(undefined)
    const mockConn = {
      readyState: 0,
      on: vi.fn(),
      close: mockClose,
    } as unknown as Connection

    const module = new DatabaseModule(mockConn)
    await module.onApplicationShutdown("SIGINT")

    expect(mockClose).not.toHaveBeenCalled()
  })

  it("should safely handle and catch errors thrown during connection close without crashing", async () => {
    const mockClose = vi
      .fn()
      .mockRejectedValue(new Error("mongodb://user:pass@host/db close error"))
    const mockConn = {
      readyState: 1,
      on: vi.fn(),
      close: mockClose,
    } as unknown as Connection

    const module = new DatabaseModule(mockConn)
    // Should not throw
    await expect(module.onApplicationShutdown("SIGTERM")).resolves.not.toThrow()
  })
})
