"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { parsePatch } from "@/components/diff-viewer/helpers";
import type { SmartDiff, SmartDiffGroup, SmartDiffFile } from "@devdigest/shared";

interface SmartDiffViewerProps {
  smartDiff: SmartDiff;
  prId: string;
  patches: Record<string, string | null | undefined>;
}

const ROLE_META: Record<string, { label: string; description: string; color: string }> = {
  core:        { label: "Core logic",  description: "The substance of the change — review closely", color: "#4a9eff" },
  wiring:      { label: "Wiring",      description: "Hooks the core into the app",                  color: "#f0b429" },
  boilerplate: { label: "Boilerplate", description: "Generated / mechanical — skim",                color: "#6b7280" },
};

const ROLE_ORDER: string[] = ["core", "wiring", "boilerplate"];

function getSeverityColor(severity: string): string {
  if (severity === "critical") return "var(--crit)";
  if (severity === "warning") return "var(--warn)";
  return "var(--sugg)";
}

function getHighestSeverityColor(findings: SmartDiffFile["findings"]): string {
  if (!findings || findings.length === 0) return "var(--sugg)";
  if (findings.some((f) => f.severity === "critical")) return "var(--crit)";
  if (findings.some((f) => f.severity === "warning")) return "var(--warn)";
  return "var(--sugg)";
}

function getSeverityDot(severity: string): React.ReactNode {
  const color = getSeverityColor(severity);
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        marginRight: 4,
        flexShrink: 0,
      }}
    />
  );
}

interface FileViewProps {
  file: SmartDiffFile;
  patch: string | null | undefined;
  onNavigateToFinding: (findingId: string) => void;
}

