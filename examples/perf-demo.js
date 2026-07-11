// examples/perf-demo.js
//
// INTENTIONALLY SLOW — DEMO ONLY. Standalone sample, not imported, not wired
// into any route, not executed. It exists solely to exercise the DevDigest
// Performance Reviewer in CI. Do not merge into production.

'use strict';

// N+1: one DB round-trip PER id inside a loop instead of a single batched
// inArray(...) query.
async function loadUsers(db, ids) {
  const users = [];
  for (const id of ids) {
    const rows = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    users.push(rows[0]);
  }
  return users;
}

// O(n^2): a .find() over the whole orders array for every user, instead of a
// Map lookup — quadratic as both lists grow.
function attachOrders(users, orders) {
  return users.map((u) => ({ ...u, order: orders.find((o) => o.userId === u.id) }));
}

// Blocking synchronous file read on a request path — stalls the event loop for
// every request instead of streaming / caching.
function renderTemplate(fs, req, res) {
  const tpl = fs.readFileSync('./templates/' + req.query.name + '.html', 'utf8');
  res.send(tpl);
}

// Sequential awaits for independent calls — should run with bounded concurrency
// (Promise.all / p-queue) instead of one-at-a-time.
async function fetchAll(client, urls) {
  const out = [];
  for (const url of urls) {
    out.push(await client.get(url));
  }
  return out;
}

module.exports = { loadUsers, attachOrders, renderTemplate, fetchAll };
