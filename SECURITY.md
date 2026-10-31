# Security policy

## Report a vulnerability

Report a vulnerability privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability** ([direct link](https://github.com/ZarK/memex.core/security/advisories/new)). Only the maintainer sees the report.

Do not open a public issue, pull request, or discussion for a vulnerability.

Include:

- the package and version, or the commit;
- what an attacker can do, and what they need first (for example local access, or a crafted file);
- the steps or a small test case that shows it.

Do not attach personal files, real photos, real messages, or other private data. Make a test case from synthetic or public files instead.

## What to expect

- An answer to the report within 7 days.
- A fix, or a plan with a date, within 30 days for a confirmed vulnerability.
- A GitHub security advisory when the fix is released, with credit if you want it.

## Supported versions

Security fixes go into the newest released version of each `@tjalve/memex-*` package. Older versions get no fixes; update to the newest version.

## Scope

In scope: the packages, contracts, schemas, and scripts in this repository. Examples: a path that escapes the folder it must stay in, a token or private file that becomes readable to another account, and a crafted archive, pack, or import file that writes outside its target.

Out of scope: the Memex apps, which have their own repositories and policies, and problems in third-party dependencies that have no effect on these packages (report those upstream).
