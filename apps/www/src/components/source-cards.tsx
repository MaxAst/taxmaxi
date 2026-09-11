import type * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"

import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

import { AddWalletCard, type NameResolution } from "./add-wallet-card"
import { SourceCard, type Source } from "./source-card"
import { ContentContainer } from "./content-container"

/* ---------------------------------------------------------
 * SOURCE STACK STORYBOARD
 *
 *   0ms   resting cards sit half behind the content section
 * 120ms   hovered card peeks 90% above the section
 * 220ms   selected card peeks fully above the section
 *
 * The add-wallet card is the leftmost slot in the fan. It
 * follows the same choreography; focusing its input lifts it
 * in place to the selected height, exactly like a selected
 * source card. After a successful add, the new source card
 * starts at that lifted spot and springs into the fan.
 * --------------------------------------------------------- */

const SOURCE_STACK = {
  height: "21.5rem", // 2x card height; selection never shifts layout
  sectionOffset: "14rem", // where the shared content section starts covering cards
  hoverY: 70, // leaves roughly 90% of the card visible above the section
  cardWidth: "17rem",
  cardWidthPx: 272,
  cardHeight: "10.75rem",
  fan: {
    startX: 24,
    minStepX: 54,
    maxStepX: 190,
    sidePadding: 24,
    restY: 138,
    inactiveY: 176,
    selectedY: 20,
  },
  hoverScale: 1.045,
  tapScale: 0.98,
  spring: { type: "spring" as const, stiffness: 230, damping: 28, mass: 0.9 },
  reducedTransition: { duration: 0 },
}

const stressSourceNetworks = ["Ethereum", "Solana", "Base", "Arbitrum", "Optimism"] as const

const stressSources: ReadonlyArray<Source> = Array.from({ length: 23 }, (_, index) => {
  const displayIndex = index + 1
  const kind: Source["kind"] = index % 4 === 0 ? "exchange" : "wallet"
  const source = {
    id: `stress-source-${displayIndex.toString().padStart(2, "0")}`,
    name: kind === "exchange" ? `Exchange ${displayIndex}` : `Wallet ${displayIndex}`,
    kind,
    importedTransactions: 24 + displayIndex * 11,
    unresolvedItems: displayIndex % 5,
    lastSync: displayIndex % 2 === 0 ? "Today, 11:02" : "Yesterday, 17:45",
  }

  return kind === "wallet"
    ? { ...source, network: stressSourceNetworks[index % stressSourceNetworks.length] }
    : source
})

const sourceFixtures: ReadonlyArray<Source> = [
  {
    id: "coinbase",
    name: "Coinbase",
    kind: "exchange",
    importedTransactions: 418,
    unresolvedItems: 2,
    lastSync: "Today, 09:41",
  },
  {
    id: "kraken",
    name: "Kraken",
    kind: "exchange",
    importedTransactions: 126,
    unresolvedItems: 0,
    lastSync: "Yesterday, 18:22",
  },
  {
    id: "solana-wallet",
    name: "Solana wallet",
    kind: "wallet",
    network: "Solana",
    importedTransactions: 87,
    unresolvedItems: 4,
    lastSync: "Today, 08:13",
  },
  {
    id: "binance",
    name: "Binance",
    kind: "exchange",
    importedTransactions: 302,
    unresolvedItems: 1,
    lastSync: "Today, 07:58",
  },
  {
    id: "ledger",
    name: "Ledger vault",
    kind: "wallet",
    network: "Ethereum",
    importedTransactions: 41,
    unresolvedItems: 0,
    lastSync: "Mon, 16:08",
  },
  {
    id: "metamask",
    name: "MetaMask",
    kind: "wallet",
    network: "Ethereum",
    importedTransactions: 156,
    unresolvedItems: 3,
    lastSync: "Today, 10:12",
  },
  {
    id: "base-wallet",
    name: "Base wallet",
    kind: "wallet",
    network: "Base",
    importedTransactions: 64,
    unresolvedItems: 2,
    lastSync: "Yesterday, 21:34",
  },
  {
    id: "arbitrum-wallet",
    name: "Arbitrum",
    kind: "wallet",
    network: "Arbitrum",
    importedTransactions: 93,
    unresolvedItems: 1,
    lastSync: "Today, 06:25",
  },
  ...stressSources,
]

export const mockSources: ReadonlyArray<Source> = sourceFixtures.slice(0, 10)

