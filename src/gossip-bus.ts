/**
 * Gossip SDK Bus - Wrapper for SDK lifecycle and event handling
 *
 * This module provides a clean interface for OpenClaw to interact with the
 * Gossip SDK, handling initialization, session management, and message routing.
 */

import {
  gossipSdk,
  generateMnemonic,
  type Message,
  type Discussion,
  type Contact,
  SdkEventType,
  MessageDirection,
  MessageStatus,
  MessageType,
} from "@massalabs/gossip-sdk";
import {
  createGossipStorageAdapter,
  type GossipSessionData,
  type GossipStorageAdapter,
} from "./storage.js";

type GossipEventListeners = {
  message: (message: Message) => Promise<void>;
  sessionRequested: (discussion: Discussion, contact: Contact) => void;
  error: (error: Error, context: string) => void;
};

let activeListeners: GossipEventListeners | undefined;

function encodeEncryptedSessionBlob(blob: Uint8Array): string {
  return Buffer.from(blob).toString("base64");
}

function decodeEncryptedSessionBlob(encoded: string): Uint8Array {
  return Uint8Array.from(Buffer.from(encoded, "base64"));
}

function detachGossipEventListeners(): void {
  if (!activeListeners) {
    return;
  }
  gossipSdk.off(SdkEventType.MESSAGE_RECEIVED, activeListeners.message);
  gossipSdk.off(SdkEventType.SESSION_REQUESTED, activeListeners.sessionRequested);
  gossipSdk.off(SdkEventType.ERROR, activeListeners.error);
  activeListeners = undefined;
}

export interface GossipBusOptions {
  /** Account ID for state persistence */
  accountId: string;
  /** BIP39 mnemonic phrase (auto-generated if not provided) */
  mnemonic?: string;
  /** Username for the account */
  username: string;
  /** Gossip protocol API base URL */
  protocolUrl: string;
  /** Called when a message is received */
  onMessage: (
    senderId: string,
    text: string,
    reply: (text: string) => Promise<void>,
  ) => Promise<void>;
  /** Called on errors (optional) */
  onError?: (error: Error, context: string) => void;
  /** Called when SDK is ready (optional) */
  onReady?: (userId: string) => void;
  /** Called on discussion requests (optional) */
  onDiscussionRequest?: (discussion: Discussion, contact: Contact) => void;
  /** Decide whether to accept an incoming discussion request (optional; defaults to accept) */
  shouldAcceptDiscussionRequest?: (
    discussion: Discussion,
    contact: Contact,
  ) => boolean | Promise<boolean>;
  /** Optional debug logger (e.g. ctx.log from channel gateway) */
  log?: { debug?(message: string): void };
}

export interface GossipBusHandle {
  /** Stop the bus and cleanup */
  close: () => Promise<void>;
  /** Get the user's ID (bech32-encoded gossip1… string) */
  userId: string;
  /** Send a DM to a user */
  sendDm: (toUserId: string, text: string) => Promise<void>;
  /** Get the storage adapter */
  storage: GossipStorageAdapter;
  /** Get the mnemonic (for backup purposes) */
  getMnemonic: () => string;
}

/**
 * Start the Gossip bus - initializes SDK and handles message routing
 */
