// Validates a subdomain registration pull request.
//
// It is executed from `.github/workflows/pr-check.yml` via actions/github-script.
// The script NEVER checks out or runs code from the pull request. It only reads
// the changed JSON files through the GitHub API, so it is safe to run with a
// write-enabled token (pull_request_target).
//
// Layout:
//   domains/<domain>/<subdomain>/@.json        -> records for <subdomain>.<domain>
//   domains/<domain>/<subdomain>/<label>.json  -> records for <label>.<subdomain>.<domain>
//
// Each subdomain folder is owned by the `owner.github` declared in its `@.json`.
//
// Responsibilities:
//   1. Make sure a PR only touches files under `domains/`.
//   2. Reject subdomain folders named `@` (apex) or `*` (wildcard).
//   3. Validate the structure of every added/modified file.
//   4. Make sure the requested subdomain lives under an allowed domain folder.
//   5. Reject reserved / malformed names.
//   6. Ownership: when a PR edits or deletes files in an EXISTING subdomain
//      folder, the PR author must be the owner recorded in that folder's
//      `@.json` on the base branch. If not, the PR is closed automatically.

const MARKER = "<!-- subdomain-bot -->";

const ALLOWED_RECORD_TYPES = ["A", "AAAA", "CNAME", "ALIAS", "MX", "SRV", "TXT", "CAA"];

// Names nobody is allowed to register (infrastructure / abuse prevention).
const RESERVED = new Set([
  "www", "ns", "ns1", "ns2", "mail", "email", "smtp", "imap", "pop", "webmail",
  "admin", "root", "api", "cdn", "ftp", "dns", "mx", "registry", "register",
  "_acme-challenge", "_dmarc", "autodiscover", "autoconfig", "localhost",
]);

