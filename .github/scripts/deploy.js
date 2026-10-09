const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { validateContent } = require("./validate-pr.js");

const API_URL = process.env.SKRIME_API_URL;
const API_KEY = process.env.SKRIME_API_KEY;
const PRODUCTS_RAW = process.env.SKRIME_PRODUCTS;
// DRY_RUN=1 fetches the live zones and prints what would be pushed.
const DRY_RUN = process.env.DRY_RUN === "1";

const root = process.cwd();
const domainsDir = path.join(root, "domains");

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (!API_URL) fail("SKRIME_API_URL secret is not set.");
if (!API_KEY) fail("SKRIME_API_KEY secret is not set.");
if (!PRODUCTS_RAW) fail("SKRIME_PRODUCTS secret is not set.");

let products;
try {
  products = JSON.parse(PRODUCTS_RAW);
} catch (e) {
  fail(`SKRIME_PRODUCTS secret is not valid JSON: ${e.message}`);
}

const domains = fs
  .readdirSync(domainsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

function collectRecords(domain) {
  const records = [];
  const domainDir = path.join(domainsDir, domain);
  if (!fs.existsSync(domainDir)) return records;

  for (const sub of fs.readdirSync(domainDir)) {
    const subDir = path.join(domainDir, sub);
    if (!fs.statSync(subDir).isDirectory()) continue;

    for (const file of fs.readdirSync(subDir)) {
      if (!file.endsWith(".json")) continue;
      const label = file.replace(/\.json$/, "");
      const name = label === "@" ? sub : `${label}.${sub}`;

      const where = `${domain}: ${sub}/${file}`;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(subDir, file), "utf8"));
      } catch (e) {
        throw new Error(`${where} is not valid JSON: ${e.message}`);
      }
      const problems = validateContent(data, label === "@");
      if (problems.length) throw new Error(`${where}: ${problems.join("; ")}`);

      const recs = data.records || {};
      for (const [type, value] of Object.entries(recs)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          records.push({ name, type, data: v });
        }
      }
    }
  }
  return records;
}

// Every subdomain folder that exists or ever existed in git history. Records
// under these names are owned by the repo, so a deleted folder also removes
// its records from the live zone.
function managedSubdomains(domain) {
  const subs = new Set(
    fs
      .readdirSync(path.join(domainsDir, domain), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name.toLowerCase()),
  );
  const out = execFileSync(
    "git",
    ["log", "--format=", "--name-only", "--", `domains/${domain}/`],
    { cwd: root, encoding: "utf8" },
  );
  const prefix = `domains/${domain}/`;
  for (const line of out.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const parts = line.slice(prefix.length).split("/");
    if (parts.length > 1) subs.add(parts[0].toLowerCase());
  }
  return subs;
}

// Live names may come back fully qualified; compare them as relative names.
function relativeName(name, domain) {
  let n = String(name).toLowerCase().replace(/\.$/, "");
  if (n === domain) return "@";
  if (n.endsWith(`.${domain}`)) n = n.slice(0, -domain.length - 1);
  return n || "@";
}

// The GET returns TXT values in quotes and hostnames with a trailing dot.
// Send them back in the same form the repo files use.
function liveData(type, data) {
  let d = String(data);
  if (type === "TXT" && /^"[^"]*"$/.test(d)) return d.slice(1, -1);
  if (["CNAME", "ALIAS", "MX", "SRV", "NS", "PTR"].includes(type)) d = d.replace(/\.$/, "");
  return d;
}

const MAX_ATTEMPTS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep logs readable: Cloudflare error pages are full HTML documents.
function summarize(text) {
  const title = text.match(/<title>([^<]*)<\/title>/i);
  if (title) return title[1].trim();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

async function request(domain, method, url, body) {
  for (let attempt = 1; ; attempt++) {
    let res, text;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body,
      });
      text = await res.text();
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`${domain}: ${method} ${e.message}`);
      console.log(`[retry] ${domain}: ${method} ${e.message} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(5000 * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${domain}: ${method} returned no JSON: ${summarize(text)}`);
      }
      if (json.state && json.state !== "success") {
        throw new Error(`${domain}: ${method} ${json.state}: ${json.response || summarize(text)}`);
      }
      return { status: res.status, json };
    }

    // 5xx and 429 are usually temporary (e.g. skrime.eu behind Cloudflare
    // returning 502 while the origin restarts), so try again with backoff.
    const retryable = res.status >= 500 || res.status === 429;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`${domain}: ${method} HTTP ${res.status} ${summarize(text)}`);
    }
    console.log(`[retry] ${domain}: ${method} HTTP ${res.status} ${summarize(text)} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await sleep(5000 * 2 ** (attempt - 1));
  }
}

// The API can only fetch or replace the whole zone, so read the live records
// first and keep everything the repo does not manage (apex, www, mail, ...).
async function fetchLiveRecords(domain, productId) {
  const url = new URL(API_URL);
  url.searchParams.set("productId", productId);
  const { json } = await request(domain, "GET", url);
  const records = json.data && json.data.records;
  if (!Array.isArray(records)) {
    throw new Error(`${domain}: GET returned no records list`);
  }
  return records;
}

async function deployZone(domain, productId) {
  // Throws on malformed files, so a broken zone is never pushed.
  const repoRecords = collectRecords(domain);
  const managed = managedSubdomains(domain);
  const live = await fetchLiveRecords(domain, productId);

  const kept = [];
  for (const r of live) {
    const type = String(r.type).toUpperCase();
    const name = relativeName(r.name, domain);
    // NS and SOA of the zone itself are kept by skrime on every update.
    if (type === "SOA" || (type === "NS" && name === "@")) continue;
    if (managed.has(name.split(".").pop())) continue;
    kept.push({ name, type, data: liveData(type, r.data) });
  }

  const records = [...kept, ...repoRecords];
  if (DRY_RUN) {
    console.log(`[dry]  ${domain}: would push ${records.length} record(s)`);
    for (const r of records) console.log(`         ${r.name} ${r.type} ${r.data}`);
    return;
  }
  const body = JSON.stringify({ productId, records });
  const { status } = await request(domain, "POST", API_URL, body);
  console.log(
    `[ok]   ${domain}: pushed ${records.length} record(s), ` +
      `${repoRecords.length} from repo, ${kept.length} kept from live zone (HTTP ${status})`,
  );
}

(async () => {
  let failed = false;
  for (const domain of domains) {
    const productId = products[domain];
    if (!productId) {
      console.log(`[skip] ${domain}: no productId in SKRIME_PRODUCTS secret`);
      continue;
    }
    try {
      await deployZone(domain, productId);
    } catch (e) {
      failed = true;
      console.error(`[fail] ${e.message}`);
    }
  }
  if (failed) process.exit(1);
})();
