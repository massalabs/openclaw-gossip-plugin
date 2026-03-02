/**
 * File-based metadata storage for Gossip accounts.
 *
 * The SDK now manages message/discussion persistence natively.
 * We keep only stable account metadata (mnemonic, userId, username) on disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getGossipResolveUserPath } from "./runtime.js";

export interface GossipSessionData {
  mnemonic: string;
  /** Base64-encoded encrypted Gossip session blob */
  encryptedSession?: string;
  userId?: string;
  username?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GossipStorageAdapter {
  /** Get the session data directory for an account */
  getSessionDir(accountId: string): string;
  /** Load session data from disk */
  loadSessionData(accountId: string): GossipSessionData | null;
  /** Save session data to disk */
  saveSessionData(accountId: string, data: GossipSessionData): void;
  /** Check if session data exists */
  hasSessionData(accountId: string): boolean;
  /** Delete session data */
  deleteSessionData(accountId: string): void;
}

/**
 * Get the base directory for Gossip sessions.
 * Uses ~/.openclaw/sessions/gossip/
 */
export function getGossipSessionsBaseDir(): string {
  const openclawDir = getGossipResolveUserPath("~/.openclaw");
  return path.join(openclawDir, "sessions", "gossip");
}

/**
 * Create a file-based storage adapter for Gossip sessions.
 */
export function createGossipStorageAdapter(log?: {
  debug?(message: string): void;
}): GossipStorageAdapter {
  const baseDir = getGossipSessionsBaseDir();

  const ensureDir = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  };

  const getSessionDir = (accountId: string): string => {
    const dir = path.join(baseDir, accountId);
    ensureDir(dir);
    return dir;
  };

  const getSessionFilePath = (accountId: string): string => {
    return path.join(getSessionDir(accountId), "session.json");
  };

  return {
    getSessionDir,

    loadSessionData(accountId: string): GossipSessionData | null {
      const filePath = getSessionFilePath(accountId);
      const exists = fs.existsSync(filePath);
      if (!exists) {
        return null;
      }
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as GossipSessionData;
      } catch {
        return null;
      }
    },

    saveSessionData(accountId: string, data: GossipSessionData): void {
      ensureDir(getSessionDir(accountId));
      const filePath = getSessionFilePath(accountId);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    },

    hasSessionData(accountId: string): boolean {
      const filePath = getSessionFilePath(accountId);
      const exists = fs.existsSync(filePath);
      return exists;
    },

    deleteSessionData(accountId: string): void {
      const sessionDir = path.join(baseDir, accountId);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    },
  };
}