module.exports = async function validate({ github, context, core }) {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  const prNumber = pr.number;
  const author = pr.user.login;
  const baseRef = pr.base.sha;
  const headRef = pr.head.sha;

  const errors = [];      // hard validation problems (PR stays open, author fixes)
  const violations = [];  // ownership problems (PR gets closed)
  const ok = [];          // human-readable summary of accepted changes

  // ---- which domains exist? (folders under domains/ on the base branch) ----
  const allowedDomains = await listDomains(github, owner, repo, baseRef);

  // ---- which files did the PR change? ----
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });

  if (files.length === 0) {
    errors.push("This pull request does not change any files.");
  }

  for (const file of files) {
    const path = file.filename;
    const parts = path.split("/");
    const base = parts[parts.length - 1];

    // 1) Only files inside domains/ are allowed.
    if (parts[0] !== "domains") {
      errors.push(`\`${path}\` is outside \`domains/\`. PRs may only add or edit files in \`domains/<domain>/<subdomain>/\`.`);
      continue;
    }

    // Maintainer placeholders for empty domain folders – ignore.
    if (base === ".gitkeep") continue;

    // 2) Path must be domains/<domain>/<subdomain>/<record>.json
    if (parts.length !== 4 || !base.endsWith(".json")) {
      errors.push(`\`${path}\` has the wrong shape. Use \`domains/<domain>/<subdomain>/@.json\`.`);
      continue;
    }
    const domain = parts[1];
    const sub = parts[2];
    const label = base.replace(/\.json$/, "");
    const isApex = label === "@";
    const fqdn = isApex ? `${sub}.${domain}` : `${label}.${sub}.${domain}`;

    // 3) Domain must be one we host.
    if (!allowedDomains.includes(domain)) {
      errors.push(`Domain \`${domain}\` is not available. Available domains: ${allowedDomains.map((d) => `\`${d}\``).join(", ") || "(none configured yet)"}.`);
      continue;
    }

    // 4) The subdomain folder may not be the apex or a wildcard.
    if (sub === "@" || sub === "*") {
      errors.push(`\`${domain}\`: a subdomain folder may not be named \`@\` or \`*\` (apex and wildcard are reserved).`);
      continue;
    }

    // 5) Validate the folder name (and the record label, unless it is the apex).
    const nameErrors = validateName(sub);
    // Record labels may start with "_" (e.g. `_railway-verify` for TXT verification).
    if (!isApex) nameErrors.push(...validateName(label.replace(/^_/, "")));
    if (nameErrors.length) {
      errors.push(...nameErrors.map((e) => `\`${fqdn}\`: ${e}`));
      continue;
    }

    // ---- ownership is anchored by the folder's @.json on the base branch ----
    const anchorPath = `domains/${domain}/${sub}/@.json`;
    const anchorBase = await getJson(github, owner, repo, anchorPath, baseRef);

    if (file.status === "removed") {
      if (anchorBase && !isOwner(anchorBase, author)) {
        violations.push(`\`${sub}.${domain}\` is owned by @${anchorBase?.owner?.github}, so @${author} cannot remove records from it.`);
      } else if (anchorBase || isApex) {
        ok.push(`Removing \`${fqdn}\` (owned by @${author}).`);
      }
      continue;
    }

    // added / modified / renamed -> read the new content from the PR head.
    const proposed = await getJson(github, owner, repo, path, headRef);
    if (proposed === null) {
      errors.push(`\`${path}\` is not valid JSON.`);
      continue;
    }

    if (anchorBase) {
      // The subdomain already exists -> only its owner may change it.
      if (!isOwner(anchorBase, author)) {
        violations.push(`\`${sub}.${domain}\` already belongs to @${anchorBase?.owner?.github}. @${author} is not allowed to change it.`);
        continue;
      }
    } else {
      // Brand new subdomain -> it must be established by an @.json with an owner.
      const anchorHead = isApex ? proposed : await getJson(github, owner, repo, anchorPath, headRef);
      if (!anchorHead || !anchorHead.owner || !anchorHead.owner.github) {
        errors.push(`\`${sub}.${domain}\`: a new subdomain must include an \`@.json\` with an \`owner.github\` before adding \`${base}\`.`);
        continue;
      }
    }

    // 6) Structural validation of the file content.
    const contentErrors = validateContent(proposed, isApex);
    if (contentErrors.length) {
      errors.push(...contentErrors.map((e) => `\`${fqdn}\`: ${e}`));
      continue;
    }

    ok.push(anchorBase
      ? `Updating \`${fqdn}\` (owned by @${author}).`
      : `Registering \`${fqdn}\` for @${author}.`);
  }

  // ---------------------------- act on the result ----------------------------
  if (violations.length) {
    const body = [
      MARKER,
      "## Ownership check failed",
      "",
      "This pull request changes a subdomain that belongs to someone else, so it is being closed automatically.",
      "",
      ...violations.map((v) => `- ${v}`),
      "",
      "If you believe this is a mistake, please open an issue.",
    ].join("\n");

    await upsertComment(github, owner, repo, prNumber, body);
    await setLabels(github, owner, repo, prNumber, ["ownership-violation"]);
    await github.rest.pulls.update({ owner, repo, pull_number: prNumber, state: "closed" });
    core.setFailed("Ownership violation - pull request closed.");
    return;
  }

  if (errors.length) {
    const body = [
      MARKER,
      "## Changes requested",
      "",
      "Thanks for your submission! A few things need fixing before this can be merged:",
      "",
      ...errors.map((e) => `- ${e}`),
      "",
      "Push a new commit to this pull request and I'll re-check automatically.",
    ].join("\n");

    await upsertComment(github, owner, repo, prNumber, body);
    await setLabels(github, owner, repo, prNumber, ["invalid"]);
    core.setFailed(`${errors.length} validation error(s).`);
    return;
  }

  const body = [
    MARKER,
    "## All checks passed",
    "",
    ...ok.map((o) => `- ${o}`),
    "",
    "A maintainer will review and merge shortly. Once merged, your DNS records go live.",
  ].join("\n");

  await upsertComment(github, owner, repo, prNumber, body);
  await setLabels(github, owner, repo, prNumber, ["validated"]);
};