function FileView({ file, patch, onNavigateToFinding }: FileViewProps) {
  const [expanded, setExpanded] = React.useState(true);
  const lines = parsePatch(patch);

  const highestColor =
    file.findingsCount > 0 ? getHighestSeverityColor(file.findings) : undefined;

  return (
    <div style={{ marginBottom: 8, border: "1px solid var(--border)", borderRadius: 6 }}>
      {/* File header */}
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          background: "var(--bg-hover)",
          cursor: "pointer",
          borderRadius: expanded ? "6px 6px 0 0" : 6,
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            color: "var(--text-primary)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {file.path}
        </span>
        <span style={{ fontSize: 11, color: "#4caf50", flexShrink: 0 }}>
          +{file.additions}
        </span>
        <span style={{ fontSize: 11, color: "#f44336", flexShrink: 0 }}>
          -{file.deletions}
        </span>
        {file.findingsCount > 0 && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#fff",
              background: highestColor,
              borderRadius: 10,
              padding: "1px 7px",
              flexShrink: 0,
            }}
          >
            {file.findingsCount} finding{file.findingsCount !== 1 ? "s" : ""}
          </span>
        )}
        {file.pseudocode_summary && (
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              maxWidth: 260,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 1,
            }}
          >
            {file.pseudocode_summary}
          </span>
        )}
      </div>

      {/* File diff content */}
      {expanded && (
        <div style={{ overflowX: "auto" }}>
          {!patch ? (
            <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 12 }}>
              Patch not available
            </div>
          ) : (
            <div style={{ fontFamily: "monospace", fontSize: 12, lineHeight: "18px" }}>
              {lines.map((line, idx) => {
                if (line.kind === "hunk") {
                  return (
                    <div
                      key={idx}
                      style={{
                        background: "#1a2030",
                        color: "var(--text-muted)",
                        padding: "2px 8px",
                        fontSize: 11,
                      }}
                    >
                      @@ hunk @@
                    </div>
                  );
                }

                const lineNo = line.newNo ?? line.oldNo ?? "";
                const findingOnLine =
                  line.newNo !== undefined && file.findings
                    ? file.findings.find((f) => f.startLine === line.newNo)
                    : undefined;

                let bg = "transparent";
                let borderLeft = "3px solid transparent";
                let prefix = " ";

                if (line.kind === "add") {
                  bg = "rgba(76, 175, 80, 0.1)";
                  borderLeft = "3px solid rgba(76, 175, 80, 0.6)";
                  prefix = "+";
                } else if (line.kind === "del") {
                  bg = "rgba(244, 67, 54, 0.1)";
                  borderLeft = "3px solid rgba(244, 67, 54, 0.6)";
                  prefix = "-";
                }

                return (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      background: bg,
                      borderLeft,
                      minHeight: 18,
                    }}
                  >
                    {/* Line number gutter */}
                    <span
                      style={{
                        minWidth: 40,
                        textAlign: "right",
                        paddingRight: 8,
                        color: "var(--text-muted)",
                        fontSize: 11,
                        userSelect: "none",
                        flexShrink: 0,
                      }}
                    >
                      {lineNo}
                    </span>
                    {/* Prefix (+/-/ ) */}
                    <span
                      style={{
                        width: 14,
                        color:
                          line.kind === "add"
                            ? "#4caf50"
                            : line.kind === "del"
                              ? "#f44336"
                              : "var(--text-muted)",
                        flexShrink: 0,
                        userSelect: "none",
                      }}
                    >
                      {prefix}
                    </span>
                    {/* Line content */}
                    <span
                      style={{
                        flex: 1,
                        whiteSpace: "pre",
                        color: "var(--text-primary)",
                        overflow: "hidden",
                      }}
                    >
                      {line.text}
                    </span>
                    {/* Finding badge */}
                    {findingOnLine && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNavigateToFinding(findingOnLine.id);
                        }}
                        title={`[${findingOnLine.category}] ${findingOnLine.title}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          flexShrink: 0,
                          marginLeft: 8,
                          marginRight: 6,
                          padding: "1px 8px",
                          borderRadius: 10,
                          border: `1px solid ${getSeverityColor(findingOnLine.severity)}`,
                          background: "transparent",
                          color: getSeverityColor(findingOnLine.severity),
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {getSeverityDot(findingOnLine.severity)}
                        {findingOnLine.severity}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface GroupViewProps {
  group: SmartDiffGroup;
  patches: Record<string, string | null | undefined>;
  onNavigateToFinding: (findingId: string) => void;
}

function GroupView({ group, patches, onNavigateToFinding }: GroupViewProps) {
  const meta = ROLE_META[group.role] ?? { label: group.role, description: "", color: "#6b7280" };
  const [expanded, setExpanded] = React.useState(group.role !== "boilerplate");

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Group header */}
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "var(--bg-hover)",
          borderRadius: 8,
          cursor: "pointer",
          userSelect: "none",
          marginBottom: expanded ? 8 : 0,
        }}
      >
        {/* Role colour dot */}
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: meta.color,
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 700, fontSize: 13, color: "var(--text-primary)" }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-secondary)", flex: 1 }}>
          {meta.description}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            background: "rgba(255,255,255,0.07)",
            borderRadius: 10,
            padding: "1px 7px",
            flexShrink: 0,
          }}
        >
          {group.files.length} file{group.files.length !== 1 ? "s" : ""}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
          {expanded ? "▾" : "▸"}
        </span>
      </div>

      {/* Files */}
      {expanded && (
        <div style={{ paddingLeft: 0 }}>
          {group.files.map((file) => (
            <FileView
              key={file.path}
              file={file}
              patch={patches[file.path]}
              onNavigateToFinding={onNavigateToFinding}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SmartDiffViewer({ smartDiff, patches }: SmartDiffViewerProps) {
  const router = useRouter();

  function navigateToFinding(findingId: string) {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", "findings");
    params.set("findingId", findingId);
    router.replace(`?${params.toString()}`);
  }

  // Sort groups: core → wiring → boilerplate
  const sortedGroups = [...smartDiff.groups].sort((a, b) => {
    const ai = ROLE_ORDER.indexOf(a.role);
    const bi = ROLE_ORDER.indexOf(b.role);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <div>
      {sortedGroups.map((group) => (
        <GroupView
          key={group.role}
          group={group}
          patches={patches}
          onNavigateToFinding={navigateToFinding}
        />
      ))}
    </div>
  );
}
