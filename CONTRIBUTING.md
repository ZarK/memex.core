# Contributing to memex.core

memex.core holds the shared contracts, schemas, and libraries of the Memex apps. It is MIT licensed. Contributions are welcome under the same license.

## License and sign-off

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE) of this repository.

Every commit needs a sign-off line under the [Developer Certificate of Origin 1.1](https://developercertificate.org/). The sign-off says that you wrote the change, or that you have the right to submit it under the MIT License:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it. Use your real name or the name you are known by, and an address that you want to be public. A pull request with a commit that has no sign-off cannot be merged; `git commit --amend -s` or `git rebase --signoff main` fixes it.

The Memex apps are in other repositories under the AGPL and take contributions under a contributor license agreement. That does not apply here.

## Before you open a pull request

- For a change to a contract (`contracts/`, `schemas/`, `openapi/`), open an issue first. Many apps implement the contracts, so a change needs agreement before code.
- Keep the change small and on one subject.
- Run the checks:

  ```bash
  pnpm install
  pnpm build
  pnpm typecheck
  pnpm test
  ```

- Add tests for new behavior. Test data must be synthetic or from public sources.

## Private data

Never put personal data in an issue, a pull request, a test, or a fixture: no real photos, messages, contacts, addresses, account names, host names, or paths from your own computer. Use names and addresses on reserved domains such as `example.com`, and made-up values.

## Dependencies

New dependencies need a reason in the pull request. Versions are exact, at least 14 days old, and without install scripts (see `.npmrc`). Record the license of each new dependency.

## Security

Report vulnerabilities privately, not in issues. See [SECURITY.md](SECURITY.md).
