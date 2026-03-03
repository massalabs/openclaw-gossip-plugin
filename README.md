---
summary: "Gossip decentralized messenger with post-quantum encryption"
---

### Gossip channel plugin for OpenClaw

**Status:** Optional plugin.

This repository contains the OpenClaw Gossip channel plugin, a privacy‑focused, decentralized messenger that enables OpenClaw to send and receive encrypted direct messages without requiring a phone number or relying on centralized servers. For more details about the Gossip network itself, see the official site at `https://usegossip.massa.network/`.

### Why Gossip?

- **Open source**: Fully auditable codebase; no hidden backdoors.
- **Privacy focused**: Post‑quantum encryption with deniable plausibility protects your conversations even against future quantum computers.
- **Decentralized**: No central server owns your data; messages are routed through a distributed network.
- **No phone number required**: Identity is based on cryptographic keys, not phone numbers or email addresses.

### Install

The Gossip channel is distributed as an **external OpenClaw plugin**, published on npm from this repository.

```bash
openclaw plugins install @massalabs/openclaw-gossip-plugin
```

#### Onboarding

- The onboarding wizard (`openclaw onboard`) and `openclaw channels add` list optional channel plugins.
- When you select **Gossip** there, you can create your openclaw gossip account.
- If you are running a dev build of OpenClaw, you can choose to link an already checked‑out copy of this repo instead of installing from npm.

#### Manual install

For local development with this repository (no OpenClaw monorepo checkout required):

```bash
git clone https://github.com/massalabs/openclaw-gossip-plugin.git
cd openclaw-gossip-plugin
pnpm install # or npm / yarn
pnpm build   # or npm run build / yarn build

openclaw plugins install --link /absolute/path/to/openclaw-gossip-plugin
```

Restart the Gateway after installing or enabling plugins.

### Quick setup

1. Enable the Gossip channel in your OpenClaw config:

```json
{
  "channels": {
    "gossip": {
      "enabled": true
    }
  }
}
```

2. Restart the Gateway. On first run, OpenClaw will automatically:
   - Generate a new BIP39 mnemonic for your account.
   - Create cryptographic keys for encryption.
   - Register with the Gossip network.

3. Your Gossip user ID (bech32, e.g. `gossip1...`) is shown at the end of onboarding and is stored in:

```text
~/.openclaw/sessions/gossip/<accountId>/session.json
```

The default account ID is `default`. Share this ID with users who want to message your bot.

### Configuration reference

These keys live under `channels.gossip` in your main OpenClaw config file.

| Key           | Type     | Default                         | Description                                                                |
| ------------- | -------- | ------------------------------- | -------------------------------------------------------------------------- |
| `enabled`     | boolean  | `false`                         | Enable/disable channel                                                     |
| `mnemonic`    | string   | auto-generated on first run     | BIP39 mnemonic phrase for account recovery; supports `${VAR}` substitution |
| `username`    | string   | `openclaw`                      | Username for the Gossip account (used when creating the account)           |
| `protocolUrl` | string   | `https://api.usegossip.com/api` | Gossip protocol API base URL                                               |
| `dmPolicy`    | string   | `pairing`                       | DM access policy: `pairing`, `allowlist`, `open`, or `disabled`            |
| `allowFrom`   | string[] | `[]`                            | Allowed sender Gossip user IDs (e.g. `gossip1...`); use `["*"]` for open   |
| `name`        | string   | -                               | Optional display name for this account in OpenClaw UI                      |

### Backup your mnemonic

Your mnemonic phrase is the only way to recover your Gossip identity. OpenClaw stores account metadata (mnemonic, user ID, username) at:

```text
~/.openclaw/sessions/gossip/<accountId>/session.json
```

The same directory may contain `gossip.db` (SDK persistence for discussions and messages). **Back up the session directory or at least `session.json` securely.** If you lose the mnemonic, you will need to create a new identity.

To use an existing mnemonic (restore an account), add this to your main OpenClaw config file (by default `~/.openclaw/config.json5`, or whatever `OPENCLAW_CONFIG_PATH` points to):

