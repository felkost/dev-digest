"use client";

import React, { useState } from "react";
import { Button, Badge, Icon, Skeleton, FormField, TextInput, Textarea } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { useSkillEvals, useCreateSkillEval, useDeleteSkillEval } from "../../../../lib/hooks/skills";

interface EvalsTabProps {
  skill: Skill;
}

function statusIcon(lastRun?: { pass: boolean | null } | null) {
  if (!lastRun) return <Icon.Dot size={16} style={{ color: "var(--text-muted)" }} />;
  if (lastRun.pass === null) return <Icon.Clock size={14} style={{ color: "var(--text-muted)" }} />;
  return lastRun.pass ? (
    <Icon.CheckCircle size={14} style={{ color: "var(--ok)" }} />
  ) : (
    <Icon.XCircle size={14} style={{ color: "var(--crit)" }} />
  );
}

export function EvalsTab({ skill }: EvalsTabProps) {
  const { data: evals, isLoading } = useSkillEvals(skill.id);
  const createEval = useCreateSkillEval(skill.id);
  const deleteEval = useDeleteSkillEval(skill.id);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDiff, setNewDiff] = useState("");

  const passed = (evals ?? []).filter((e) => e.last_run?.pass === true).length;
  const total = (evals ?? []).length;

  const handleCreate = () => {
    if (!newName.trim()) return;
    createEval.mutate(
      { name: newName.trim(), input_diff: newDiff, expected_output: null },
      {
        onSuccess: () => {
          setShowNew(false);
          setNewName("");
          setNewDiff("");
        },
      },
    );
  };

  return (
    <div style={{ padding: "24px 28px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700 }}>Eval cases</h2>
        {total > 0 && (
          <Badge color={passed === total ? "var(--ok)" : "var(--color-warning)"}>
            {passed}/{total} passing
          </Badge>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Button kind="secondary" size="sm" icon="Play" disabled>
            Run all evals
          </Button>
          <Button kind="primary" size="sm" icon="Plus" onClick={() => setShowNew(true)}>
            New eval case
          </Button>
        </div>
      </div>

      {isLoading && <Skeleton height={60} style={{ marginBottom: 8 }} />}

      {!isLoading && total === 0 && !showNew && (
        <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 13, padding: "32px 0" }}>
          No eval cases yet. Create one to test this skill.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {(evals ?? []).map((ec) => (
          <div
            key={ec.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 14px",
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
            }}
          >
            {statusIcon(ec.last_run)}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{ec.name}</div>
              {ec.last_run && (
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {ec.last_run.pass ? "Passed" : "Failed"} &middot; {new Date(ec.last_run.ran_at).toLocaleDateString()}
                </div>
              )}
              {!ec.last_run && (
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>never run</div>
              )}
            </div>
            <button
              onClick={() => deleteEval.mutate(ec.id)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: "var(--text-muted)" }}
              title="Delete eval case"
            >
              <Icon.Trash size={14} />
            </button>
          </div>
        ))}
      </div>

      {showNew && (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
          }}
        >
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>New eval case</h3>
          <div style={{ marginBottom: 12 }}>
            <FormField label="Name" required>
              <TextInput value={newName} onChange={setNewName} placeholder="stripe-key-leak" />
            </FormField>
          </div>
          <div style={{ marginBottom: 12 }}>
            <FormField label="Input diff (paste)">
              <Textarea
                value={newDiff}
                onChange={setNewDiff}
                rows={5}
                mono
                placeholder="@@ -1,3 +1,5 @@&#10;+const key = 'sk_live_...';"
              />
            </FormField>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button kind="secondary" size="sm" onClick={() => setShowNew(false)}>
              Cancel
            </Button>
            <Button kind="primary" size="sm" onClick={handleCreate} disabled={!newName.trim() || createEval.isPending}>
              {createEval.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
