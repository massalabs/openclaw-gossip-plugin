import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createGossipStorageAdapter,
  type GossipSessionData,
  type GossipStorageAdapter,
} from "./storage.js";

// Mock the runtime module to control the base directory
vi.mock("./runtime.js", () => ({
  getGossipResolveUserPath: (p: string) => p.replace("~", os.tmpdir()),
}));

describe("storage", () => {
  let storage: GossipStorageAdapter;
  let testBaseDir: string;
  const testAccountId = "test-account-123";

  beforeEach(() => {
    storage = createGossipStorageAdapter();
    testBaseDir = path.join(os.tmpdir(), ".openclaw", "sessions", "gossip");
  });

  afterEach(() => {
    // Clean up test directories
    const accountDir = path.join(testBaseDir, testAccountId);
    if (fs.existsSync(accountDir)) {
      fs.rmSync(accountDir, { recursive: true, force: true });
    }
  });

  describe("getSessionDir", () => {
    it("creates the session directory if it does not exist", () => {
      const dir = storage.getSessionDir(testAccountId);
      expect(fs.existsSync(dir)).toBe(true);
      expect(dir).toContain(testAccountId);
    });

    it("returns the same directory on subsequent calls", () => {
      const dir1 = storage.getSessionDir(testAccountId);
      const dir2 = storage.getSessionDir(testAccountId);
      expect(dir1).toBe(dir2);
    });
  });

  describe("saveSessionData / loadSessionData", () => {
    it("saves and loads session data correctly", () => {
      const sessionData: GossipSessionData = {
        mnemonic: "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12",
        userId: "user-123",
        username: "testuser",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      storage.saveSessionData(testAccountId, sessionData);
      const loaded = storage.loadSessionData(testAccountId);

      expect(loaded).toEqual(sessionData);
    });

    it("returns null for non-existent session", () => {
      const loaded = storage.loadSessionData("non-existent-account");
      expect(loaded).toBeNull();
    });

    it("saves session data with correct file permissions", () => {
      const sessionData: GossipSessionData = {
        mnemonic: "test mnemonic",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      storage.saveSessionData(testAccountId, sessionData);

      const filePath = path.join(storage.getSessionDir(testAccountId), "session.json");
      const stats = fs.statSync(filePath);
      // Check file mode is 0o600 (owner read/write only)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("hasSessionData", () => {
    it("returns false for non-existent session", () => {
      expect(storage.hasSessionData("non-existent")).toBe(false);
    });

    it("returns true for existing session", () => {
      const sessionData: GossipSessionData = {
        mnemonic: "test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      storage.saveSessionData(testAccountId, sessionData);

      expect(storage.hasSessionData(testAccountId)).toBe(true);
    });
  });

  describe("deleteSessionData", () => {
    it("deletes all session files", () => {
      const sessionData: GossipSessionData = {
        mnemonic: "test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      storage.saveSessionData(testAccountId, sessionData);

      expect(storage.hasSessionData(testAccountId)).toBe(true);

      storage.deleteSessionData(testAccountId);

      expect(storage.hasSessionData(testAccountId)).toBe(false);
      expect(storage.loadSessionData(testAccountId)).toBeNull();
    });

    it("handles deletion of non-existent session gracefully", () => {
      // Should not throw
      expect(() => storage.deleteSessionData("non-existent")).not.toThrow();
    });
  });
});
