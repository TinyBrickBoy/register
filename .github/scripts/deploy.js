const fs = require("fs");
const path = require("path");

const API_URL = process.env.SKRIME_API_URL;
const API_KEY = process.env.SKRIME_API_KEY;
const PRODUCTS_RAW = process.env.SKRIME_PRODUCTS;

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

      const data = JSON.parse(fs.readFileSync(path.join(subDir, file), "utf8"));
      const recs = data.records || {};
      for (const [type, value] of Object.entries(recs)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (typeof v !== "string" && typeof v !== "number") {
            throw new Error(`${domain}: ${sub}/${file} ${type} value must be a string, got ${JSON.stringify(v)}`);
          }
          records.push({ name, type, data: String(v) });
        }
      }
    }
  }
  return records;
}

const MAX_ATTEMPTS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep logs readable: Cloudflare error pages are full HTML documents.
function summarize(text) {
  const title = text.match(/<title>([^<]*)<\/title>/i);
  if (title) return title[1].trim();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

async function deployZone(domain, productId) {
  // Throws on malformed files, so a broken zone is never pushed.
  const records = collectRecords(domain);
  const body = JSON.stringify({ productId, records });

  for (let attempt = 1; ; attempt++) {
    let res, text;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body,
      });
      text = await res.text();
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`${domain}: ${e.message}`);
      console.log(`[retry] ${domain}: ${e.message} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(5000 * 2 ** (attempt - 1));
      continue;
    }

    if (res.ok) {
      console.log(`[ok]   ${domain}: pushed ${records.length} record(s) (HTTP ${res.status})`);
      return;
    }

    // 5xx and 429 are usually temporary (e.g. skrime.eu behind Cloudflare
    // returning 502 while the origin restarts), so try again with backoff.
    const retryable = res.status >= 500 || res.status === 429;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new Error(`${domain}: HTTP ${res.status} ${summarize(text)}`);
    }
    console.log(`[retry] ${domain}: HTTP ${res.status} ${summarize(text)} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await sleep(5000 * 2 ** (attempt - 1));
  }
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
