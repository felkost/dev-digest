# L06 Eval Pipeline — handoff / стан роботи (2026-07-06)

> **Призначення цього файлу:** відкрий його в новій сесії, щоб швидко ввести агента в курс
> справи по фічі L06 Eval Pipeline. Тут: що зроблено, де шукати деталі, операційні нотатки,
> і **журнал для нових багів** (секція наприкінці — саме туди дописуй нові описи проблем).

---

## TL;DR стану

- Фіча **реалізована → code-review (29+2 CONFIRMED) → фікс-хвиля застосована → верифіковано**.
- Гейти зелені: server `verify:l06` **124/124**, client typecheck чисто, client vitest **191** (190 + новий регресійний тест CaseEditor).
- Plan-verifier: **54 ✅ / 0 ⚠️ / 0 ❌**.
- **Усе НЕ закоммічено**, гілка `feat/lesson_06`. Коміт робить користувач.

---

## 📋 Промпт для нової сесії (скопіюй увесь блок)

```
Продовжуємо/супроводжуємо L06 Eval Pipeline (гілка feat/lesson_06, усе некоммічено).

Стан: фічу реалізовано, code-review пройдено, фікс-хвилю застосовано, верифіковано зеленим
(server verify:l06 124/124, client typecheck + vitest зелені, plan-verifier 54✅/0⚠️/0❌).

Прочитай ПЕРШИМИ (самодостатні):
1. docs/plans/2026-07-06-l06-eval-handoff.md — цей файл: стан, індекс, журнал багів.
2. docs/plans/2026-07-05-eval-pipeline.review.md — усі знахідки рев'ю + як їх пофіксили.
3. docs/plans/2026-07-05-eval-pipeline.md — план (Implementation Steps / AC / Testing Plan).
4. docs/feature-requirements/2026-07-05-eval-pipeline.md — специфікація (39 EARS AC).

Код: server/src/modules/eval/**, server/src/db/schema/eval.ts, migrations 0016 & 0018,
контракти server|client/src/vendor/shared/contracts/eval-batch.ts (byte-identical дзеркала),
client/src/lib/hooks/eval.ts, client EvalsTab: client/src/app/agents/[id]/_components/
AgentEditor/_components/EvalsTab/**, FindingCard: .../pulls/[number]/_components/FindingCard/.

insights: server/insights.md + client/insights.md (гуглити по "eval").

Правила: коміт робить лише користувач (давай commit messages, не комінь сам);
не запускай своїх dev-серверів — у користувача свої :3001/:3000; питання став українською.

Якщо є новий баг — він описаний у секції "🐞 Журнал нових багів" цього handoff-файлу; візьми звідти.
```

---

## Що зроблено (стисло)

**Реалізація (Phases 0–5):** повний eval-pipeline — `eval_batches`/`eval_runs`, детерміноване
скорінг (recall/precision/citation, без LLM), batch/calibration/degraded/flaked, seed з 5 кейсів,
клієнтська вкладка Evals (case list, editor, batch history, trend, compare, KPI-delta),
кнопка «Add to evals» на finding-картці. Спека — SDD (spec → plan → implement).

**Code-review (Phase 6, xhigh):** 29 CONFIRMED + 2 net-new (N1 negative precision, N2 tiebreak).
Повний ранжований список із фікс-підказками — у `…eval-pipeline.review.md`.

**Фікс-хвиля (2026-07-06):** усі correctness-баги + обрані cleanup. Ключові рішення користувача:
- #9 run-роут → **202 + polling** (detached fan-out, клієнт полить batch-detail);
- #13 citation → **pooled** per AC-22 (kept/dropped через CaseRunOutcome);
- #14 strategy у fingerprint → **лишили за буквою AC-17** (відомий gap спеки, свідомо не додано);
- cleanup: client wire types → shared, `createHash('sha256')`, S5 KPI-delta route+UI, S3 rate-limit per-workspace, N+1 countSkillOwned, стейл AGENTS.md.
- N1 (HIGH): precision більше не йде в мінус (violations рахуються per-kept-finding, clamp).
- Баг #1 (seed line-numbers) — перетрасовано на new-side нумерацію (12/20/14/8).
- UI-баг Select-типу в CaseEditor — знято `<label>`-обгортку (див. журнал нижче, вирішено).

**Свідомо НЕ робили:** #14 strategy, S1 (нешкідливий snapshot-drift 0016/0017), composite index (deferred).

---

## Де що лежить (індекс)

| Тема | Файл |
|------|------|
| Специфікація (WHAT, 39 EARS AC) | `docs/feature-requirements/2026-07-05-eval-pipeline.md` |
| План (HOW, steps/AC/testing) | `docs/plans/2026-07-05-eval-pipeline.md` |
| Знахідки code-review + фікси | `docs/plans/2026-07-05-eval-pipeline.review.md` |
| Інструкція користувача (вкладка Evals) | `docs/eval-tab-guide.md` |
| Цей handoff + журнал багів | `docs/plans/2026-07-06-l06-eval-handoff.md` |
| Server-код | `server/src/modules/eval/{routes,service,run-orchestrator,repository,scoring,helpers}.ts` |
| Schema + міграції | `server/src/db/schema/eval.ts`, `server/src/db/migrations/{0016_eval_batches,0018_eval_run_counts}.sql` |
| Контракти (2 дзеркала) | `server|client/src/vendor/shared/contracts/eval-batch.ts` |
| Client hooks | `client/src/lib/hooks/eval.ts` |
| Client UI | `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/**` |
| Server-тести | `server/test/eval-{scoring,repository,service,routes}.test.ts` |
| Client-тести | `EvalsTab.test.tsx`, `CaseEditor.test.tsx`, `FindingCard.test.tsx` |
| Insights (гуглити "eval") | `server/insights.md`, `client/insights.md` |

