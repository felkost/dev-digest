# Test Coverage Rubric

Evaluate for gaps in test coverage.

## Required checks

- **Branch coverage**: Every if/else, switch branch, early return, or ternary introduced must have at least one test for each outcome.
- **Error paths**: Every catch block or error-fallback introduced must be exercised.
- **Negative cases**: If a function validates input or can throw/return null, there must be a test for the invalid/null input.

## Reporting rule

Report only branches introduced in THIS diff that have no matching test case.