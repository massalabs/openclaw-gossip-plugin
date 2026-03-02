import { isValidUserId } from "@massalabs/gossip-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { GossipConfigSchema } from "./config-schema.js";

/** Strip channel-prefixed form so we validate and store raw Gossip user ID only. */
function stripGossipPrefix(id: string): string {
  const trimmed = id.trim();
  if (trimmed.toLowerCase().startsWith("gossip:")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}
import { startGossipBus, type GossipBusHandle } from "./gossip-bus.js";
import { gossipOnboardingAdapter } from "./onboarding.js";
import { getGossipRuntime } from "./runtime.js";
import { createGossipStorageAdapter } from "./storage.js";
import {
  listGossipAccountIds,
  resolveDefaultGossipAccountId,
  resolveGossipAccount,
  type ResolvedGossipAccount,
} from "./types.js";

// Store active bus handles per account
const activeBuses = new Map<string, GossipBusHandle>();

function shouldAcceptGossipDiscussionRequest(params: {
  account: ResolvedGossipAccount;
  contactUserId: string;
  log?: { info?(message: string): void };
}): boolean {
  const dmPolicy = params.account.config.dmPolicy ?? "pairing";
  const rawAllowFrom = (params.account.config.allowFrom ?? []).map((entry) => String(entry).trim());
  const normalizedAllowFrom = rawAllowFrom
    .filter(Boolean)
    .map((entry) => (entry === "*" ? "*" : stripGossipPrefix(entry)));

  const senderId = stripGossipPrefix(params.contactUserId);

  if (dmPolicy === "disabled") {
    params.log?.info?.(
      `[${params.account.accountId}] Rejecting Gossip discussion from ${senderId} (dmPolicy=disabled)`,
    );
    return false;
  }

  if (dmPolicy === "open" || dmPolicy === "pairing") {
    return true;
  }

  // dmPolicy === "allowlist"
  const allowed =
    normalizedAllowFrom.includes("*") || normalizedAllowFrom.some((entry) => entry === senderId);
  if (!allowed) {
    params.log?.info?.(
      `[${params.account.accountId}] Rejecting Gossip discussion from ${senderId} (dmPolicy=allowlist, not allowlisted)`,
    );
  }
  return allowed;
}

export const gossipPlugin: ChannelPlugin<ResolvedGossipAccount> = {
  id: "gossip",
  meta: {
    id: "gossip",
    label: "Gossip",
    selectionLabel: "Gossip",
    docsPath: "/channels/gossip",
    docsLabel: "gossip",
    blurb: "Privacy-focused decentralized messenger with post-quantum encryption",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"], // DMs only for now
    media: false, // No media for initial release
  },
  reload: { configPrefixes: ["channels.gossip"] },
  configSchema: buildChannelConfigSchema(GossipConfigSchema),
  onboarding: gossipOnboardingAdapter,

  config: {
    listAccountIds: (cfg) => listGossipAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveGossipAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultGossipAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "gossip",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) => {
      const storage = createGossipStorageAdapter();
      storage.deleteSessionData(accountId);
      return deleteAccountFromConfigSection({
        cfg,
        sectionKey: "gossip",
        accountId,
        clearBaseFields: [
          "name",
          "mnemonic",
          "username",
          "protocolUrl",
          "dmPolicy",
          "allowFrom",
          "enabled",
          "markdown",
        ],
      });
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      userId: account.userId,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveGossipAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => {
          if (entry === "*") {
            return "*";
          }
          const raw = stripGossipPrefix(entry);
          if (!isValidUserId(raw)) {
            console.warn(`Invalid Gossip user ID "${entry}" in allowFrom`);
          }
          return raw;
        })
        .filter(Boolean),
  },

  pairing: {
    idLabel: "gossipUserId",
    normalizeAllowEntry: (entry) => {
      const raw = stripGossipPrefix(entry);
      if (!isValidUserId(raw)) {
        console.warn(`Invalid Gossip user ID "${entry}" in allowFrom`);
      }
      return raw;
    },
    notifyApproval: async ({ id }) => {
      // Get the default account's bus and send approval message
      const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
      if (bus) {
        await bus.sendDm(id, "Your pairing request has been approved!");
      }
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: "channels.gossip.dmPolicy",
        allowFromPath: "channels.gossip.allowFrom",
        approveHint: formatPairingApproveHint("gossip"),
        normalizeEntry: (raw) => {
          const rawId = stripGossipPrefix(raw);
          if (!isValidUserId(rawId)) {
            console.warn(`Invalid Gossip user ID "${raw}"`);
          }
          return rawId;
        },
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => {
      const raw = stripGossipPrefix(target);
      if (!isValidUserId(raw)) {
        console.warn(`Invalid Gossip user ID "${target}" in target`);
      }
      return raw;
    },
    targetResolver: {
      looksLikeId: (input) => {
        const raw = stripGossipPrefix(input.trim());
        return isValidUserId(raw);
      },
      hint: "<gossip user ID>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const core = getGossipRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`Gossip bus not running for account ${aid}`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: core.config.loadConfig(),
        channel: "gossip",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      const normalizedTo = stripGossipPrefix(to);
      if (!isValidUserId(normalizedTo)) {
        console.warn(`Invalid Gossip user ID "${to}" in target`);
      }
      await bus.sendDm(normalizedTo, message);
      return { channel: "gossip", to: normalizedTo, messageId: "" };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "gossip",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      userId: ((snapshot.profile as { userId?: string } | undefined)?.userId ?? null) as
        | string
        | null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      profile: account.userId ? { userId: account.userId } : undefined,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        profile: account.userId ? { userId: account.userId } : undefined,
      });
      ctx.log?.info(`[${account.accountId}] starting Gossip provider`);

      if (!account.configured) {
        throw new Error("Gossip channel not configured");
      }

      const runtime = getGossipRuntime();

      const bus = await startGossipBus({
        accountId: account.accountId,
        mnemonic: account.mnemonic || undefined,
        username: account.username,
        protocolUrl: account.protocolUrl,
        log: ctx.log,
        onMessage: async (senderId, text, reply) => {
          const cfg = runtime.config.loadConfig() as OpenClawConfig;

          // Resolve agent route for this DM
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "gossip",
            accountId: account.accountId,
            peer: { kind: "direct", id: senderId },
          });

          const rawBody = text;
          const body = runtime.channel.reply.formatAgentEnvelope({
            channel: "Gossip",
            from: senderId,
            envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(cfg),
            body: rawBody,
          });

          // To/OriginatingTo = reply destination (peer), not our identity; session lastTo is used for outbound.
          const replyTo = `gossip:${senderId}`;
          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            RawBody: rawBody,
            CommandBody: rawBody,
            From: `gossip:${senderId}`,
            To: replyTo,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "direct",
            SenderName: senderId,
            SenderId: senderId,
            Provider: "gossip",
            Surface: "gossip",
            OriginatingChannel: "gossip",
            OriginatingTo: replyTo,
          });

          // Record session metadata
          const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });
          await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            onRecordError: (err) => {
              ctx.log?.error(`[${account.accountId}] Failed updating session meta: ${String(err)}`);
            },
          });

          const tableMode = runtime.channel.text.resolveMarkdownTableMode({
            cfg,
            channel: "gossip",
            accountId: account.accountId,
          });

          // Dispatch through the standard reply pipeline
          await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload: ReplyPayload) => {
                if (!payload.text) {
                  return;
                }
                const message = runtime.channel.text.convertMarkdownTables(payload.text, tableMode);
                await reply(message);
                ctx.setStatus({ accountId: account.accountId, lastOutboundAt: Date.now() });
              },
            },
          });
        },
        onError: (error, context) => {
          const base = `[${account.accountId}] Gossip error (${context}): ${error.message}`;
          if (error?.stack) {
            ctx.log?.error(`${base}\n${error.stack}`);
          } else {
            ctx.log?.error(base);
          }
        },
        onReady: (userId) => {
          ctx.log?.info(`[${account.accountId}] Gossip provider ready, user ID: ${userId}`);
          const currentProfile =
            (ctx.getStatus().profile as Record<string, unknown> | undefined) ?? {};
          ctx.setStatus({
            accountId: account.accountId,
            profile: {
              ...currentProfile,
              userId,
            },
          });
        },
        onDiscussionRequest: (discussion, contact) => {
          ctx.log?.info(
            `[${account.accountId}] Incoming Gossip discussion request from ${contact.userId}`,
          );
        },
        shouldAcceptDiscussionRequest: (discussion, contact) =>
          shouldAcceptGossipDiscussionRequest({
            account,
            contactUserId: contact.userId,
            log: ctx.log,
          }),
      });

      // Store the bus handle
      activeBuses.set(account.accountId, bus);

      ctx.log?.info(`[${account.accountId}] Gossip provider started`);

      // Block until the channel manager signals shutdown; without this the
      // resolved promise is treated as "channel exited" → auto-restart loop.
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      await bus.close();
      activeBuses.delete(account.accountId);
      ctx.log?.info(`[${account.accountId}] Gossip provider stopped`);
    },
  },
};

/**
 * Get an active Gossip bus handle.
 * Returns undefined if account is not running.
 */
export function getGossipBus(accountId: string = DEFAULT_ACCOUNT_ID): GossipBusHandle | undefined {
  return activeBuses.get(accountId);
}

/**
 * Get all active Gossip bus handles.
 * Useful for debugging and status reporting.
 */
export function getActiveGossipBuses(): Map<string, GossipBusHandle> {
  return new Map(activeBuses);
}