export function SourceCards({
  children,
  className,
  contentClassName,
  onAddWallet,
  onResolveName,
  onSourceSelect,
  onSourceSync,
  selectedSourceIds,
  syncingSourceIds,
  sources = mockSources,
}: {
  children?: React.ReactNode
  className?: string
  contentClassName?: string
  onAddWallet?: (walletAddress: string) => Promise<void>
  onResolveName?: (name: string) => Promise<NameResolution>
  onSourceSelect?: (sourceId: Source["id"]) => void
  onSourceSync?: (source: Source) => void | Promise<void>
  selectedSourceIds?: ReadonlyArray<Source["id"]>
  syncingSourceIds?: ReadonlySet<Source["id"]>
  sources?: ReadonlyArray<Source>
}) {
  return (
    <section
      className={cn("relative", className)}
      style={{ paddingTop: SOURCE_STACK.sectionOffset }}
    >
      <SourceCardRail
        onAddWallet={onAddWallet}
        onResolveName={onResolveName}
        onSourceSelect={onSourceSelect}
        onSourceSync={onSourceSync}
        selectedSourceIds={selectedSourceIds}
        syncingSourceIds={syncingSourceIds}
        sources={sources}
      />

      {children ? (
        <div className="relative z-20">
          <ContentContainer
            width="2xl"
            className={cn(
              "relative z-20 grid gap-2 rounded-3xl bg-card shadow-sm ring-1 ring-border/80",
              contentClassName
            )}
          >
            {children}
          </ContentContainer>
        </div>
      ) : null}
    </section>
  )
}

function SourceCardRail({
  onAddWallet,
  onResolveName,
  onSourceSelect,
  onSourceSync,
  selectedSourceIds,
  syncingSourceIds,
  sources,
}: {
  onAddWallet?: (walletAddress: string) => Promise<void>
  onResolveName?: (name: string) => Promise<NameResolution>
  onSourceSelect?: (sourceId: Source["id"]) => void
  onSourceSync?: (source: Source) => void | Promise<void>
  selectedSourceIds?: ReadonlyArray<Source["id"]>
  syncingSourceIds?: ReadonlySet<Source["id"]>
  sources: ReadonlyArray<Source>
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [isAddingWallet, setIsAddingWallet] = useState(false)
  const reduceMotion = useReducedMotion()
  const totalSlots = sources.length + (onAddWallet === undefined ? 0 : 1)
  const stackLayout = useMemo(
    () => getStackLayout({ containerWidth, total: totalSlots }),
    [containerWidth, totalSlots]
  )

  useEffect(() => {
    const scroller = scrollerRef.current

    if (scroller) {
      scroller.scrollLeft = 0
    }
  }, [])

  useEffect(() => {
    if (isAddingWallet) {
      scrollerRef.current?.scrollTo({ behavior: reduceMotion ? "instant" : "smooth", left: 0 })
    }
  }, [isAddingWallet, reduceMotion])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current

    if (!scroller) {
      return
    }

    const updateWidth = () => {
      setContainerWidth(Math.round(scroller.getBoundingClientRect().width))
    }

    updateWidth()

    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(scroller)

    return () => resizeObserver.disconnect()
  }, [])

  return (
    <div
      className="absolute inset-x-0 top-0 z-0 overflow-clip"
      style={{ height: SOURCE_STACK.height }}
    >
      <ContentContainer className="h-full overflow-visible" width="2xl">
        <div
          className="relative -mx-10 h-[21.5rem] overflow-x-auto overflow-y-clip overscroll-x-contain sm:-mx-12"
          ref={scrollerRef}
        >
          {/* The stack mounts only after the scroller is measured, so cards
              paint at their final placements instead of springing over from
              a zero-width layout. */}
          {stackLayout.ready ? (
            <SourceCardStack
              isAddingWallet={isAddingWallet}
              layout={stackLayout}
              onAddWallet={onAddWallet}
              onResolveName={onResolveName}
              onAddingWalletChange={setIsAddingWallet}
              onSourceSelect={onSourceSelect}
              onSourceSync={onSourceSync}
              selectedSourceIds={selectedSourceIds}
              syncingSourceIds={syncingSourceIds}
              sources={sources}
            />
          ) : null}
        </div>
      </ContentContainer>
    </div>
  )
}

