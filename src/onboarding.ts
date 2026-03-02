import { isValidUserId } from "@massalabs/gossip-sdk";
import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  DmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  normalizeAccountId,
} from "openclaw/plugin-sdk";
import { startGossipBus } from "./gossip-bus.js";
import { getGossipRuntime } from "./runtime.js";
import { createGossipStorageAdapter, getGossipSessionsBaseDir } from "./storage.js";
import {
  listGossipAccountIds,
  resolveDefaultGossipAccountId,
  resolveGossipAccount,
} from "./types.js";

const channel = "gossip" as const;

export const DEFAULT_PROTOCOL_URL = "https://api.usegossip.com/api";
export const DEFAULT_USERNAME = "openclaw";

function setGossipDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  const base = (cfg.channels as Record<string, unknown> | undefined)?.gossip as
    | Record<string, unknown>
    | undefined;
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(base?.allowFrom as string[] | undefined) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      gossip: {
        ...base,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    } as OpenClawConfig["channels"],
  };
}

function setGossipAllowFrom(cfg: OpenClawConfig, allowFrom: string[]): OpenClawConfig {
  const base = (cfg.channels as Record<string, unknown> | undefined)?.gossip as
    | Record<string, unknown>
    | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      gossip: {
        ...base,
        allowFrom,
      },
    } as OpenClawConfig["channels"],
  };
}

function stripGossipPrefix(id: string): string {
  const trimmed = id.trim();
  if (trimmed.toLowerCase().startsWith("gossip:")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry === "*" ? "*" : stripGossipPrefix(entry)))
    .filter((entry) => entry === "*" || isValidUserId(entry));
}

async function promptGossipAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId = params.accountId ?? resolveDefaultGossipAccountId(params.cfg);
  const resolved = resolveGossipAccount({ cfg: params.cfg, accountId });
  const existing = (resolved.config.allowFrom ?? []).map(String);

  await params.prompter.note(
    [
      "Allowlist DMs by Gossip user ID (e.g. gossip1sw8cvs4vy6k...).",
      "Leave blank to skip. Multiple IDs: comma-separated.",
      `Docs: ${formatDocsLink("/channels/gossip", "gossip")}`,
    ].join("\n"),
    "Gossip allowlist",
  );

  const entry = await params.prompter.text({
    message: "Gossip allowFrom (user IDs)",
    placeholder: "paste one or more Gossip user IDs",
    initialValue: existing[0] ?? undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return undefined;
      }
      const parts = parseAllowFromInput(raw);
      for (const part of parts) {
        if (part === "*") {
          continue;
        }
        if (!isValidUserId(part)) {
          return `Invalid Gossip user ID: ${part}`;
        }
      }
      return undefined;
    },
  });

  const parts = parseAllowFromInput(String(entry ?? ""));
  const normalized = [...new Set(parts)];
  return setGossipAllowFrom(params.cfg, normalized);
}

/** Gossip account id prompt with "default" as initial value for new account id. */
async function promptGossipAccountId(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  currentId?: string;
  defaultAccountId: string;
}): Promise<string> {
  const existingIds = listGossipAccountIds(params.cfg);
  const initial = params.currentId?.trim() || params.defaultAccountId || DEFAULT_ACCOUNT_ID;
  const choice = await params.prompter.select({
    message: "Gossip account",
    options: [
      ...existingIds.map((id) => ({
        value: id,
        label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
      })),
      { value: "__new__", label: "Add a new account" },
    ],
    initialValue: initial,
  });

  if (choice !== "__new__") {
    return normalizeAccountId(choice);
  }

  const entered = await params.prompter.text({
    message: "New Gossip account id",
    initialValue: DEFAULT_ACCOUNT_ID,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const normalized = normalizeAccountId(String(entered));
  if (String(entered).trim() !== normalized) {
    await params.prompter.note(`Normalized account id to "${normalized}".`, "Gossip account");
  }
  return normalized;
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Gossip",
  channel,
  policyKey: "channels.gossip.dmPolicy",
  allowFromKey: "channels.gossip.allowFrom",
  getCurrent: (cfg): DmPolicy => {
    const raw = (cfg.channels as Record<string, unknown> | undefined)?.gossip as
      | Record<string, unknown>
      | undefined;
    const p = raw?.dmPolicy;
    if (p === "pairing" || p === "allowlist" || p === "open" || p === "disabled") {
      return p;
    }
    return "pairing";
  },
  setPolicy: (cfg, policy) => setGossipDmPolicy(cfg, policy),
  promptAllowFrom: promptGossipAllowFrom,
};

async function noteGossipHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Gossip uses a mnemonic for identity. Leave mnemonic blank to auto-generate on first run.",
      "Username is your display name. Protocol URL defaults to the official Gossip API.",
      `Docs: ${formatDocsLink("/channels/gossip", "gossip")}`,
    ].join("\n"),
    "Gossip setup",
  );
}

function applyGossipConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: {
    name?: string;
    username?: string;
    protocolUrl?: string;
    mnemonic?: string;
  };
}): OpenClawConfig {
  const { cfg, input } = params;
  const base = (cfg.channels as Record<string, unknown> | undefined)?.gossip as
    | Record<string, unknown>
    | undefined;

  const gossip = {
    ...base,
    enabled: true,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.username !== undefined ? { username: input.username } : {}),
    ...(input.protocolUrl !== undefined ? { protocolUrl: input.protocolUrl } : {}),
    ...(input.mnemonic !== undefined ? { mnemonic: input.mnemonic } : {}),
  };

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      gossip,
    } as OpenClawConfig["channels"],
  };
}

export const gossipOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,

  getStatus: async ({ cfg }) => {
    const accountIds = listGossipAccountIds(cfg);
    const configured = accountIds.some(
      (id) => resolveGossipAccount({ cfg, accountId: id }).configured,
    );

    return {
      channel,
      configured,
      statusLines: [`Gossip: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "decentralized messenger",
      quickstartScore: configured ? 1 : 4,
    };
  },

  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides[channel]?.trim();
    const defaultAccountId = resolveDefaultGossipAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;

    if (shouldPromptAccountIds && !override) {
      accountId = await promptGossipAccountId({
        cfg,
        prompter,
        currentId: accountId,
        defaultAccountId,
      });
    }

    const resolved = resolveGossipAccount({ cfg, accountId });
    await noteGossipHelp(prompter);

    const username = accountId;

    const protocolUrl = await prompter.text({
      message: "Protocol API URL (blank for default)",
      placeholder: DEFAULT_PROTOCOL_URL,
      initialValue:
        resolved.protocolUrl !== DEFAULT_PROTOCOL_URL ? resolved.protocolUrl : undefined,
    });

    const wantsMnemonic = await prompter.confirm({
      message: "Set an existing mnemonic? (no = auto-generate on first run)",
      initialValue: Boolean(resolved.mnemonic?.trim()),
    });

    let mnemonic: string | undefined;
    if (wantsMnemonic) {
      const raw = await prompter.text({
        message: "BIP39 mnemonic (12/24 words)",
        placeholder: "word1 word2 ...",
        initialValue: resolved.mnemonic || undefined,
      });
      mnemonic = raw?.trim() || undefined;
    }

    const next = applyGossipConfig({
      cfg,
      accountId,
      input: {
        username,
        protocolUrl: (protocolUrl?.trim() || DEFAULT_PROTOCOL_URL).trim(),
        mnemonic,
      },
    });

    // Start the bus briefly to obtain and display the Gossip user ID (saved to session.json).
    const gossipCfg = (next.channels as Record<string, unknown> | undefined)?.gossip as
      | { mnemonic?: string; username?: string; protocolUrl?: string }
      | undefined;
    const busMnemonic = gossipCfg?.mnemonic?.trim() || undefined;
    const busUsername = (gossipCfg?.username?.trim() || DEFAULT_USERNAME).trim();
    const busProtocolUrl = (gossipCfg?.protocolUrl?.trim() || DEFAULT_PROTOCOL_URL).trim();

    let onboardingLog: { debug?(message: string): void } | undefined;
    try {
      onboardingLog = getGossipRuntime().logging.getChildLogger({
        module: "gossip-onboarding",
      });
    } catch {
      // Runtime not set (unusual during onboarding)
    }

    // User chose to generate a new mnemonic: clear any existing session so the bus creates a fresh one.
    if (!busMnemonic) {
      const storage = createGossipStorageAdapter(onboardingLog);
      storage.deleteSessionData(accountId);
    }

    try {
      const bus = await startGossipBus({
        accountId,
        mnemonic: busMnemonic,
        username: busUsername,
        protocolUrl: busProtocolUrl,
        log: onboardingLog,
        onMessage: async () => {},
        onError: () => {},
      });
      const userId = bus.userId;
      const mnemonicForBackup = bus.getMnemonic();
      await bus.close();

      const sessionPath = `${getGossipSessionsBaseDir()}/${accountId}/session.json`;
      await prompter.note(
        [
          "Gossip onboarding complete.",
          "",
          "Share this Gossip ID to start a discussion with your agent:",
          ``,
          userId,
          ``,
          "Mnemonic backup phrase (save this safely):",
          ``,
          mnemonicForBackup,
          ``,
          `Both gossipId and mnemonic are saved in: ${sessionPath}`,
        ].join("\n"),
        "Gossip account details",
      );
    } catch (err) {
      await prompter.note(
        [
          "Could not fetch your Gossip account details now (e.g. network).",
          "After you start the gateway, your gossipId and mnemonic will be saved in:",
          `${getGossipSessionsBaseDir()}/${accountId}/session.json`,
        ].join("\n"),
        "Gossip account details",
      );
    }

    return { cfg: next, accountId };
  },
};
