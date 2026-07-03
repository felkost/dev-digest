/* ArchitectureSection — renders the architecture overview's narrative body as
   markdown (reusing the project's existing Markdown primitive, same renderer
   as IntentCard/VerdictBanner) plus the optional mermaid diagram.

   No client-side mermaid renderer exists in the codebase yet (grepped before
   writing this) — the diagram is rendered as a labeled <pre> raw-source
   fallback. This is an accepted v1 fallback per the plan (Step 7.7), flagged
   as a follow-up, not a blocker. */
"use client";

import { useTranslations } from "next-intl";
import { Markdown } from "@devdigest/ui";
import type { OnboardingTourSection } from "@devdigest/shared";
import { s } from "./styles";

export function ArchitectureSection({ section }: { section: OnboardingTourSection }) {
  const t = useTranslations("onboarding");

  return (
    <div style={s.wrap}>
      <Markdown>{section.body}</Markdown>
      {section.diagram && (
        <div style={s.diagramWrap}>
          <div style={s.diagramLabel}>{t("sections_.architecture")}</div>
          <pre style={s.diagramPre}>{section.diagram}</pre>
        </div>
      )}
    </div>
  );
}
