import { useState } from "react"

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
import { Heading, Text } from "#/components/ui/typography"
import { m } from "#/paraglide/messages"

export function ApprovedExamples() {
  const [detailsVisible, setDetailsVisible] = useState(false)

  return (
    <Card className={appSurfaceClassName}>
      <CardHeader>
        <CardTitle>
          <Heading>{m["atelier.example_title"]()}</Heading>
        </CardTitle>
        <CardDescription>{m["atelier.example_description"]()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Text>{m["atelier.example_body"]()}</Text>
        <div id="atelier-example-details" hidden={!detailsVisible}>
          <Text size="bodySm" tone="muted">
            {m["atelier.example_details"]()}
          </Text>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          aria-expanded={detailsVisible}
          aria-controls="atelier-example-details"
          onClick={() => setDetailsVisible((visible) => !visible)}
        >
          {detailsVisible ? m["atelier.hide_details"]() : m["atelier.show_details"]()}
        </Button>
      </CardFooter>
    </Card>
  )
}
