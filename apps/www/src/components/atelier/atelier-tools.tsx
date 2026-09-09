import { Agentation } from "agentation"
import { DialRoot, useDialKitController } from "dialkit"
import "dialkit/styles.css"
import { useEffect, useMemo, useState } from "react"
import { z } from "zod"

import { appSurfaceClassName } from "#/components/app-workspace"
import { Button } from "#/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select"
import { Textarea } from "#/components/ui/textarea"
import { Heading, Text } from "#/components/ui/typography"
import { m } from "#/paraglide/messages"
import { getLocale, setLocale } from "#/paraglide/runtime"

const themeSchema = z.enum(["light", "dark"])
const localeSchema = z.enum(["en", "de"])
const widthSchema = z.enum(["390", "1280"])
export type AtelierTheme = z.infer<typeof themeSchema>

export function AtelierComparisonControls({
  theme,
  onThemeChange,
  width,
  onWidthChange,
}: {
  theme: AtelierTheme
  onThemeChange: (theme: AtelierTheme) => void
  width: number
  onWidthChange: (width: number) => void
}) {
  const [viewportWidth, setViewportWidth] = useState<number | null>(null)

  useEffect(() => {
    const root = document.documentElement
    const previous = {
      light: root.classList.contains("light"),
      dark: root.classList.contains("dark"),
      theme: root.getAttribute("data-theme"),
      colorScheme: root.style.colorScheme,
    }
    onThemeChange(previous.dark ? "dark" : "light")
    return () => {
      root.classList.toggle("light", previous.light)
      root.classList.toggle("dark", previous.dark)
      if (previous.theme === null) root.removeAttribute("data-theme")
      else root.setAttribute("data-theme", previous.theme)
      root.style.colorScheme = previous.colorScheme
    }
  }, [onThemeChange])

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove("light", "dark")
    root.classList.add(theme)
    root.setAttribute("data-theme", theme)
    root.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth)
    updateWidth()
    window.addEventListener("resize", updateWidth)
    return () => window.removeEventListener("resize", updateWidth)
  }, [])

  return (
    <section aria-label={m["atelier.comparison"]()} className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Select value={theme} onValueChange={(value) => onThemeChange(themeSchema.parse(value))}>
          <SelectTrigger aria-label={m["atelier.theme"]()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="light">{m["atelier.light"]()}</SelectItem>
              <SelectItem value="dark">{m["atelier.dark"]()}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={getLocale()}
          onValueChange={(value) => {
            void setLocale(localeSchema.parse(value))
          }}
        >
          <SelectTrigger aria-label={m["atelier.locale"]()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="en">{m["atelier.english"]()}</SelectItem>
              <SelectItem value="de">{m["atelier.german"]()}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={String(width)}
          onValueChange={(value) => onWidthChange(Number(widthSchema.parse(value)))}
        >
          <SelectTrigger aria-label={m["atelier.width_preset"]()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="390">{m["atelier.mobile_width"]()}</SelectItem>
              <SelectItem value="1280">{m["atelier.desktop_width"]()}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <Text size="bodySm" tone="muted">
        {m["atelier.width_guidance"]({
          target: width,
          actual: viewportWidth ?? m["atelier.width_unknown"](),
        })}
      </Text>
    </section>
  )
}

export function AtelierTuningExample({ theme }: { theme: AtelierTheme }) {
  const radiusLabel = m["atelier.corner_radius"]()
  const paddingLabel = m["atelier.padding"]()
  const config = useMemo<Record<string, [number, number, number, number]>>(
    () => ({
      [radiusLabel]: [24, 0, 48, 1],
      [paddingLabel]: [24, 8, 48, 1],
    }),
    [radiusLabel, paddingLabel]
  )
  const controls = useDialKitController(m["atelier.tuning_panel"](), config, {
    id: "atelier-tuning-example",
    persist: false,
  })

  return (
    <div className="flex flex-col gap-6">
      <Text tone="muted">{m["atelier.tuning_guidance"]()}</Text>
      <section
        id="atelier-tuning-example"
        aria-label={m["atelier.tuning_example"]()}
        className={appSurfaceClassName}
        style={{
          borderRadius: controls.values[radiusLabel],
          padding: controls.values[paddingLabel],
        }}
      >
        <Heading>{m["atelier.tuning_example"]()}</Heading>
        <Text>{m["atelier.tuning_sample"]()}</Text>
      </section>
      <Button type="button" variant="outline" onClick={controls.resetValues}>
        {m["atelier.reset_tuning"]()}
      </Button>
      <DialRoot mode="inline" theme={theme} />
    </div>
  )
}

export function AtelierFeedback() {
  const [feedback, setFeedback] = useState("")
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle")

  async function copyFeedback() {
    try {
      await navigator.clipboard.writeText(feedback)
      setCopyStatus("copied")
    } catch {
      setCopyStatus("failed")
    }
  }

  return (
    <section aria-label={m["atelier.feedback"]()} className="flex flex-col gap-3">
      <Text size="bodySm" tone="muted">
        {m["atelier.feedback_guidance"]()}
      </Text>
      <Agentation
        onCopy={(markdown) => {
          setFeedback(markdown)
          setCopyStatus("idle")
        }}
      />
      {feedback ? (
        <>
          <Textarea
            aria-label={m["atelier.feedback_output"]()}
            value={feedback}
            readOnly
            rows={8}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void copyFeedback()
            }}
          >
            {m["atelier.copy_feedback"]()}
          </Button>
          <Text size="bodySm" role="status">
            {copyStatus === "copied"
              ? m["atelier.feedback_copied"]()
              : copyStatus === "failed"
                ? m["atelier.feedback_copy_failed"]()
                : m["atelier.feedback_ready"]()}
          </Text>
        </>
      ) : null}
    </section>
  )
}