```json
{
  "channels": {
    "gossip": {
      "mnemonic": "${GOSSIP_MNEMONIC}"
    }
  }
}
```

Then set the environment variable:

```bash
export GOSSIP_MNEMONIC="word1 word2 word3 ... word12"
```

You can also restore an existing account via the Gossip channel onboarding flow (`openclaw onboard` or `openclaw channels add`): when asked "Set an existing mnemonic?", choose yes and paste your BIP39 mnemonic.

### Access control

#### DM policies

- **pairing** (default): unknown senders get a pairing code.
- **allowlist**: only user IDs in `allowFrom` can DM.
- **open**: public inbound DMs (requires `allowFrom: ["*"]`).
- **disabled**: ignore inbound DMs.

#### Contact requests and auto-accept

Gossip uses "discussion requests" when someone tries to DM your bot for the first time. The OpenClaw Gossip plugin **automatically accepts all discussion requests** so you do not need to manually approve each new contact in the Gossip app.

Auto-accepting contacts does **not** bypass OpenClaw's own access control:

- **DM policy still applies**: after a contact is auto-accepted, inbound messages are checked against your configured `dmPolicy` and `allowFrom` list.
  - With `dmPolicy: "allowlist"`, only user IDs in `allowFrom` are allowed to talk to your agent (a whitelist).
  - With `dmPolicy: "pairing"`, unknown senders must complete the pairing flow before their messages reach your agent.
  - With `dmPolicy: "open"` and `allowFrom: ["*"]`, any Gossip user can reach your agent unless they are blocked by higher-level routing rules.
- **Blocklist-style filtering**: to block specific Gossip user IDs, keep them out of `allowFrom` when using `allowlist`, or add them to your global routing block rules; their messages will be dropped even though the contact may exist in Gossip.

For a locked-down production bot you will typically use something like:

```json
{
  "channels": {
    "gossip": {
      "dmPolicy": "allowlist",
      "allowFrom": ["gossip1a23...", "gossip1x89..."]
    }
  }
}
```

### How it works

Gossip uses a unique cryptographic protocol:

1. **Identity**: Your identity is a cryptographic key pair derived from a BIP39 mnemonic.
2. **Sessions**: When you start a conversation, both parties establish an encrypted session using post‑quantum key exchange.
3. **Messages**: All messages are end‑to‑end encrypted; only the intended recipient can read them.
4. **Deniability**: The protocol provides deniable authentication — you can prove a message came from someone, but cannot prove it to a third party.

### Testing

#### Manual test

1. Get the bot Gossip user ID from the Gateway logs after start, or from `~/.openclaw/sessions/gossip/default/session.json` (field `userId`).
2. Open the Gossip app on your phone or computer.
3. Add the bot as a contact using that user ID (bech32, e.g. `gossip1...`).
4. Start a conversation and send a message.
5. Verify the bot responds.

### Troubleshooting

#### Not receiving messages

- **Verify the channel is enabled**: `enabled: true` in `channels.gossip`.
- **Check that the Gateway is running.**
- **Confirm the sender has an active session** with your bot.
- **Check Gateway logs** for connection errors.

#### Not sending responses

- Verify outbound network connectivity to `api.usegossip.com` (API path `/api`).
- Check if the session with the recipient is active.
- Look for errors in the Gateway logs.

#### Session issues

If you see "session broken" or similar errors:

- The SDK automatically attempts to renew broken sessions.
- Messages are queued and sent when the session becomes active.
- If problems persist, the other party may need to reinitiate the conversation.

### Security

- **Never share your mnemonic** — it controls your entire identity.
- Use environment variables for sensitive values.
- Consider `dmPolicy: "allowlist"` for production bots.
- Protect `~/.openclaw/sessions/gossip/` (session metadata and SDK database); the SDK may use its own persistence in that directory.

### Limitations (initial release)

- Direct messages only (no group chats yet).
- No media attachments (text only).
- Single account per OpenClaw instance.

