# No Mock Overuse

Flag tests that rely on mocking in ways that make them trivially pass.

## Antipatterns to flag

1. **Mocking the system under test** - the test mocks the very function it is testing.
2. **Mock always returns success** - configured to return { ok: true } regardless of input.
3. **Mocking DB in integration tests** - integration tests must hit a real database.
4. **Implementation-detail mock** - mocking a private method or internal state.

## Reporting rule

Flag each occurrence with the specific antipattern.