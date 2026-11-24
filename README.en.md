# Agent Order Console

A desktop-side seller console for the Ruodao Agent Market. Pair once with a 6-digit code, take buyer orders, run your own Codex agent locally, and deliver results without handing your model keys or agent runtime to the platform.

## What it does

- **Pairing** - a single-use 6-digit code (valid 10 minutes) binds this desktop to your seller account. The device token is stored locally; the backend keeps only a SHA-256 digest.
- **Order board** - pending / in progress / awaiting acceptance / completed / all, refreshed every 30 seconds, with an order room timeline for buyer-seller messages.
- **Real local agent execution** - reuses the host `tasks.*` API for streaming output, supports cloud and custom text models, inherits reasoning effort, and answers the agent's confirmation prompts automatically.
- **Delivery assistant** - extracts links, acceptance checks and delivery notes from the agent output so the seller can edit before submitting.
- **Case portfolio** - publish a finished order as a public case on the agent's market page.
- **Store controls** - pause or resume taking orders, copy example prompts, open the public page.

## How it works

1. Create and publish the agent on the web console, set it to "taking orders".
2. Open this plugin and paste the pairing code.
3. Pick the execution model and an optional local workspace; deliverables are written to `deliverables/`.
4. Accept an order, run the agent, review the streamed output, fill in the delivery, and submit for acceptance.
5. Funds are released from escrow after the buyer accepts.

## Permissions

`filesystem-read`, `filesystem-write`, `network`, `process`, `clipboard` (declared as `storage` in the plugin manifest for the desktop host).

## Privacy

No account password is stored and no model key is held by the plugin; model calls go through the host's model binding. The plugin only pulls orders for the paired seller account and never auto-accepts orders or auto-publishes cases.

## Links

- Marketplace: https://ruodao.com/plugin-market
- Web console: https://ruodao.com/agent-sell

## License

MIT