---

## Операційні нотатки (щоб фіча працювала в запущеному застосунку)

1. **Міграції застосовані** (0016 + 0018) до dev-БД — повторно НЕ треба.
2. **Seed виправлений і пересіяний** (12/20/14/8). Пам'ятай: seed кейсів = `onConflictDoNothing`,
   тож зміна seed-даних вимагає спершу `delete from eval_runs; delete from eval_batches; delete from eval_cases`, тоді `pnpm db:seed`.
3. **Рестарт API :3001** обов'язковий після pull/зміни коду — Fastify реєструє роути на старті.
4. Перший справжній прогін — кнопка **Run all evals** (реальний LLM-виклик, коштує $).

---

## Незакриті дрібниці / follow-ups (не блокери)

- `compareBatches` тепер повертає **422**, якщо обидва батчі all-errored (метрики null) — UI compare
  варто показувати «not comparable» замість тосту-помилки. Рідкісний edge (S2 обмежує compare до full-батчів).
- `getTrend` **тихо** відкидає sealed-but-all-errored full-батчі з тренду (немає wire-сигналу «N excluded») —
  наслідок замороженого non-nullable контракту `EvalTrendPointV2`. Видимий індикатор = зміна контракту.
- `client/src/vendor/shared/contracts/eval-ci.ts` синкнуто з сервером (AgentManifest) — це трек
  **Export-to-CI**, НЕ L06. Має йти **окремим комітом** (не в L06-коміт).

---

## 🐞 Журнал нових багів

> **Сюди дописуй нові баги.** Формат кожного запису — заголовок + що бачиш + де (URL/крок) + скрін (за наявності).
> Коли візьмеш баг у роботу — постав статус. Вирішені лишай із познач́кою ✅ (для історії).

**Шаблон:**
```
### [ID] Короткий заголовок — СТАТУС (new / in-progress / ✅ fixed)
- Симптом: <що саме не так, як відтворити>
- Де: <екран / роут / файл, якщо відомо>
- Скрін: <опис або посилання>
- Діагноз/фікс: <заповнюється при вирішенні>
```

### B1 CaseEditor: Select типу очікування не відкривався, клік перемикав на «must find» — ✅ fixed (2026-07-06)
- Симптом: клік по «Expectation type» не розкривав список; значення тихо ставало першим варіантом.
- Де: модалка «Edit eval case» → рядок expectation → Select типу.
- Діагноз/фікс: `SelectInput` був у `<label>`; React синхронно флашить discrete-подію, тож клік
  синтетично «дострілював» по першій кнопці-опції. Знято `<label>` → `<div>` у `CaseEditor.tsx`.
  Регресійний тест у `CaseEditor.test.tsx`. Деталі — `client/insights.md` (2026-07-06).

<!-- Нові баги додавай нижче цього рядка -->

### B6 Newer Anthropic models Degraded — `temperature` deprecated (CODE bug in AnthropicProvider) — ✅ fixed (2026-07-06)
- **FIX APPLIED:** `anthropic.ts` gained `createMessage()` wrapper + `isTemperatureDeprecatedError()` (status===400 + /temperature/i on body/message) → retries once with `temperature` stripped, no hardcoded model list; both `doComplete`+`completeStructured` route through it. Test `server/test/anthropic-provider.test.ts` (4/4). Also `pricing.ts` gained `claude-sonnet-5` ($3/$15) so Claude-5 runs show COST (fable-5 was already priced). After restart :3001, fable-5/sonnet-5 give Clean **with** cost. Commit: `fix(server): retry Anthropic calls without temperature on deprecation 400` (+ pricing entry, can fold in).
- **ФАКТ (з БД `eval_runs.error_message`, витягнуто після drill-down-фічі):** `400 invalid_request_error: "`+"`"+`temperature`+"`"+` is deprecated for this model."` для `claude-fable-5` (провайдер anthropic). **Це НЕ model-access** — модель доступна, Anthropic відхиляє **параметр запиту**. Попередня «інференція про 404/alias» була **ХИБНА** — саме тому й будували drill-down-фічу; вона одразу дала правду.
- Причина (код): `server/src/adapters/llm/anthropic.ts` **хардкодить** `temperature` у двох місцях — `doComplete` (:75 `?? 0.2`) і `completeStructured` (:111 `?? 0`, цим іде review/eval). Новіші Anthropic-моделі (fable-5, ~sonnet-5) задепрекейтили `temperature` → 400. haiku ще приймає → Clean. Ламає **будь-який** рев'ю з новішими Anthropic-моделями, не лише eval.
- Симптом: bare Anthropic-id (`claude-fable-5`/`claude-sonnet-5`, `provider=anthropic`) → усі кейси Error, метрики/cost «—», Degraded. haiku на тому ж ключі — Clean.
- Фікс (код, shared adapter): не слати `temperature` для моделей, що його відхиляють — найробустніше **retry без `temperature` при 400 з «temperature»** (обидва методи), без хардкод-списку моделей. Обхід без коду: лишити робочі моделі (haiku / gpt-5 / gemini-2.5-flash / deepseek).
- Побічно: `claude-sonnet-5`/`claude-fable-5` відсутні в `server/src/adapters/llm/pricing.ts` `PRICING` → COST=«—» навіть за успішного прогону (додати ціни + синк із backfill-міграцією за конвенцією файлу).
