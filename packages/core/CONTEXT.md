# Core

Core defines the shared tax, monetary, and account concepts used throughout TaxMaxi.

## Tax and monetary language

**Supported fiat currency**:
A fiat monetary denomination that TaxMaxi recognizes by its canonical ISO currency code. It is not an economic asset and has no network representation.
_Avoid_: Fiat asset, canonical asset

**Fiat observation**:
A fiat currency description received from a provider's dedicated fiat catalog. An exact supported currency code resolves without provider asset review; unknown or conflicting evidence fails closed.
_Avoid_: Provider asset

**Provider consideration**:
The fiat amount a provider records for an accounting event, including an exchange amount paid or received and a provider-reported reward value. The factual loader supplies eligible evidence as an `observed_consideration` valuation fact linked to the accounting event by `eventId`. Valuation facts are supplied to the engine separately from the factual ledger; they are not fields on its events. The linked event need not be an exchange. A reward value does not prove that fiat was paid or received, so use those labels only when the provider evidence establishes an executed exchange. Fees are separate when the provider records them separately.
_Avoid_: Price paid (for a provider-reported reward value), cost basis

**Market valuation**:
An estimate of an asset movement’s fiat value at a stated time, derived from market price evidence. It is not proof of the amount actually paid or received.
_Avoid_: Purchase price (unless actual provider consideration is meant)

**Cost basis** (also called **tax basis**):
The amount assigned to an acquisition or lot under the accounting rules and used to calculate gain or loss on disposal. It may differ from provider consideration or market valuation. Cost basis is the preferred term, matching the existing engine and API field `costBasis`; tax basis is an alias for the same value, not a separate fact or a new `taxBasis` field.
_Avoid_: Price paid, tax basis as a separate value

**Proceeds**:
The disposal amount used by the accounting calculation before subtracting cost basis to determine gain or loss. Its valuation and fee treatment follow the applicable accounting rules; it is not itself the gain.
_Avoid_: Profit, gain

**Income**:
The fiat value in an `IncomeResult` produced by the accounting calculation from a qualifying acquisition, such as a reward receipt. The input remains an `AcquisitionEvent`, not a separate income-event kind; a reward receipt carries its reward cause on that acquisition. The engine emits a separate income result with the selected valuation and treatment codes. The income value is distinct from realized disposal gain; its treatment codes describe the jurisdiction’s treatment.
_Avoid_: Realized gain, proceeds

## Tax accounting language

**Accounting event**:
A jurisdiction-neutral record of something that factually happened to a principal's assets, such as an acquisition, a disposition, a reward received, or custody moving between the principal's own sources. It records what happened, never whether it is taxable.
_Avoid_: Taxable event, transaction (when the factual record is meant)

**Factual ledger**:
The ordered accounting events for one principal, complete once provider data is processed and transfers between the principal's sources are matched. It is the input to tax accounting, not its output.
_Avoid_: FIFO state, derived data

**Calculation run**:
One complete tax accounting calculation over a factual ledger for one principal, jurisdiction, and tax year. A run is produced whole and never edited; new facts or choices produce a new run.
_Avoid_: Cache, recalculation of an existing result

**Treatment code**:
A machine-readable, jurisdiction-specific classification attached to a factual result, such as a German tax-free holding-period disposal. The factual result itself (dates, cost basis, proceeds, gain) is the same for every jurisdiction.
_Avoid_: Tax status enum, display text

**Inventory scope**:
The boundary a disposal may match lots within. Per custody source: each custody unit — usually one source, sometimes a recorded group of sources that legally count as one wallet or account — is its own inventory, so transfers between the taxpayer's own units move lots between inventories (Germany's wallet FIFO, the US per-account rule from 2025). Whole taxpayer: one pool per asset across all sources, so transfers between their own sources change nothing (UK pooling). The jurisdiction decides the scope; events only record which custody source holds the assets. Which addresses form one custody source is a fact decided when the source is connected, not an accounting rule.
_Avoid_: Wallet FIFO (as a universal assumption), per-wallet and per-account as different scopes

**Accounting choice**:
A recorded, append-only taxpayer election that a jurisdiction legally allows, such as a lot-identification instruction. Changing a choice supersedes the old record and yields a new calculation run.
_Avoid_: Setting, preference

**Principal asset override**:
One principal's append-only replacement of a TaxMaxi conclusion about an asset, for that principal's facts only. Two kinds exist: identity (which economic asset) and inclusion (whether it takes part in calculation). Global mappings, raw evidence, and other principals never change (ADR 0011).
_Avoid_: User mapping, custom asset, principal-scoped mapping

**Override target**:
What an override points at. The exact representation target is a blockchain plus representation type plus canonical contract, mint, or native identity, and needs no global representation row. The provider-asset target is the principal plus one provider observation row, used only for facts with no exact chain identity.
_Avoid_: Asset ID (as the target), symbol

**Movement correction**:
One principal's append-only replacement of the valuation or supported factual classification of one recorded token movement. It preserves the original facts; the accounting engine derives tax treatment from the effective inputs (ADR 0013).
_Avoid_: Tax-result override, asset override (when only one occurrence is meant)

**Movement correction target**:
The stable identity of the particular source movement a correction applies to, retained across replay. It identifies one occurrence rather than every occurrence of an asset.
_Avoid_: Leg ID, token symbol, transaction total

**System conclusion**:
What TaxMaxi currently decides for a target, with the revision the user inspected when they overrode it. When the system conclusion moves on, the override stays active and the projection marks it as made against a stale system revision.
_Avoid_: Global mapping (when the projection field is meant), default