export async function startGossipBus(options: GossipBusOptions): Promise<GossipBusHandle> {
  const {
    accountId,
    username,
    protocolUrl,
    onMessage,
    onError,
    onReady,
    onDiscussionRequest,
    shouldAcceptDiscussionRequest,
    log,
  } = options;

  const storage = createGossipStorageAdapter(log);

  // Load or create session data
  const existingSessionData = storage.loadSessionData(accountId);
  let mutableSessionData: GossipSessionData;
  let mnemonic = options.mnemonic?.trim();

  if (existingSessionData) {
    // Restore existing session
    mnemonic = existingSessionData.mnemonic;
    mutableSessionData = existingSessionData;
  } else {
    // Generate new account if no mnemonic provided
    if (!mnemonic) {
      mnemonic = generateMnemonic();
    }
    // Save the new session data
    mutableSessionData = {
      mnemonic,
      username,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    storage.saveSessionData(accountId, mutableSessionData);
  }

  const persistSessionData = (updates: Partial<GossipSessionData>): void => {
    mutableSessionData = {
      ...mutableSessionData,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    storage.saveSessionData(accountId, mutableSessionData);
  };

  let restoredEncryptedSession: Uint8Array | undefined;
  if (mutableSessionData.encryptedSession?.trim()) {
    try {
      restoredEncryptedSession = decodeEncryptedSessionBlob(mutableSessionData.encryptedSession);
    } catch (err) {
      onError?.(
        err as Error,
        `decoding persisted encrypted session for account ${accountId}; falling back to mnemonic`,
      );
    }
  }

  const sqlitePath = storage.getSessionDir(accountId);
  const sqliteFilePath = `${sqlitePath}/gossip.db`;

  const initConfig = {
    polling: {
      enabled: false,
      messagesIntervalMs: 5000,
      announcementsIntervalMs: 5000,
      sessionRefreshIntervalMs: 30000,
    },
  };

  await gossipSdk.init({
    protocolBaseUrl: protocolUrl,
    storage: {
      type: "node-fs",
      path: sqliteFilePath,
    },
    config: initConfig,
  });

  // SDK is a singleton; close any existing session (e.g. from onboarding) before opening
  if (gossipSdk.isSessionOpen) {
    await gossipSdk.closeSession();
  }

  // Open session with persistence
  await gossipSdk.openSession({
    mnemonic,
    encryptedSession: restoredEncryptedSession,
    onPersist: async (encryptedBlob) => {
      persistSessionData({
        encryptedSession: encodeEncryptedSessionBlob(encryptedBlob),
      });
    },
  });

  const gossipUserId = gossipSdk.userId;
  const discussions = await gossipSdk.discussions.list();

  // Persist latest encrypted session snapshot so restarts can restore without re-handshake.
  persistSessionData({
    encryptedSession: encodeEncryptedSessionBlob(gossipSdk.getEncryptedSession()),
  });

  // Update session data with userId
  if (mutableSessionData.userId !== gossipUserId) {
    persistSessionData({ userId: gossipUserId });
  }

  // Set up event handlers. The SDK is a singleton, so always detach any
  // previous listeners before attaching a new set for this bus instance.
  detachGossipEventListeners();

  const handleMessage = async (message: Message): Promise<void> => {
    // Only handle incoming messages
    if (message.direction !== MessageDirection.INCOMING) {
      return;
    }

    const senderId = message.contactUserId;
    const text = message.content;

    // Create reply function
    const reply = async (responseText: string): Promise<void> => {
      await sendMessage(senderId, responseText);
    };

    try {
      await onMessage(senderId, text, reply);
    } catch (err) {
      onError?.(err as Error, `handling message from ${senderId}`);
    }
  };

  const handleSessionRequested = (discussion: Discussion, contact: Contact): void => {
    // Run policy check before invoking user callbacks or accepting the discussion.
    (async () => {
      const shouldAccept = (await shouldAcceptDiscussionRequest?.(discussion, contact)) ?? true;
      if (!shouldAccept) {
        return;
      }

      onDiscussionRequest?.(discussion, contact);

      // Ensure the requester is persisted as a contact before accepting discussion.
      let existing = await gossipSdk.contacts.get(contact.userId);
      if (!existing) {
        const publicKeys = await gossipSdk.auth.fetchPublicKeyByUserId(contact.userId);

        const addResult = await gossipSdk.contacts.add(contact.userId, contact.userId, publicKeys);
        if (!addResult.success && addResult.error !== "Contact already exists") {
          throw new Error(
            `Failed to add contact for discussion request ${contact.userId}: ${addResult.error}`,
          );
        }

        existing = await gossipSdk.contacts.get(contact.userId);
        if (!existing) {
          throw new Error(`Contact ${contact.userId} is still missing after add attempt`);
        }
      }

      // Auto-accept discussion requests for contacts
      await gossipSdk.discussions.accept(discussion);
    })().catch((err) => {
      onError?.(err as Error, `accepting discussion from ${contact.userId}`);
    });
  };

  const handleError = (error: Error, context: string): void => {
    onError?.(error, context);
  };

  gossipSdk.on(SdkEventType.MESSAGE_RECEIVED, handleMessage);
  gossipSdk.on(SdkEventType.SESSION_REQUESTED, handleSessionRequested);
  gossipSdk.on(SdkEventType.ERROR, handleError);
  activeListeners = {
    message: handleMessage,
    sessionRequested: handleSessionRequested,
    error: handleError,
  };

  // Notify that SDK is ready
  onReady?.(gossipUserId);

  // Fetch announcements (discussion requests) before starting polling so that
  // discussions are established before the first message poll. Without this,
  // messages can arrive before their discussion exists → "no discussion" error.
  try {
    await gossipSdk.announcements.fetch();
  } catch (err) {
    onError?.(err as Error, "initial announcements fetch");
  }

  // Now safe to start polling (discussions are established for known contacts)
  gossipSdk.polling.start();

  /**
   * Send a message to a user
   */
  async function sendMessage(toUserId: string, text: string): Promise<void> {
    // Contact must already exist (created when discussion request is accepted).
    let contact = await gossipSdk.contacts.get(toUserId);
    if (!contact) {
      throw new Error(
        `Contact ${toUserId} is missing. Expected contact to be created while accepting discussion request.`,
      );
    }

    // Ensure discussion exists. SDK queues outgoing messages until session is ready.
    const discussion = await gossipSdk.discussions.get(toUserId);
    if (!discussion) {
      const startResult = await gossipSdk.discussions.start(contact);
      if (!startResult.success) {
        throw new Error(
          `Failed to create discussion with ${toUserId}: ${startResult.error.message}`,
        );
      }
    }

    const sendResult = await gossipSdk.messages.send({
      ownerUserId: gossipUserId,
      contactUserId: toUserId,
      content: text,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });
    if (!sendResult.success) {
      throw new Error(`Failed to queue gossip message to ${toUserId}: ${sendResult.error}`);
    }
  }

  const resolvedMnemonic = mutableSessionData.mnemonic;

  return {
    close: async () => {
      detachGossipEventListeners();
      await gossipSdk.closeSession();
    },
    userId: gossipUserId,
    sendDm: sendMessage,
    storage,
    getMnemonic: () => resolvedMnemonic,
  };
}
