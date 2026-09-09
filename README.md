![TaxMaxi banner](https://github.com/user-attachments/assets/1faac63e-3afe-482a-b495-9fdcd2a64f97)

# TaxMaxi

**The open source crypto tax API.**

TaxMaxi helps products calculate crypto taxes from exchange and onchain activity. Use it to import crypto activity, classify taxable events, apply local tax rules, and return tax results from an API or terminal.

It is built for products that need crypto tax support inside their own apps: wallets, exchanges, portfolio trackers, trading bots, accounting tools, fintech apps, and AI agents.

## What you can do with it

- **Add tax calculations** to wallets, exchanges, brokers, portfolio trackers, and accounting products.
- **Calculate taxes from the terminal** with the installable `tax` CLI.
- **Sync activity** from supported exchanges and chains instead of wrangling CSV files.
- **Classify crypto events** such as trades, transfers, rewards, and disposals.
- **Create tax reports** with activity, tax lots, gains, and summaries.

## Why it exists

Most crypto tax tools are apps for individual users. Their assumptions are hard to inspect, their reports are difficult to reuse, and they do not fit products that need crypto tax support inside the product itself.

TaxMaxi makes crypto tax calculation available through a REST API and a CLI. The code is open source so the rules and calculations can be inspected.

## API

The hosted API is available at:

```text
https://api.taxmaxi.com
```

The OpenAPI specification is available at:

```text
https://api.taxmaxi.com/openapi.json
```

## CLI

Install the CLI from npm:

```bash
npm install -g tax
```

Calculate taxes for a wallet address:

```bash
tax <your wallet address>
```

Calculate taxes for your Coinbase account:

```bash
tax coinbase
```

Or run the steps separately:

```bash
tax coinbase connect
tax coinbase sync
tax coinbase calculate --year 2025
```

## Support Matrix

TaxMaxi is pre-launch and in beta. The first supported country is Germany, and the first supported sources are Coinbase and Solana.

### Chains and Exchanges

| Type     | Provider | Status      | Notes                                          |
| -------- | -------- | ----------- | ---------------------------------------------- |
| Exchange | Coinbase | Supported   | OAuth sync and German tax calculation workflow |
| Chain    | Solana   | In progress | Helius-backed activity sync and classification |
| Exchange | Binance  | Planned     | Planned exchange connector                     |
| Exchange | Kraken   | Planned     | Planned exchange connector                     |
| Chain    | Ethereum | Planned     | Planned EVM chain support                      |
| Chain    | Base     | Planned     | Planned EVM chain support                      |
| Chain    | Bitcoin  | Planned     | Planned UTXO chain support                     |

### Jurisdictions

| Jurisdiction   | Status    | Notes                                    |
| -------------- | --------- | ---------------------------------------- |
| Germany        | Supported | First tax ruleset and calculation target |
| Austria        | Planned   | Planned next country                     |
| Switzerland    | Planned   | Planned next country                     |
| United States  | Planned   | Planned future jurisdiction              |
| United Kingdom | Planned   | Planned future jurisdiction              |

## Repository

This repository contains TaxMaxi:

- `apps/cli` - the installable `tax` CLI
- `apps/server` - the hosted REST API server
- `apps/worker` - background sync and classification worker
- `packages/core` - domain contracts and shared types
- `packages/persistence` - database schema and durable repositories
- `packages/rest-api` - API definitions and handlers
- `packages/sync-engine` - provider sync, normalization, replay, and classification
- `packages/sdk` - JavaScript SDK client

## Development

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run type-check
```

Run the API server locally:

```bash
pnpm run server:dev
```

Run the worker locally:

```bash
pnpm run worker:dev
```

Two parts of the local stack need a note. Sign-up verification emails are not sent locally: with `AUTH_VERIFICATION_DELIVERY_MODE="log"` in `apps/server/.env` the API writes the code to its log, and you copy it from there; `"resend"` sends real email through Resend and is what production uses. Stripe reaches the local database only through webhooks, so a checkout completed against the Stripe sandbox never shows a plan or credits until you forward the events: run `stripe listen --forward-to localhost:4000/v1/billing/webhooks/stripe` and set `STRIPE_WEBHOOK_SECRET` to the `whsec_…` value the CLI prints.

## License

TaxMaxi is open source under the Apache-2.0 license.