**Effective decision**:
The conclusion used to decide a principal's calculation inputs: an applicable active override, otherwise the current system conclusion. An active movement correction can require attention and remain unapplied; system, user, and effective facts remain distinct.
_Avoid_: Resolved asset, final asset

**Fact target link**:
The stored reference a provider transfer, canonical transfer, or transaction leg carries to the source representation use or provider-asset row that produced it. Readers look the link up; they never reconstruct it from amounts, siblings, or counts (ADR 0012).
_Avoid_: Matched target, inferred target

**Leg origin**:
The explicit record of what produced a transaction leg: a provider transfer, a canonical transfer, or nothing, each with its exact reference. A leg with no origin says so; a null is never read as a meaning.
_Avoid_: Leg source (ambiguous with custody source)

**Fact-layer blocker**:
A typed reason a stored fact could not become an accounting event: missing decimals, unsupported asset type, unresolved identity, malformed movement, or a missing fact target link. It is stored beside engine blockers in the calculation run and makes the run partial; the engine never sees it.
_Avoid_: Adapter error, validation error

**Whole-transaction withholding**:
The rule that when one accounting movement in a transaction is excluded or blocked, the transaction produces no accounting events at all, while its provider evidence and review item stay stored. Applies when facts are written and when they are read into events.
_Avoid_: Partial transaction, leg-level exclusion

**Covering run**:
A calculation run in the requested scope whose captured inputs prove it includes the named change and required completed source work. Movement corrections also require the selected stream leaf, including withdrawal, and the exact captured inputs and application outcome; completed-sync coverage does not mean all imported activity is free of blockers (ADRs 0013 and 0014).
_Avoid_: Latest run, run after the override

**Calculation request**:
A recorded need to calculate results for a principal and an explicit jurisdiction, tax year, and reporting currency. A request linked to a completed sync names that exact source job; it remains distinct from attempts to calculate it and from the result currently displayed.
_Avoid_: Pending run, queue job (when the durable request is meant)

## Wallet input language

**Wallet name**:
A human-readable alias from a name service that resolves to one onchain wallet address, such as `vitalik.eth` or `maxi.sol`. A wallet name is input; the resolved address is what TaxMaxi stores and syncs.
_Avoid_: ENS name (when the namespace is not specifically ENS), domain, handle

**Name-service namespace**:
The name service a wallet name belongs to, such as ENS or SNS. The namespace determines which chain the name resolves on and which chain family the resolved address belongs to.
_Avoid_: Chain, TLD

## Account language

**Account**:
A person's TaxMaxi membership and data. One account can have multiple login methods.
_Avoid_: Identity, login

**Account email**:
The trimmed, lowercased address where TaxMaxi sends security and recovery messages. The writer stores it in that form, and the `users` table rejects a second account whose email differs only in case. It does not have to match the address reported by a linked login provider.
_Avoid_: Provider email, login identity, canonical email

**Login method**:
A verified way to access an account, such as Google, Coinbase, or email and password. An account's login methods are peers; none is primary.
_Avoid_: Account, provider account, source connection

**Identity**:
The link between an account and one provider-specific login method. Attaching another identity to an existing account requires the person to authenticate that account first.
_Avoid_: Account

**Provider email**:
The address reported by an OAuth provider for a linked identity. It is display metadata, not the identity's stable key or necessarily the account email.
_Avoid_: Account email, provider ID

**Account collision**:
A logged-out login or sign-up attempt whose email matches an existing account but whose identity is not yet linked. An email match detects the collision but does not prove account ownership.
_Avoid_: Automatic linking

**Password reset**:
Recovery of an existing email-and-password login method. It never creates the first password for an account.
_Avoid_: Add password, account linking

**Sign-in help**:
A privacy-preserving email flow that explains how to access an existing account. It resets an existing password when possible or points the person to their linked OAuth providers, but never creates a login method.
_Avoid_: Forgot password

**Add password**:
Creation of an account's first email-and-password login method from an authenticated session. It requires a fresh verification code sent to the account email.
_Avoid_: Password reset, registration

**Login-method change**:
Adding or removing an account identity. Every login-method change requires an authenticated session with recent security verification and must leave at least one login method linked. Removing one ends sessions authenticated through that method.
_Avoid_: Profile update

**Security verification**:
A short-lived confirmation of account-email access tied to the current authenticated session. One confirmation can authorize login-method changes for ten minutes.
_Avoid_: Email verification status, login session

**Verification request**:
One pending proof that a person can read an account email, created by a local sign-up and answered with an eight-character code that expires ten minutes after it is sent. A resend replaces the request's code but keeps its lineage; a new sign-up or an unverified login after expiry starts a new request. Each request records its send attempts (ADR 0016).
_Avoid_: Verification code, security verification, verification cookie

**Send attempt**:
One hand-off of a verification code to email delivery, recorded on the verification request before delivery runs. Every attempt sets `last_sent_at`. `send_count` is set to 1 by the request's first send and grows by 1 on each explicit resend; an unverified login that reuses an active request leaves it unchanged. A failed delivery still counts. The one-minute cooldown reads `last_sent_at` and the five-send cap reads `send_count` (ADR 0016).
_Avoid_: Delivered email, successful send

**Source connection**:
An exchange account or wallet connected so TaxMaxi can import tax data. It is stored separately from login methods even when one Coinbase OAuth flow creates both.
_Avoid_: Login method, identity
