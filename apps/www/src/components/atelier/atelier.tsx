import { AppWorkspace } from "#/components/app-workspace"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs"
import { Heading, Text } from "#/components/ui/typography"
import { m } from "#/paraglide/messages"

import { ApprovedExamples } from "./approved-examples"

export function Atelier() {
  return (
    <AppWorkspace>
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-12">
        <header className="flex flex-col gap-2">
          <Heading as="h1">{m["atelier.title"]()}</Heading>
          <Text tone="muted">{m["atelier.introduction"]()}</Text>
        </header>
        <Tabs defaultValue="approved">
          <TabsList aria-label={m["atelier.navigation"]()}>
            <TabsTrigger value="approved">{m["atelier.approved"]()}</TabsTrigger>
            <TabsTrigger value="experiments">{m["atelier.experiments"]()}</TabsTrigger>
          </TabsList>
          <TabsContent value="approved" className="pt-6">
            <ApprovedExamples />
          </TabsContent>
          <TabsContent value="experiments" className="pt-6">
            <Text tone="muted">{m["atelier.experiments_empty"]()}</Text>
          </TabsContent>
        </Tabs>
      </div>
    </AppWorkspace>
  )
}
