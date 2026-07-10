# Flaky Test Detector

Flag patterns that cause tests to pass sometimes and fail others.

## Patterns to flag

1. **Hardcoded Date.now() or new Date()** - asserts on a specific timestamp.
2. **Math.random() without seeding** - non-deterministic values in assertions.
3. **setTimeout/setInterval without fake timers** - flaky in CI.
4. **Array/object order assumptions** - asserting result[0] without ORDER BY.
5. **Shared state between tests** - missing cleanup.
6. **External network calls** - any fetch in a unit test without a stub.

## Reporting rule

Report the exact line and explain what triggers the intermittent failure.