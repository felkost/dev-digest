/* FirstTasksSection — horizontal cards from OnboardingTourTask (title,
   target_path, complexity). Complexity badge colors come from the local
   COMPLEXITY token map (feature-local promotion rule — not in shared tokens.ts). */
"use client";

import { useTranslations } from "next-intl";
import type { OnboardingTourSection } from "@devdigest/shared";
import { COMPLEXITY } from "../OnboardingTourView/constants";
import { s } from "./styles";

export function FirstTasksSection({ section }: { section: OnboardingTourSection }) {
  const t = useTranslations("onboarding");

  return (
    <div style={s.wrap}>
      {section.body && <p style={s.body}>{section.body}</p>}
      <div style={s.cardsRow}>
        {section.tasks.map((task, i) => {
          const complexity = COMPLEXITY[task.complexity];
          return (
            <div key={`${task.target_path}-${i}`} style={s.card}>
              <div style={s.cardTitle}>{task.title}</div>
              <span className="mono" style={s.targetPath}>
                {task.target_path}
              </span>
              <span
                style={{
                  ...s.complexityBadge,
                  color: complexity.c,
                  background: complexity.bg,
                }}
              >
                {t(`complexity.${task.complexity}`)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
