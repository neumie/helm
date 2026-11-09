# Fix: company create loses the firm on save

The ARES lookup returns `undefined` for companies that changed their legal form,
and `saveFirm` dereferences `ares.ico` before checking it.

## What happens today

1. The user types an IČO and picks the company from the suggestion list.
2. `createCompany` calls ARES, then `saveFirm(ares, input)`.
3. ARES answers **404** for a dissolved legal form, so `ares` is `undefined`.
4. `saveFirm` throws `TypeError` and the form shows a generic error.

## Proposed change

- Treat a missing ARES record as *unverified*, not as an error.
- Keep the IČO the user typed; mark the company `verification: 'pending'`.
- Re-check pending companies nightly.

| Case | Today | After |
| --- | --- | --- |
| ARES found | saved | saved |
| ARES 404 | 500 error | saved, pending |
| ARES timeout | 500 error | saved, pending, retried |

```ts
const ares = await lookupAres(input.ico).catch(() => undefined)
return saveFirm({ ...input, verification: ares ? 'verified' : 'pending' })
```

## Open questions

- Should a pending company be invoiceable?
- Who gets notified when the nightly check fails twice?
