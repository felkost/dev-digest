/* persona.ts — reviewer-persona branding (icon + accent color), inferred
   from the agent's name. Co-located at the feature root (see format.ts's
   header comment for why) so both ColumnsView and TabsView can share one
   heuristic instead of drifting apart with two copies.

   Not a real data field on AgentColumn (the frozen shared contract carries
   only agent_id/agent_name) — a name-keyword heuristic covering the seeded
   personas, with a neutral fallback for any other/custom agent name so
   nothing breaks as new agents are added. */
import type { IconName } from "@devdigest/ui";

export interface PersonaStyle {
  icon: IconName;
  color: string;
  bg: string;
}

const PERSONA_STYLES: { match: RegExp; icon: IconName; color: string; bg: string }[] = [
  { match: /security/i, icon: "Shield", color: "var(--crit)", bg: "var(--crit-bg)" },
  { match: /performance/i, icon: "Zap", color: "var(--warn)", bg: "var(--warn-bg)" },
  { match: /architecture/i, icon: "Layers", color: "var(--accent)", bg: "var(--accent-bg)" },
  { match: /mentor|junior/i, icon: "Lightbulb", color: "var(--accent)", bg: "var(--accent-bg)" },
  { match: /customer/i, icon: "Users", color: "#a78bfa", bg: "rgba(167, 139, 250, 0.14)" },
];

const DEFAULT_PERSONA_STYLE: PersonaStyle = {
  icon: "Cpu",
  color: "var(--text-muted)",
  bg: "var(--info-bg)",
};

export function personaStyle(agentName: string): PersonaStyle {
  return PERSONA_STYLES.find((p) => p.match.test(agentName)) ?? DEFAULT_PERSONA_STYLE;
}