// ------------------------------- helpers -----------------------------------

function isOwner(record, author) {
  const gh = record?.owner?.github;
  return typeof gh === "string" && gh.toLowerCase() === author.toLowerCase();
}

function validateName(name) {
  const errors = [];
  if (name !== name.toLowerCase()) errors.push("name must be lowercase");
  if (name.length === 0 || name.length > 63) errors.push("name length is out of range (1-63)");
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(`\`${name}\` may only contain a-z, 0-9 and hyphens`);
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push(`\`${name}\` must not start or end with a hyphen`);
  }
  if (RESERVED.has(name)) errors.push(`\`${name}\` is reserved`);
  return errors;
}

function validateContent(data, isApex) {
  const errors = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return ["file must contain a single JSON object"];
  }

  // owner is required in the apex file (it anchors ownership of the folder).
  if (isApex) {
    if (!data.owner || typeof data.owner !== "object" || Array.isArray(data.owner)) {
      errors.push("`owner` object is required in `@.json`");
    } else if (typeof data.owner.github !== "string" || data.owner.github.trim() === "") {
      errors.push("`owner.github` (your GitHub username) is required in `@.json`");
    }
  }

  // records
  if (!data.records || typeof data.records !== "object" || Array.isArray(data.records)) {
    errors.push("`records` object with at least one DNS record is required");
    return errors;
  }
  const types = Object.keys(data.records);
  if (types.length === 0) errors.push("`records` must contain at least one record");

  for (const t of types) {
    if (!ALLOWED_RECORD_TYPES.includes(t)) {
      errors.push(`unsupported record type \`${t}\` (allowed: ${ALLOWED_RECORD_TYPES.join(", ")})`);
    }
  }
  for (const [t, value] of Object.entries(data.records)) {
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.some((v) => typeof v !== "string" || v.trim() === "")) {
      errors.push(`\`${t}\` must be a string or a list of strings (for a record on another name like \`_verify\`, add a separate \`_verify.json\` file)`);
    }
  }
  if (types.includes("CNAME") && types.length > 1) {
    errors.push("a `CNAME` record cannot be combined with other record types");
  }
  if (types.includes("NS") && types.some((t) => t !== "NS")) {
    errors.push("`NS` records cannot be combined with other record types");
  }
  return errors;
}

async function listDomains(github, owner, repo, ref) {
  try {
    const res = await github.rest.repos.getContent({ owner, repo, path: "domains", ref });
    if (!Array.isArray(res.data)) return [];
    return res.data.filter((e) => e.type === "dir").map((e) => e.name);
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

async function getJson(github, owner, repo, path, ref) {
  try {
    const res = await github.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(res.data) || !res.data.content) return null;
    const raw = Buffer.from(res.data.content, "base64").toString("utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.status === 404) return null; // file does not exist on this ref
    return null; // unparseable JSON
  }
}

async function upsertComment(github, owner, repo, issue_number, body) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number, per_page: 100,
  });
  const mine = comments.find((c) => c.body && c.body.includes(MARKER));
  if (mine) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number, body });
  }
}

async function setLabels(github, owner, repo, issue_number, labels) {
  const managed = ["validated", "invalid", "ownership-violation"];
  try {
    const current = await github.paginate(github.rest.issues.listLabelsOnIssue, {
      owner, repo, issue_number, per_page: 100,
    });
    for (const l of current) {
      if (managed.includes(l.name) && !labels.includes(l.name)) {
        await github.rest.issues.removeLabel({ owner, repo, issue_number, name: l.name }).catch(() => {});
      }
    }
  } catch (e) { /* ignore */ }
  await github.rest.issues.addLabels({ owner, repo, issue_number, labels }).catch(() => {});
}
