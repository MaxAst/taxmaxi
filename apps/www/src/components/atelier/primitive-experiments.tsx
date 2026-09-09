import { useDialKitController } from "dialkit"
import { LoaderCircle } from "lucide-react"
import { useMemo, useState, type CSSProperties } from "react"

import { appSurfaceClassName } from "#/components/app-workspace"
import { Button } from "#/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu"
import { Input } from "#/components/ui/input"
import { Heading, Text } from "#/components/ui/typography"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

import "./atelier-experiments.css"

type Treatment = "mono" | "geist" | "editorial"
type ExperimentStyle = CSSProperties & {
  "--atelier-height-offset": string
  "--atelier-radius-offset": string
  "--atelier-type-scale": number
}

export function PrimitiveExperiments() {
  const heightLabel = m["atelier.primitive_height"]()
  const radiusLabel = m["atelier.primitive_radius"]()
  const typeLabel = m["atelier.primitive_type_scale"]()
  const config = useMemo<Record<string, [number, number, number, number]>>(
    () => ({
      [heightLabel]: [0, 0, 12, 1],
      [radiusLabel]: [0, 0, 12, 1],
      [typeLabel]: [1, 0.9, 1.2, 0.05],
    }),
    [heightLabel, radiusLabel, typeLabel]
  )
  const controls = useDialKitController(m["atelier.primitive_controls"](), config, {
    id: "atelier-primitive-controls",
    persist: false,
  })
  const style: ExperimentStyle = {
    "--atelier-height-offset": `${controls.values[heightLabel]}px`,
    "--atelier-radius-offset": `${controls.values[radiusLabel]}px`,
    "--atelier-type-scale": controls.values[typeLabel] ?? 1,
  }

  return (
    <section aria-label={m["atelier.primitive_comparison"]()} className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Heading>{m["atelier.primitive_comparison"]()}</Heading>
        <Text tone="muted">{m["atelier.primitive_guidance"]()}</Text>
        <Button type="button" variant="outline" onClick={controls.resetValues}>
          {m["atelier.primitive_reset"]()}
        </Button>
      </div>
      <PrimitiveTreatment
        treatment="mono"
        title={m["atelier.primitive_mono"]()}
        description={m["atelier.primitive_mono_description"]()}
        style={style}
      />
      <PrimitiveTreatment
        treatment="geist"
        title={m["atelier.primitive_geist"]()}
        description={m["atelier.primitive_geist_description"]()}
        style={style}
      />
      <PrimitiveTreatment
        treatment="editorial"
        title={m["atelier.primitive_editorial"]()}
        description={m["atelier.primitive_editorial_description"]()}
        style={style}
      />
    </section>
  )
}

function PrimitiveTreatment({
  treatment,
  title,
  description,
  style,
}: {
  treatment: Treatment
  title: string
  description: string
  style: ExperimentStyle
}) {
  const [notice, setNotice] = useState("")
  const states = [
    { id: "default", label: m["atelier.primitive_default"]() },
    { id: "hover", label: m["atelier.primitive_hover"]() },
    { id: "focus", label: m["atelier.primitive_focus"]() },
    { id: "pressed", label: m["atelier.primitive_pressed"]() },
    { id: "disabled", label: m["atelier.primitive_disabled"]() },
    { id: "loading", label: m["atelier.primitive_loading"]() },
  ]
  const showLocalAction = () => setNotice(m["atelier.primitive_local_action"]())

  return (
    <article
      id={`atelier-primitive-${treatment}`}
      aria-label={title}
      className="atelier-primitive flex flex-col gap-6"
      data-treatment={treatment}
      style={style}
    >
      <header className="flex flex-col gap-2">
        <Heading as="h3">{title}</Heading>
        <Text tone="muted">{description}</Text>
      </header>
      <section aria-label={m["atelier.primitive_states"]()} className="flex flex-col gap-3">
        <Text size="bodySm">{m["atelier.primitive_state_guidance"]()}</Text>
        <div className="atelier-primitive-states">
          {states.map(({ id, label }) => (
            <div key={id} className="flex min-w-0 flex-col items-start gap-2">
              <Text size="caption" tone="muted">
                {label}
              </Text>
              <Button
                type="button"
                data-preview-state={id}
                disabled={id === "disabled" || id === "loading"}
                aria-busy={id === "loading"}
                onClick={showLocalAction}
              >
                {id === "loading" ? (
                  <LoaderCircle
                    aria-hidden="true"
                    data-icon="inline-start"
                    className="atelier-primitive-spinner"
                  />
                ) : null}
                {m["atelier.primitive_continue"]()}
              </Button>
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" onClick={showLocalAction}>
          {m["atelier.primitive_long_action"]()}
        </Button>
      </section>
      <Card className={cn(appSurfaceClassName, "min-w-0")}>
        <CardHeader>
          <CardDescription>{m["atelier.primitive_dashboard"]()}</CardDescription>
          <CardTitle>
            <Heading as="h4">{m["atelier.primitive_portfolio"]()}</Heading>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Text className="atelier-primitive-balance">{m["atelier.primitive_balance"]()}</Text>
          <Text>{m["atelier.primitive_profit"]()}</Text>
          <Text size="bodySm" tone="muted">
            {m["atelier.primitive_freshness"]()}
          </Text>
        </CardContent>
        <CardFooter className="flex flex-wrap gap-3">
          <Button type="button" onClick={showLocalAction}>
            {m["atelier.primitive_view_transactions"]()}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline">
                {m["atelier.primitive_actions"]()}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="atelier-primitive-menu"
              data-treatment={treatment}
              style={style}
              align="start"
            >
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={showLocalAction}>
                  {m["atelier.primitive_view_transactions"]()}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={showLocalAction}>
                  {m["atelier.primitive_long_action"]()}
                </DropdownMenuItem>
                <DropdownMenuItem disabled>{m["atelier.primitive_unavailable"]()}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardFooter>
      </Card>
      <form
        className={cn(appSurfaceClassName, "flex flex-col gap-4 p-6")}
        onSubmit={(event) => {
          event.preventDefault()
          setNotice(m["atelier.primitive_saved"]())
        }}
      >
        <Heading as="h4">{m["atelier.primitive_form"]()}</Heading>
        <label htmlFor={`atelier-name-${treatment}`}>{m["atelier.primitive_name"]()}</label>
        <Input
          id={`atelier-name-${treatment}`}
          name="exampleName"
          defaultValue={m["atelier.primitive_name_value"]()}
          required
        />
        <Text size="bodySm" tone="muted">
          {m["atelier.primitive_form_guidance"]()}
        </Text>
        <div className="flex flex-wrap gap-3">
          <Button type="submit">{m["atelier.primitive_save"]()}</Button>
          <Button type="reset" variant="outline" onClick={() => setNotice("")}>
            {m["atelier.primitive_restore"]()}
          </Button>
        </div>
      </form>
      <Text role="status" size="bodySm" className="min-h-12">
        {notice || m["atelier.primitive_no_action"]()}
      </Text>
    </article>
  )
}
