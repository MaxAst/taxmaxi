import { useRef, type MouseEvent, type Ref } from "react"
import type { TransactionFilterChoices } from "taxmaxi"
import { X, Plus } from "lucide-react"
import { Button } from "#/components/ui/button"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "#/components/ui/command"
import { Popover, PopoverTrigger, PopoverContent } from "#/components/ui/popover"
import type { Account } from "#/lib/dashboard-types"
import type { TransactionFilters } from "#/lib/transaction-filters"
import { m } from "#/paraglide/messages"

type Category = NonNullable<TransactionFilters["categories"]>[number]
type Choice = { id: string; label: string; detail?: string }

const categoryLabels = () =>
  ({
    purchase: m["app.transactionFilters.purchase"](),
    sale: m["app.transactionFilters.sale"](),
    gift: m["app.transactionFilters.gift"](),
    airdrop: m["app.transactionFilters.airdrop"](),
    mining_reward: m["app.transactionFilters.mining"](),
    staking: m["app.transactionFilters.staking"](),
    staking_reward: m["app.transactionFilters.unspecifiedStaking"](),
    passive_staking_reward: m["app.transactionFilters.passiveStaking"](),
    reward: m["app.transactionFilters.reward"](),
    payment: m["app.transactionFilters.payment"](),
    unknown: m["app.transactionFilters.unknown"](),
    custody_movement: m["app.transactionFilters.transfer"](),
  }) satisfies Record<Category, string>

