# Free Subdomains

Get a **free custom subdomain** on one of our domains — for your website,
project, portfolio, blog or homelab. Everything is managed through GitHub: you
open a pull request, an automated bot checks it, a maintainer merges, and your
DNS records go live.

No account, no payment, no dashboard. Just one small JSON file.

---

## Get a subdomain in 4 steps

### 1. Pick a domain

Look in the [`domains/`](./domains) folder — **each folder is a domain you can
use**. Currently available:

| Domain | Example |
| --- | --- |
| `addictedto.beer` | `myname.addictedto.beer` |
| `skillissue.gg` | `myname.skillissue.gg` |

For example, the folder `domains/addictedto.beer/` means you can register
`anything.addictedto.beer`.

### 2. Add your folder

[Fork this repo](../../fork) and create a **folder for your subdomain**, with an
`@.json` file inside it:

```
domains/<domain>/<your-subdomain>/@.json
```

Example — to register **`myname.addictedto.beer`**, create
`domains/addictedto.beer/myname/@.json`:

```json
{
  "owner": {
    "github": "your-github-username"
  },
  "records": {
    "CNAME": "your-github-username.github.io"
  }
}
```

> Note: The folder name becomes your subdomain, and `@.json` is the entry for the
> subdomain itself (`@` is DNS shorthand for "this name"). The `owner.github`
> field **must be your own GitHub username** — that's what lets you (and only
> you) edit it later.
>
> Folders named `@` or `*` are **rejected** (the apex of the main domain and
> wildcards are reserved).

**Want nested subdomains?** Add more files in the same folder. For example,
`domains/addictedto.beer/myname/blog.json` creates `blog.myname.addictedto.beer`.
The `@.json` always defines who owns the whole folder.

### 3. Open a pull request

Open a PR with your new file. Within a minute the **validation bot** will comment:

- **All checks passed** → a maintainer reviews and merges.
- **Changes requested** → fix the listed issues and push again; it re-checks
  automatically.
- **Ownership check failed** → you tried to change someone else's subdomain,
  so the PR is closed automatically.

### 4. Done

Once merged, your DNS records go live. Point your service (GitHub Pages, Vercel,
Netlify, a server IP, …) at it and you're online.

---

## File format

```jsonc
{
  // Required — this is what proves ownership.
  "owner": {
    "github": "your-github-username",   // required
    "email": "you@example.com"          // optional
  },

  // Optional, just for humans.
  "description": "My personal website",

  // Required — at least one DNS record.
  "records": {
    "A": ["185.199.108.153"],           // one or more IPv4 addresses
    "AAAA": ["2606:50c0:8000::153"],    // one or more IPv6 addresses
    "CNAME": "target.example.net",      // a single hostname (no other records!)
    "TXT": ["hello world"],             // one or more text values
    "MX": ["10 mail.example.net"]       // mail servers
  }
}
```

**Rules**

| Rule | Why |
| --- | --- |
| Path is `domains/<domain>/<subdomain>/@.json` | Folder = subdomain, `@.json` = the subdomain itself |
| Folder name is lowercase `a-z 0-9 -` | Valid DNS label |
| Folders named `@` or `*` are rejected | Apex and wildcards are reserved |
| `@.json` must contain an `owner.github` | Anchors who owns the folder |
| At least one record under `records` | A subdomain has to point somewhere |
| `CNAME` cannot be combined with other record types | DNS spec |
| Every value is a plain string in the right format (`A` = IPv4, `AAAA` = IPv6, `CNAME` = one hostname, `MX` = `10 mail.example.net`, `TXT` without quotes) | Broken values would make the whole zone fail to deploy |
| A record on another name (e.g. `_railway-verify`) goes in its own file `<subdomain>/_railway-verify.json` | One file = one DNS name |
| Names like `www`, `api`, `mail`, `ns1` … are reserved | Infrastructure protection |

---

## How approval & ownership works

This is fully automated by the workflow in
[`.github/workflows/pr-check.yml`](./.github/workflows/pr-check.yml):

1. **Scope** — a PR may only touch files inside `domains/`. Anything else fails.
2. **Availability** — registering a name that already exists is rejected (the
   existing file already occupies that subdomain).
3. **Validation** — the JSON structure, subdomain name and record types are
   checked.
4. **Ownership** — when a PR **edits or deletes an existing** subdomain, the PR
   author must match the `owner.github` in that folder's `@.json` on `main`.
   - You own it → allowed to edit / delete.
   - You don't → the PR is **closed automatically** with an explanation.
5. A maintainer does the final merge for new entries.

So: **first come, first served**, and only the original creator can later change
their own subdomain.

---

## Editing or removing your subdomain

- **Edit:** open a PR changing files in your `domains/<domain>/<subdomain>/` folder.
  As long as the folder's `@.json` lists you as `owner.github`, it's accepted.
- **Remove:** open a PR deleting your folder (or individual files in it).

---

## FAQ

**Can I grab someone else's subdomain?** No. Editing a file you don't own gets
your PR closed automatically.

**Can I have more than one?** Yes — one file per subdomain.

**Is it really free?** Yes. Abuse (phishing, malware, illegal content) gets the
subdomain removed.

**Which domains can I use?** Whatever folders exist under
[`domains/`](./domains).

---

## For maintainers

- **Add a domain:** create a folder `domains/<the-domain>/` (see
  [`domains/README.md`](./domains/README.md)).
- **Validation logic** lives in
  [`.github/scripts/validate-pr.js`](./.github/scripts/validate-pr.js).

---

## License

[MIT](./LICENSE)
