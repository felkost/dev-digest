"use client";

/* CaseEditor — modal for hand-authoring an eval case (AC-7/AC-8). The
   authoritative diff-fragment validation is server-side (`parseUnifiedDiff`
   at save time); this component only does a trivial best-effort client
   check (non-empty) and always surfaces the server's validation error
   inline on save failure, without closing the editor. */

import React from "react";
import { useTranslations } from "next-intl";
import { Modal, Button, Textarea, TextInput, SelectInput } from "@devdigest/ui";
import type { Expectation, EvalCaseListItem } from "@devdigest/shared";
import { useCreateEvalCase, useUpdateEvalCase } from "@/lib/hooks/eval";
import { ApiError } from "@/lib/api";

interface CaseEditorProps {
  agentId: string;
  /** When set, pre-fills the form for editing an existing case in place —
      save calls the update mutation (PATCH) with this case's id instead of
      creating a new case. */
  initialCase?: EvalCaseListItem | null;
  onClose: () => void;
}

interface DraftExpectation extends Expectation {
  key: string;
}

let keySeq = 0;
function nextKey() {
  keySeq += 1;
  return `exp-${keySeq}`;
}

function emptyExpectation(): DraftExpectation {
  return { key: nextKey(), type: "must_find", file: "", line_start: 1, line_end: 1 };
}

export function CaseEditor({ agentId, initialCase, onClose }: CaseEditorProps) {
  const t = useTranslations("agents");
  const createCase = useCreateEvalCase(agentId);
  const updateCase = useUpdateEvalCase(agentId);
  const isEditing = !!initialCase;
  const activeMutation = isEditing ? updateCase : createCase;

  const [name, setName] = React.useState(initialCase?.name ?? "");
  const [diff, setDiff] = React.useState(initialCase?.input_diff ?? "");
  const [notes, setNotes] = React.useState(initialCase?.notes ?? "");
  // #10 — an existing case with zero expectations (a deliberate "clean diff"
  // case, AC-9) must stay empty when edited. Branch on whether we're editing
  // at all (`initialCase` presence), NOT on `expected_output.length` — the
  // latter treats a real zero-expectation case the same as "no initial case",
  // injecting a phantom `must_find` expectation that then gets saved and
  // permanently breaks the case.
  const [expectations, setExpectations] = React.useState<DraftExpectation[]>(
    initialCase
      ? initialCase.expected_output.map((e) => ({ ...e, key: nextKey() }))
      : [emptyExpectation()],
  );
  const [error, setError] = React.useState<string | null>(null);

  const updateExpectation = (key: string, patch: Partial<Expectation>) => {
    setExpectations((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  };

  const removeExpectation = (key: string) => {
    setExpectations((prev) => prev.filter((e) => e.key !== key));
  };

  const handleSave = () => {
    setError(null);
    // Best-effort client-side pre-check only — server is authoritative.
    if (!diff.trim()) {
      setError(t("evals.editor.diffRequired"));
      return;
    }
    // The contract now requires `file: z.string().min(1)` — a leftover blank
    // row (e.g. an expectation added then never filled in, or removed via
    // "Remove" logic elsewhere) would otherwise fail server-side validation.
    // Filter those out before submit rather than surfacing a confusing 400.
    const cleanExpectations: Expectation[] = expectations
      .filter((e) => e.file.trim().length > 0)
      .map(({ key, ...e }) => {
        void key;
        return e;
      });

    const input = {
      owner_id: agentId,
      name,
      input_diff: diff,
      expected_output: cleanExpectations,
      notes: notes || null,
    };

    const mutationOptions = {
      onSuccess: () => onClose(),
      onError: (err: unknown) => {
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError(String(err));
        }
      },
    };

    if (initialCase) {
      updateCase.mutate({ caseId: initialCase.id, input }, mutationOptions);
    } else {
      createCase.mutate(input, mutationOptions);
    }
  };

  return (
    <Modal
      width={640}
      title={initialCase ? t("evals.editor.titleEdit") : t("evals.editor.titleNew")}
      onClose={onClose}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button kind="ghost" size="sm" onClick={onClose}>
            {t("evals.editor.cancel")}
          </Button>
          <Button kind="primary" size="sm" onClick={handleSave} loading={activeMutation.isPending}>
            {activeMutation.isPending ? t("evals.editor.saving") : t("evals.editor.save")}
          </Button>
        </div>
      }
    >
      <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
        {error && (
          <div
            role="alert"
            style={{
              fontSize: 12.5,
              color: "var(--crit)",
              background: "var(--crit-bg)",
              borderRadius: 6,
              padding: "8px 12px",
            }}
          >
            {error}
          </div>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("evals.editor.name")}</span>
          <TextInput value={name} onChange={setName} placeholder={t("evals.editor.namePlaceholder")} />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("evals.editor.diff")}</span>
          <Textarea value={diff} onChange={setDiff} rows={8} mono placeholder={t("evals.editor.diffPlaceholder")} />
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {expectations.map((exp) => (
            <div
              key={exp.key}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 2fr 90px 90px auto",
                gap: 8,
                alignItems: "end",
              }}
            >
              {/* NOT a <label>: SelectInput is a custom widget with no associated
                  form control. Wrapping it in <label> makes a click synthetically
                  re-fire on the first dropdown <button> (React flushes the open-state
                  re-render synchronously mid-click for discrete events), which selects
                  option[0] and closes the list before it can be seen. */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("evals.editor.expectationType")}</span>
                <SelectInput
                  value={exp.type}
                  onChange={(v) => updateExpectation(exp.key, { type: v as Expectation["type"] })}
                  options={[
                    { value: "must_find", label: t("evals.expectation.must_find") },
                    { value: "must_not_flag", label: t("evals.expectation.must_not_flag") },
                  ]}
                  mono={false}
                />
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("evals.editor.file")}</span>
                <TextInput
                  value={exp.file}
                  onChange={(v) => updateExpectation(exp.key, { file: v })}
                  placeholder={t("evals.editor.filePlaceholder")}
                  mono
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("evals.editor.lineStart")}</span>
                <TextInput
                  value={String(exp.line_start)}
                  onChange={(v) => updateExpectation(exp.key, { line_start: Number(v) || 0 })}
                  type="number"
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("evals.editor.lineEnd")}</span>
                <TextInput
                  value={String(exp.line_end)}
                  onChange={(v) => updateExpectation(exp.key, { line_end: Number(v) || 0 })}
                  type="number"
                />
              </label>
              <Button kind="ghost" size="sm" onClick={() => removeExpectation(exp.key)}>
                {t("evals.editor.removeExpectation")}
              </Button>
            </div>
          ))}
          <Button kind="secondary" size="sm" icon="Plus" onClick={() => setExpectations((prev) => [...prev, emptyExpectation()])}>
            {t("evals.editor.addExpectation")}
          </Button>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("evals.editor.notes")}</span>
          <Textarea value={notes} onChange={setNotes} rows={2} placeholder={t("evals.editor.notesPlaceholder")} />
        </label>
      </div>
    </Modal>
  );
}