function FilterMenu({
  label,
  choices,
  selected,
  onToggle,
  disabled,
  loading,
  failed,
  onRetry,
  triggerRef,
}: {
  triggerRef: Ref<HTMLButtonElement>
  label: string
  choices: ReadonlyArray<Choice>
  selected: ReadonlyArray<string>
  onToggle: (id: string) => void
  disabled: boolean
  loading?: boolean
  failed?: boolean
  onRetry?: () => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          aria-label={m["app.transactionFilters.edit"]({ group: label })}
        >
          <Plus data-icon="inline-start" />
          {label}
          {selected.length > 0 ? <span className="tabular-nums">{selected.length}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        collisionPadding={8}
        className="max-h-(--radix-popover-content-available-height) w-88 max-w-[calc(100vw-2rem)] overflow-y-auto p-1 motion-reduce:[--tw-enter-scale:1]! motion-reduce:[--tw-exit-scale:1]! motion-reduce:[--tw-enter-translate-x:0]! motion-reduce:[--tw-enter-translate-y:0]! motion-reduce:[--tw-exit-translate-x:0]! motion-reduce:[--tw-exit-translate-y:0]!"
      >
        <Command
          label={label}
          className="h-auto shrink-0 overflow-visible [&_[data-slot=input-group]]:min-h-11"
        >
          <CommandInput
            aria-label={m["app.transactionFilters.search"]({ group: label })}
            placeholder={m["app.transactionFilters.search"]({ group: label })}
            className="min-h-11 text-base"
          />
          {loading ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              {m["app.transactionFilters.loading"]()}
            </p>
          ) : null}
          <CommandList aria-label={label} className="max-h-none overflow-visible">
            {!loading ? (
              <CommandEmpty>{m["app.transactionFilters.noChoices"]()}</CommandEmpty>
            ) : null}
            <CommandGroup>
              {choices.map((choice) => (
                <CommandItem
                  key={choice.id}
                  value={choice.id}
                  keywords={[choice.label, choice.detail ?? ""]}
                  data-checked={selected.includes(choice.id)}
                  onSelect={() => onToggle(choice.id)}
                  className="min-h-11"
                >
                  <span className="min-w-0 break-words">
                    <span>{choice.label}</span>
                    {choice.detail ? (
                      <span className="block break-all text-xs text-muted-foreground">
                        {choice.detail}
                      </span>
                    ) : null}
                    <span className="sr-only">
                      {selected.includes(choice.id)
                        ? m["app.transactionFilters.selected"]()
                        : m["app.transactionFilters.notSelected"]()}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {failed ? (
          <div role="status" className="flex flex-col gap-2 p-3">
            <p>{m["app.transactionFilters.failed"]()}</p>
            <Button variant="outline" className="min-h-11" onClick={onRetry}>
              {m["app.transactionFilters.retry"]()}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** Controlled chips share the route's filter state with source cards and both readers. */
export function TransactionFilterControls({
  filters,
  onChange,
  sources,
  assets,
  loading = false,
  failed = false,
  onRetry,
  disabled = false,
}: {
  filters: TransactionFilters
  onChange: (filters: TransactionFilters) => void
  sources: ReadonlyArray<Account>
  assets?: TransactionFilterChoices["assets"]
  loading?: boolean
  failed?: boolean
  onRetry: () => void
  disabled?: boolean
}) {
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  const focusAfterKeyboardAction = (event: MouseEvent<HTMLButtonElement>, group: string) => {
    if (event.detail === 0) triggers.current.get(group)?.focus()
  }
  const labels = categoryLabels()
  const sourceChoices = sources.map((source) => ({
    id: source.id,
    label: source.name,
    detail: sources.some((other) => other.id !== source.id && other.name === source.name)
      ? source.id
      : undefined,
  }))
  const assetChoices = (assets ?? []).map((asset) => {
    const indistinguishable = assets?.some(
      (other) =>
        other.assetId !== asset.assetId &&
        other.symbol === asset.symbol &&
        other.name === asset.name &&
        other.type === asset.type &&
        other.coingeckoCoinId === asset.coingeckoCoinId
    )
    const metadata = [
      asset.type === "nft"
        ? m["app.transactionFilters.nft"]()
        : m["app.transactionFilters.token"](),
      asset.coingeckoCoinId,
      indistinguishable ? asset.assetId : null,
    ]
      .filter(Boolean)
      .join(" · ")
    return { id: asset.assetId, label: `${asset.symbol} · ${asset.name}`, detail: metadata }
  })
  const categories = (
    [
      "purchase",
      "sale",
      "gift",
      "airdrop",
      "mining_reward",
      "staking",
      "staking_reward",
      "passive_staking_reward",
      "reward",
      "payment",
      "unknown",
      "custody_movement",
    ] as const
  ).map((id) => ({ id, label: labels[id] }))
  const changeIds = (group: "sourceIds" | "assetIds", id: string) => {
    const current = filters[group] ?? []
    onChange({
      ...filters,
      [group]: current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id].sort(),
    })
  }
  const toggleCategory = (id: string) => {
    const category = categories.find((choice) => choice.id === id)?.id
    if (!category) return
    const current = filters.categories ?? []
    onChange({
      ...filters,
      categories: current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category].sort(),
    })
  }
  const groups = [
    {
      key: "sourceIds",
      label: m["app.transactionFilters.sources"](),
      choices: sourceChoices,
      selected: filters.sourceIds ?? [],
      toggle: (id: string) => changeIds("sourceIds", id),
    },
    {
      key: "assetIds",
      label: m["app.transactionFilters.assets"](),
      choices: assetChoices,
      selected: filters.assetIds ?? [],
      toggle: (id: string) => changeIds("assetIds", id),
    },
    {
      key: "categories",
      label: m["app.transactionFilters.categories"](),
      choices: categories,
      selected: filters.categories ?? [],
      toggle: toggleCategory,
    },
  ]
  const hasFilters = Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined
  )
  return (
    <section
      aria-label={m["app.transactionFilters.title"]()}
      className="mb-5 flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {groups.map((group) => (
          <FilterMenu
            key={group.key}
            triggerRef={(node) => {
              if (node) triggers.current.set(group.key, node)
              else triggers.current.delete(group.key)
            }}
            label={group.label}
            choices={group.choices}
            selected={group.selected}
            onToggle={group.toggle}
            disabled={disabled}
            loading={group.key === "assetIds" && loading}
            failed={group.key === "assetIds" && failed}
            onRetry={onRetry}
          />
        ))}
        {hasFilters ? (
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={disabled}
            onClick={(event) => {
              focusAfterKeyboardAction(event, "sourceIds")
              onChange({})
            }}
          >
            {m["app.transactionFilters.reset"]()}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {groups.flatMap((group) =>
          group.selected.map((id) => {
            const choice: Choice | undefined = group.choices.find((choice) => choice.id === id)
            const duplicate =
              choice &&
              group.choices.some((other) => other.id !== id && other.label === choice.label)
            const label = choice
              ? `${choice.label}${duplicate ? ` · ${choice.detail ?? id}` : ""}`
              : `${group.label} · ${id}`
            return (
              <Button
                key={`${group.key}-${id}`}
                variant="secondary"
                disabled={disabled}
                className="h-auto min-h-11 max-w-full whitespace-normal text-left"
                aria-label={m["app.transactionFilters.remove"]({ value: label })}
                onClick={(event) => {
                  focusAfterKeyboardAction(event, group.key)
                  group.toggle(id)
                }}
              >
                <span className="min-w-0 wrap-anywhere">{label}</span>
                <X data-icon="inline-end" />
              </Button>
            )
          })
        )}
      </div>
      {!filters.categories?.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {m["app.transactionFilters.suggestions"]()}
          </span>
          {(["staking", "sale", "custody_movement"] as const).map((category) => (
            <Button
              key={category}
              variant="ghost"
              className="min-h-11"
              disabled={disabled}
              onClick={(event) => {
                focusAfterKeyboardAction(event, "categories")
                onChange({ ...filters, categories: [category] })
              }}
            >
              {labels[category]}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  )
}
