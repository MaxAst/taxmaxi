# Web Application

The TaxMaxi web application presents focused product workflows that require a visual interface.

## Language

**Provider asset review**:
An administrator's decision that identifies the economic asset represented by a provider observation, or decides that TaxMaxi should not use the observation. The decision may also establish a required network representation.
_Avoid_: Asset canonicalization, provider asset approval

**Resolution proposal**:
An evidence-backed answer to a provider asset review. It identifies the economic asset and states whether confirming it will reuse or add a network representation; TaxMaxi recommends one only when the identity evidence is exact.
_Avoid_: CoinGecko candidate, mapping option, review action

**First sync**:
The period between a person's first source existing and any source completing its first import. The dashboard body is a guided wizard during this period, derived from server facts (source overviews, billing status) and the in-memory sync items; nothing about it is stored. It ends when any source carries a completion time.
_Avoid_: Onboarding state, empty state

**Welcome**:
The founder's letter shown once as the wizard's first step. Seen-ness is one server fact on the account (`welcomeSeenAt`), recorded by its own endpoint; Continue and Skip both record it.
_Avoid_: Onboarding modal, intro dialog

**Settled sync status**:
A sync item status that a later poll response may confirm but never change: completed, failed, or credit required. Credit required is settled because continuing after billing starts a new job and a new item.
_Avoid_: Terminal status (failed and completed only)