function SourceCardStack({
  isAddingWallet,
  layout,
  onAddWallet,
  onAddingWalletChange,
  onResolveName,
  onSourceSelect,
  onSourceSync,
  selectedSourceIds,
  syncingSourceIds,
  sources,
}: {
  isAddingWallet: boolean
  layout: SourceStackLayout
  onAddWallet?: (walletAddress: string) => Promise<void>
  onResolveName?: (name: string) => Promise<NameResolution>
  onAddingWalletChange: (isAddingWallet: boolean) => void
  onSourceSelect?: (sourceId: Source["id"]) => void
  onSourceSync?: (source: Source) => void | Promise<void>
  selectedSourceIds?: ReadonlyArray<Source["id"]>
  syncingSourceIds?: ReadonlySet<Source["id"]>
  sources: ReadonlyArray<Source>
}) {
  const stackRef = useRef<HTMLDivElement>(null)
  const knownSourceIdsRef = useRef<ReadonlySet<Source["id"]>>(
    new Set(sources.map((source) => source.id))
  )
  const showAddCard = onAddWallet !== undefined
  const slotOffset = showAddCard ? 1 : 0
  const totalSlots = sources.length + slotOffset
  const [liftedSourceId, setLiftedSourceId] = useState<Source["id"]>()
  const selectedIndex = sources.findIndex((source) => source.id === liftedSourceId)
  const selectedSlot =
    showAddCard && isAddingWallet ? 0 : selectedIndex >= 0 ? selectedIndex + slotOffset : -1

  // A source that appeared while the add card is lifted was just created
  // through it; it mounts at the lifted spot and springs into the fan.
  const dealSourceId =
    showAddCard && isAddingWallet
      ? sources.find((source) => !knownSourceIdsRef.current.has(source.id))?.id
      : undefined

  // The lifted add card takes the exact placement a selected source card
  // gets in its slot: it rises in place, without traveling to the center.
  const liftedPlacement = getCardPlacement({
    index: 0,
    layout,
    selectedIndex: 0,
    total: totalSlots,
  })

  const addCardPlacement = getAddCardPlacement({ layout, selectedSlot, totalSlots })

  useEffect(() => {
    knownSourceIdsRef.current = new Set(sources.map((source) => source.id))
  }, [sources])

  // Escape lowers the focused card without changing the source filter. Presses
  // inside text fields are left to the field itself — that is how the
  // add-wallet input closes first and a second press lowers the source card. Focus
  // leaves the card as well, again matching the add-wallet card, so the
  // keyboard focus ring does not linger after a mouse-driven dismiss.
  useEffect(() => {
    if (liftedSourceId === undefined) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return
      }

      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return
      }

      const focused = document.activeElement
      if (focused instanceof HTMLElement && stackRef.current?.contains(focused)) {
        focused.blur()
      }

      setLiftedSourceId(undefined)
    }

    document.addEventListener("keydown", handleKeyDown)

    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [liftedSourceId])

  return (
    <div
      className={cn(
        "absolute top-0",
        layout.align === "center" ? "left-1/2 -translate-x-1/2" : "left-0"
      )}
      style={{
        left: layout.align === "center" ? undefined : layout.left,
        width: layout.stackWidth,
      }}
    >
      <div
        className="relative isolate overflow-visible"
        ref={stackRef}
        style={{ height: SOURCE_STACK.height }}
      >
        {showAddCard ? (
          <FanCard
            className={isAddingWallet ? undefined : "cursor-pointer"}
            hoverPlacement={{
              ...addCardPlacement,
              scale: addCardPlacement.scale * SOURCE_STACK.hoverScale,
              y: isAddingWallet ? addCardPlacement.y : SOURCE_STACK.hoverY,
            }}
            placement={addCardPlacement}
            tapScale={isAddingWallet ? undefined : addCardPlacement.scale * SOURCE_STACK.tapScale}
            zIndex={addCardPlacement.zIndex}
          >
            <AddWalletCard
              active={isAddingWallet}
              height={SOURCE_STACK.cardHeight}
              onActiveChange={onAddingWalletChange}
              onResolveName={onResolveName}
              onSubmit={onAddWallet}
              width={SOURCE_STACK.cardWidth}
            />
          </FanCard>
        ) : null}
        {sources.map((source, index) => {
          const active = selectedSourceIds?.includes(source.id) ?? false
          const lifted = liftedSourceId === source.id
          const isSyncing = syncingSourceIds?.has(source.id) ?? false
          const isNewlyAdded = source.id === dealSourceId
          const resting = getCardPlacement({
            index: index + slotOffset,
            layout,
            selectedIndex: selectedSlot,
            total: totalSlots,
          })

          return (
            <FanCard
              aria-label={m["app.dashboard.sources.showSource"]({ sourceName: source.name })}
              aria-pressed={active}
              className={cn(
                "cursor-pointer rounded-2xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                active && "ring-2 ring-ring"
              )}
              hoverPlacement={{
                ...resting,
                scale: resting.scale * SOURCE_STACK.hoverScale,
                y: lifted ? resting.y : SOURCE_STACK.hoverY,
              }}
              initialPlacement={isNewlyAdded ? liftedPlacement : false}
              key={source.id}
              onFocus={() => setLiftedSourceId(source.id)}
              onClick={() => {
                setLiftedSourceId(source.id)
                onSourceSelect?.(source.id)
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) {
                  return
                }

                if (event.key !== "Enter" && event.key !== " ") {
                  return
                }

                event.preventDefault()
                setLiftedSourceId(source.id)
                onSourceSelect?.(source.id)
              }}
              placement={resting}
              role="button"
              tabIndex={0}
              tapScale={resting.scale * SOURCE_STACK.tapScale}
              zIndex={isNewlyAdded ? totalSlots + 3 : resting.zIndex}
            >
              <SourceCard
                action={
                  onSourceSync && !isSyncing ? (
                    <button
                      aria-label={m["app.dashboard.sources.syncSource"]({
                        sourceName: source.name,
                      })}
                      className="relative inline-flex h-7 touch-manipulation items-center gap-1 rounded-full border border-white/24 bg-white/16 px-2.5 text-xs font-medium text-current shadow-sm backdrop-blur-md transition-[background-color,border-color,transform] duration-150 before:absolute before:-inset-y-2 before:inset-x-0 hover:bg-white/24 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-white/35 [&_svg]:size-3"
                      onClick={(event) => {
                        event.stopPropagation()
                        void onSourceSync(source)
                      }}
                      type="button"
                    >
                      <RefreshCw aria-hidden="true" />
                      <span>{m["app.dashboard.sources.sync"]()}</span>
                    </button>
                  ) : undefined
                }
                height={SOURCE_STACK.cardHeight}
                isSyncing={isSyncing}
                source={source}
                width={SOURCE_STACK.cardWidth}
              />
            </FanCard>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Shared motion wrapper for every card in the fan. Source cards and the
 * add-wallet card animate through this one component so spring, hover, and
 * tap behavior cannot drift apart. Hover is folded into the animate target
 * instead of whileHover: motion does not retarget a whileHover whose values
 * change while the pointer stays on the card.
 */
function FanCard({
  children,
  className,
  hoverPlacement,
  initialPlacement = false,
  placement,
  tapScale,
  zIndex,
  ...interactionProps
}: {
  children: React.ReactNode
  className?: string
  hoverPlacement?: CardPlacement
  initialPlacement?: CardPlacement | false
  placement: CardPlacement
  tapScale?: number
  zIndex: number
} & Pick<
  React.ComponentProps<typeof motion.div>,
  "aria-label" | "aria-pressed" | "onClick" | "onFocus" | "onKeyDown" | "role" | "tabIndex"
>) {
  const reduceMotion = useReducedMotion()
  const [isHovered, setIsHovered] = useState(false)
  const target =
    !reduceMotion && isHovered && hoverPlacement !== undefined ? hoverPlacement : placement

  return (
    <motion.div
      {...interactionProps}
      animate={{
        opacity: 1,
        rotate: target.rotate,
        scale: target.scale,
        x: target.x,
        y: target.y,
      }}
      className={cn("absolute left-0 top-0 will-change-transform", className)}
      initial={
        initialPlacement === false
          ? false
          : {
              opacity: 1,
              rotate: initialPlacement.rotate,
              scale: initialPlacement.scale,
              x: initialPlacement.x,
              y: initialPlacement.y,
            }
      }
      onHoverEnd={() => setIsHovered(false)}
      onHoverStart={() => setIsHovered(true)}
      style={{ zIndex }}
      transition={reduceMotion ? SOURCE_STACK.reducedTransition : SOURCE_STACK.spring}
      whileTap={reduceMotion || tapScale === undefined ? undefined : { scale: tapScale }}
    >
      {children}
    </motion.div>
  )
}

type SourceStackLayout = {
  align: "center" | "measured"
  left: number
  ready: boolean
  stackWidth: number
  startX: number
  stepX: number
}

type CardPlacement = {
  rotate: number
  scale: number
  x: number
  y: number
  zIndex: number
}

function getCardPlacement({
  index,
  layout,
  selectedIndex,
  total,
}: {
  index: number
  layout: SourceStackLayout
  selectedIndex: number
  total: number
}): CardPlacement {
  const basePlacement = getRestingPlacement({ index, layout, total })

  if (selectedIndex < 0) {
    return basePlacement
  }

  if (index === selectedIndex) {
    return {
      ...basePlacement,
      rotate: 0,
      scale: 1.05,
      y: SOURCE_STACK.fan.selectedY,
      zIndex: total + 4,
    }
  }

  const distance = index - selectedIndex
  const direction = distance < 0 ? -1 : 1
  const nearSelectedNudge = Math.max(0, 4 - Math.abs(distance)) * 7

  return {
    ...basePlacement,
    rotate: basePlacement.rotate + direction * 1.5,
    scale: Math.max(0.76, 0.86 - Math.min(Math.abs(distance), 4) * 0.025),
    x: basePlacement.x + direction * (18 + nearSelectedNudge),
    y: SOURCE_STACK.fan.inactiveY,
    zIndex: Math.max(1, total - Math.abs(distance)),
  }
}

/**
 * Placement for the add-wallet card in the leftmost slot. It goes through
 * the same placement math as source cards (including the lifted state,
 * where slot 0 is the selected slot), with one exception at rest: the fan
 * shrinks and lowers cards toward its edges, and taking that penalty on
 * the permanently-leftmost add card made it read as smaller than every
 * source card. It borrows its neighbor's scale and height while keeping
 * its own position and rotation for the arc.
 */
function getAddCardPlacement({
  layout,
  selectedSlot,
  totalSlots,
}: {
  layout: SourceStackLayout
  selectedSlot: number
  totalSlots: number
}): CardPlacement {
  const placement = getCardPlacement({
    index: 0,
    layout,
    selectedIndex: selectedSlot,
    total: totalSlots,
  })

  if (selectedSlot >= 0 || totalSlots <= 2) {
    return placement
  }

  const neighbor = getRestingPlacement({ index: 1, layout, total: totalSlots })

  return { ...placement, scale: neighbor.scale, y: neighbor.y }
}

function getRestingPlacement({
  index,
  layout,
  total,
}: {
  index: number
  layout: SourceStackLayout
  total: number
}): CardPlacement {
  const center = (total - 1) / 2
  const distanceFromCenter = index - center
  const normalizedDistance = center === 0 ? 0 : distanceFromCenter / center

  return {
    x: layout.startX + index * layout.stepX,
    y: SOURCE_STACK.fan.restY + Math.abs(normalizedDistance) * 10,
    rotate: normalizedDistance * 9,
    scale: 1 - Math.abs(normalizedDistance) * 0.06,
    zIndex: index + 1,
  }
}

function getStackLayout({
  containerWidth,
  total,
}: {
  containerWidth: number
  total: number
}): SourceStackLayout {
  const cardWidth = SOURCE_STACK.cardWidthPx
  const sidePadding = SOURCE_STACK.fan.sidePadding
  const startX = SOURCE_STACK.fan.startX

  if (total <= 1) {
    return {
      align: "center",
      left: 0,
      ready: true,
      stackWidth: cardWidth,
      startX: 0,
      stepX: 0,
    }
  }

  const maxStackWidth = Math.max(0, containerWidth)
  const ready = maxStackWidth > 0
  const availableStepWidth = maxStackWidth - startX - sidePadding - cardWidth
  const maxStep = SOURCE_STACK.fan.maxStepX
  const minStep = SOURCE_STACK.fan.minStepX
  const stepX = Math.min(maxStep, Math.max(minStep, availableStepWidth / Math.max(1, total - 1)))
  const stackWidth = startX + Math.max(0, total - 1) * stepX + cardWidth + sidePadding

  return {
    align: "measured",
    left: Math.max(0, (maxStackWidth - stackWidth) / 2),
    ready,
    stackWidth,
    startX,
    stepX,
  }
}
