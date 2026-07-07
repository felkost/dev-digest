# Agent Eval Dashboard — handoff для нової сесії (2026-07-07)

> **Призначення:** відкрий цей файл у новому вікні контексту, щоб почати повний SDD-цикл
> (спека → план → імплементація → тестування → рефакторинг) для НОВОЇ фічі нижче.
> Спеки ще НЕ існує — це не resume, а старт з нуля. **Наступний крок: spec-creator.**

---

## TL;DR стану

- **Спека ❌** — не існує. Є лише одноречове формулювання від користувача (нижче) + зібраний
  контекст цієї сесії, щоб spec-creator не передослідив те, що вже відомо.
- **План ❌ / Імплементація ❌ / Тести ❌** — усе попереду.
- Гілка: `feat/lesson_06`. **Робоче дерево НЕ чисте** — див. розділ «Стан git» нижче.

## Формулювання задачі (дослівно від користувача)

> Створіть окрему сторінку в лівому сайдбарі — Eval Dashboard для агентів. Покажіть останні
> evals, які були запущені.

Це **одноречовий запит**, не формальна спека. spec-creator має розкрити деталі через свої 6
категорій питань (Ukrainian, ітеративно) — але нижче вже зібрано конкретний технічний контекст
цього репо, який спека-творець інакше мусив би передослідити.

## Прочитай ПЕРШИМИ

1. Цей файл (самодостатній).
2. `client/insights.md` — рядок із **2026-07-03 [Mistake]** (цитата й пояснення нижче — критично).
3. `client/src/vendor/ui/nav.ts` — конфіг сайдбару, куди додається новий пункт.
4. `server/src/modules/eval/routes.ts` — існуючий (per-agent, НЕ workspace-wide) batch-history роут.

## КЛЮЧОВИЙ КОНТЕКСТ (зібрано цієї сесії — НЕ передосліджувати)

### 1. Структура сайдбару — де і як додається нова сторінка

- Пункти меню визначені в `client/src/vendor/ui/nav.ts`, масив `NAV: NavGroup[]` — дві секції:
  `"WORKSPACE"` (Pull Requests, Onboarding Tour, Project Context) і `"SKILLS LAB"` (Skills, Agents,
  Conventions). Новий пункт «Eval Dashboard» найприродніше лягає в `"SKILLS LAB"` поруч з `agents`,
  або власною секцією — вирішує спека.
- Кожен `NavItemDef` = `{ key, label, icon, href, gKey? }`. `gKey` реєструє `g`+клавіша шорткат
  (див. `SHORTCUTS` масив там само — `g a` → Agents, `g s` → Skills; новий пункт має свій, напр.
  `g e`, і відповідний рядок у `SHORTCUTS`).
- Рендериться в `client/src/vendor/ui/shell/Sidebar.tsx` (мапить `NAV` → `NavItem`), сторінка сама —
  звичайний Next.js App Router route під `client/src/app/<route>/page.tsx`.

### 2. КРИТИЧНИЙ ПРЕЦЕДЕНТ-БАГ (не повторити!)

`client/insights.md`, запис **2026-07-03 [Mistake]** (дослівно):

> `docs/plans/2026-07-02-project-context-folder.md` Step 1 said "leave `vendor/ui/nav.ts`
> untouched — Step 7 populates the page these keys point at," but Step 7's own file list never
> included `nav.ts`, so no step ever added a `context` entry to `NAV`. The page shipped but was
> **unreachable from the sidebar** (no nav item)... When a plan step defers adding a nav/route/UI
> entry to "a later step," grep that later step's own `Owned paths` list to confirm the deferred
> file is actually named there — do not trust the cross-reference prose alone.

**Наслідок для нового плану:** implementation-planner МАЄ призначити один крок, чиї **Owned paths**
явно містять `client/src/vendor/ui/nav.ts` (не «буде додано пізніше» прозою — реальний файл у
списку власності кроку). Це вже раз ламало саме такий тип фічі (нова сторінка + пункт сайдбару).

### 3. Немає workspace-wide/cross-agent джерела даних — відкрите архітектурне питання

- `GET /agents/:id/evals/batches` (`server/src/modules/eval/routes.ts:130`) — історія батчів **лише
  для ОДНОГО агента**. Кросагентного «усі останні evals по всіх агентах» роуту **не існує**.
- «Eval Dashboard... покажіть останні evals» майже напевно означає **кросагентний** зріз (інакше
  це просто наявна вкладка Evals в Agent Editor). Це відкрите питання для spec-creator: чи
  потрібен НОВИЙ агрегувальний серверний роут (напр. `GET /evals/recent?limit=N`, workspace-scoped,
  `JOIN agents` + `ORDER BY ran_at DESC`), чи дашборд просто мерджить N per-agent запитів
  клієнтськи (гірше — N+1, але без серверних змін).
