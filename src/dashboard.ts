// Dashboard: the state machine, visible. P0 = functional. P3 = pretty.

import { getDashboardData } from "./db";

// The ingest endpoint is open by design, so every payload-derived string
// (title/page/action flow into scoring reasons) is hostile until escaped.
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function renderDashboard(env: Env, origin: string): Promise<Response> {
  const data = await getDashboardData(env.DB);

  const rows = data.recent
    .map(
      (s) => `<tr>
        <td>${s.id}</td>
        <td><code>${esc(s.trace_id.slice(0, 8))}</code></td>
        <td>${esc(s.source)}</td>
        <td class="st-${s.status}">${s.status}</td>
        <td>${s.fit_score ?? "—"}</td>
        <td>${s.intent_score ?? "—"}</td>
        <td>${esc(s.scored_by ?? "—")}</td>
        <td>${s.reap_count > 0 ? `♻️ ${s.reap_count}` : ""}</td>
      </tr>`,
    )
    .join("");

  const actionRows = data.actions
    .map(
      (a) => `<tr>
        <td>${a.signal_id}</td>
        <td class="tier-${a.tier}">${a.tier}</td>
        <td>${esc(a.action)}</td>
        <td class="reason">${esc(a.reason)}</td>
      </tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GTM Signal Pipeline — live on Cloudflare Workers + D1 + Queues</title>
<style>
  :root { color-scheme: light; }
  body { font-family: ui-monospace, 'SF Mono', Menlo, monospace; margin: 2rem auto; max-width: 1080px; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 2rem; }
  .counts { display: flex; gap: 1rem; margin: 1rem 0; }
  .count { border: 1px solid #ddd; border-radius: 6px; padding: .6rem 1rem; }
  .count b { font-size: 1.4rem; display: block; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #eee; }
  .st-pending { color: #b58900; } .st-in_flight { color: #268bd2; }
  .st-routed { color: #859900; } .st-failed { color: #dc322f; }
  .tier-hot { color: #dc322f; font-weight: bold; } .tier-warm { color: #b58900; } .tier-archive { color: #93a1a1; }
  .reason { max-width: 480px; color: #555; }
  footer { margin-top: 3rem; font-size: .8rem; color: #888; }
</style>
</head>
<body>
<h1>GTM Signal Pipeline</h1>
<p>Inbox-first ingest → atomic claim → fit×intent scoring → routed with reasons. Reapers sweep every 5 min. Running on Workers + D1 + Queues.</p>
<details>
<summary>Fire a test signal</summary>
<pre>curl -X POST ${origin}/signal \\
  -H "content-type: application/json" \\
  -d '{"source":"form_fill","company":"Acme","domain":"acme.com","title":"VP of IT","employee_count":900,"page":"/pricing","action":"demo_request"}'</pre>
<p>Watch it walk pending → in_flight → routed below. Identical payloads dedup (409). Junk signals route to archive with the reason spelled out.</p>
</details>
<div class="counts">
  <div class="count"><b>${data.counts["pending"] ?? 0}</b> pending</div>
  <div class="count"><b>${data.counts["in_flight"] ?? 0}</b> in flight</div>
  <div class="count"><b>${data.counts["routed"] ?? 0}</b> routed</div>
  <div class="count"><b>${data.counts["failed"] ?? 0}</b> failed</div>
  <div class="count"><b>${data.reaped}</b> reaper rescues</div>
</div>
<h2>Signals (latest 25)</h2>
<table>
<tr><th>id</th><th>trace</th><th>source</th><th>status</th><th>fit</th><th>intent</th><th>scored by</th><th>reaped</th></tr>
${rows || "<tr><td colspan=8>no signals yet — POST /signal to begin</td></tr>"}
</table>
<h2>Routed actions (latest 25)</h2>
<table>
<tr><th>signal</th><th>tier</th><th>action</th><th>reason</th></tr>
${actionRows || "<tr><td colspan=4>none yet</td></tr>"}
</table>
<footer>
  The queue is a notifier. The database is the source of truth.
  <a href="https://github.com/shanefirek/gtm-signal-pipeline">patterns writeup + source</a> · <a href="https://github.com/shanefirek">github.com/shanefirek</a>
</footer>
<script>
  // The 5s auto-refresh resets <details> to closed — persist its state across reloads.
  const d = document.querySelector("details");
  if (sessionStorage.getItem("curl-open") === "1") d.open = true;
  d.addEventListener("toggle", () => sessionStorage.setItem("curl-open", d.open ? "1" : "0"));
  setTimeout(() => location.reload(), 5000);
</script>
</body>
</html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
