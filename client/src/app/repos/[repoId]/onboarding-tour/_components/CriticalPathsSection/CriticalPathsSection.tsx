/* CriticalPathsSection — rows of path + rationale + "Open" action.
   The Open action renders ONLY when entry.github_link is non-null (AC-8/9) —
   the link is already resolved server-side via mapGithubLink; the client
   never attempts to construct its own URL. */
"use client";

import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { OnboardingTourSection } from "@devdigest/shared";
import { s } from "./styles";

export function CriticalPathsSection({ section }: { section: OnboardingTourSection }) {
  const t = useTranslations("onboarding");

  return (
    <div style={s.wrap}>
      {section.body && <p style={s.body}>{section.body}</p>}
      <ul style={s.list}>
        {section.entries.map((entry, i) => (
          <li key={`${entry.path}-${i}`} style={s.row}>
            <div style={s.rowMain}>
              <span className="mono" style={s.path}>
                {entry.path}
              </span>
              <p style={s.rationale}>{entry.rationale}</p>
            </div>
            {entry.github_link && (
              <a
                href={entry.github_link}
                target="_blank"
                rel="noopener noreferrer"
                style={s.openAction}
              >
                <Icon.ExternalLink size={12} />
                {t("openAction")}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