- Для довідки: аналогічний Non-goal вже explicitly відкладався для skill-eval (`docs/plans/
  2026-07-06-skill-eval-pipeline.md:536`: *"A workspace-wide dashboard aggregating every skill's
  evals."*) — тобто це не вперше зринає ідея, і раніше свідомо відкладалась. Тепер прямий запит.

### 4. Готові до перевикористання компоненти (agent-eval, саме цієї сесії доопрацьовані)

Усі в `client/src/app/agents/[id]/_components/AgentEditor/_components/EvalsTab/_components/`:
- `EvalMetrics` — KPI-смуга (recall/precision/citation-accuracy) з семантичними кольорами.
- `TrendChart` — Recharts `LineChart` (вендорований `@devdigest/ui`, `charts/LineChart.tsx`),
  щойно отримав **hover-тултіп** з моделлю/версією/вартістю (`renderTooltip` проп) + крос-підсвітку
  з `BatchHistoryTable`.
- `BatchHistoryTable` — таблиця батчів, чекбокс-виділення (лише `full`-kind), inline drill-down,
  inline `BatchCompare` при 2 виділених.
- `KpiDeltaStrip` — компактна Δ-смужка проти попереднього батча.
- `CaseEditor` — щойно отримав живий DiffView-прев'ю (`@/components/diff-viewer`).

**Дашборд «останні evals» найімовірніше — це `BatchHistoryTable`-подібний рядковий вигляд, але
крос-агентний** (потрібна додаткова колонка «Agent», інакше візуально й функціонально майже той
самий компонент). Не хардкодити з нуля — переюзати паттерн.

### 5. Інші релевантні insights (file:line, не переказ)

- `client/insights.md` **2026-07-05 [Pattern]** — `@devdigest/ui` вже вендорить Recharts-based
  `LineChart` (`charts/LineChart.tsx`) — не хендролити SVG-графік з нуля, спершу грепнути барель.
- `client/insights.md` **2026-07-06 [Mistake]** — кастомний `SelectInput`, обгорнутий у сирий
  `<label>`, самовибирає `option[0]` на одному кліку (React синхронно флашить click-стан) —
  релевантно, якщо дашборд матиме фільтр-дропдаун (напр. «фільтрувати по агенту»).
- `server/insights.md` **2026-07-06 [Quirk]** — заморожений `@devdigest/shared`-контракт з
  non-nullable числовим полем (як `EvalBatchCompareResult.deltas.recall: z.number()`) конфліктує з
  «null-aware, не фабрикувати дельту» — рішення: відфільтрувати проблемні записи ДО серіалізації,
  не повертати `null` у non-nullable полі. Релевантно, якщо новий dashboard DTO перевикористовує/
  розширює `EvalBatch`-подібні контракти.

## Стан git (важливо для нової сесії)

Робоче дерево **НЕ чисте** — 37 змінених/нових шляхів від щойно завершеної фічі **Skill Eval
Pipeline** (повна імплементація + виправлення code-review + порт trend/compare/clear-history +
Stryker mutation-testing setup + CI-звітність). Усе це **не стосується** Eval Dashboard і не мало б
змішуватись у diff з новою роботою.

**Рекомендація:** закомітити (чи хоча б чітко зафіксувати межу) поточний стан ПЕРЕД стартом нової
фічі — інакше `git diff` нової роботи буде засмічений 37 непов'язаними файлами. Комітить лише
користувач (див. Правила нижче) — коротке резюме для коміту підготовлено окремо в цій же відповіді.

## Правила (перенесено з поточної сесії — не переграти)

- Коміт/push — **лише користувач**; давати англомовні commit-меседжі, не комітити самому.
- Не запускати dev-сервери самому (`:3001`/`:3000` — користувача); попереджати перед рестартами.
- Питання користувачу — **українською**; артефакти (спека/план/код) — англійською.
- SDD-процес виконується вручну по кроках: **spec-creator → implementation-planner → /implement**
  (кожен запускається окремо, не автоматично один за одним).
- `client/insights.md`/`server/insights.md` — перевіряти НА ПОЧАТКУ роботи над модулем (вже
  зроблено для цього хендофу; повторно звірити, якщо контекст цієї сесії застаріє).

## Наступна дія

Запусти **spec-creator** з формулюванням задачі вище + контекстом розділів 1–5. Очікувані відкриті
питання, які spec-creator має явно поставити користувеві:
1. Кросагентний зріз (усі агенти workspace) чи щось вужче?
2. Скільки «останніх evals» показувати (N=10? 20? з пагінацією чи без)?
3. Чи потрібен новий серверний агрегувальний роут, чи прийнятний client-side мердж?
4. Live-оновлення (polling) чи статичний знімок при заході на сторінку?
5. Чи потрібен фільтр/пошук по агенту, чи просто хронологічний список?
