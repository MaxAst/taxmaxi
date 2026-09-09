import { useState } from "react"

import { AppWorkspace } from "#/components/app-workspace"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs"
import { Heading, Text } from "#/components/ui/typography"
import { m } from "#/paraglide/messages"

import { ApprovedExamples } from "./approved-examples"
import {
  AtelierComparisonControls,
  AtelierFeedback,
  AtelierTuningExample,
  type AtelierTheme,
} from "./atelier-tools"

export function Atelier() {
  const [theme, setTheme] = useState<AtelierTheme>("light")
  const [width, setWidth] = useState(1280)

  return (
    <AppWorkspace>
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-12">
        <header className="flex flex-col gap-2">
          <Heading as="h1">{m["atelier.title"]()}</Heading>
          <Text tone="muted">{m["atelier.introduction"]()}</Text>
        </header>
        <AtelierComparisonControls
          theme={theme}
          onThemeChange={setTheme}
          width={width}
          onWidthChange={setWidth}
        />
        <Tabs defaultValue="approved" style={{ width: "100%", maxWidth: width }}>
          <TabsList aria-label={m["atelier.navigation"]()}>
            <TabsTrigger value="approved">{m["atelier.approved"]()}</TabsTrigger>
            <TabsTrigger value="experiments">{m["atelier.experiments"]()}</TabsTrigger>
          </TabsList>
          <TabsContent value="approved" className="pt-6">
            <ApprovedExamples />
          </TabsContent>
          <TabsContent value="experiments" className="pt-6">
            <AtelierTuningExample theme={theme} />
          </TabsContent>
        </Tabs>
        <AtelierFeedback />
      </div>
    </AppWorkspace>
  )
}
