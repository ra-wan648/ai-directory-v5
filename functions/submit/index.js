/** Server-rendered public tool submission form at /submit. */
const WORKER = 'https://ai-directory-v5-worker.radwanislam648.workers.dev';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function onRequest(context) {
  const html = `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Submit an AI tool | AI Directory</title>
<meta name="description" content="Submit an AI tool for review by the AI Directory team.">
<link rel="canonical" href="https://ai-directory-v5-radwan648.pages.dev/submit">
<link rel="stylesheet" href="/css/app.css">
<style>
.formwrap{max-width:680px;margin:0 auto;padding:32px 16px}.formwrap form{display:grid;gap:14px}.formwrap label{display:grid;gap:6px;font-size:13px;font-weight:600}.formwrap input,.formwrap textarea,.formwrap select{font:inherit;font-size:14px;padding:10px 12px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg,#fff);color:inherit}.formwrap textarea{min-height:120px;resize:vertical}.formwrap button{justify-self:start;border:0;border-radius:8px;padding:10px 16px;background:var(--fg,#111);color:var(--bg,#fff);font:inherit;cursor:pointer}.status{font-size:13px;min-height:20px}.hint{font-size:12px;opacity:.7}
</style></head><body><main class="formwrap">
<nav style="font-size:12px;margin-bottom:20px"><a href="/">Home</a> › <span>Submit a tool</span></nav>
<h1 style="font-size:26px;margin:0 0 8px">Submit an AI tool</h1>
<p class="hint">All submissions are reviewed before they appear in the directory. Please use the tool’s official HTTPS website.</p>
<form id="submit-form" novalidate>
<label>Name <input name="name" required maxlength="120" autocomplete="off"></label>
<label>Official URL <input name="url" type="url" required maxlength="500" placeholder="https://example.com"></label>
<label>Category <select name="category"><option value="">Choose a category</option><option>Assistants &amp; Agents</option><option>Coding &amp; Dev</option><option>Design &amp; Art</option><option>Video &amp; Animation</option><option>Voice &amp; Sound</option><option>Writing &amp; Content</option><option>Business &amp; Productivity</option><option>Data &amp; Automation</option><option>Education &amp; Research</option><option>Finance</option><option>Health</option><option>Other</option></select></label>
<label>Short description <textarea name="short_desc" maxlength="500" required></textarea></label>
<label>Pricing <select name="pricing"><option value="">Not verified</option><option value="free">Free</option><option value="freemium">Freemium</option><option value="paid">Paid</option></select></label>
<label>Email (optional) <input name="email" type="email" maxlength="200"></label>
<button type="submit">Send for review</button><div class="status" id="status" role="status"></div>
</form><p style="margin-top:24px;font-size:12px"><a href="/">← Back to the directory</a></p>
</main><script>
const form=document.getElementById('submit-form'),status=document.getElementById('status');
form.addEventListener('submit',async(e)=>{e.preventDefault();status.textContent='Sending…';const fd=new FormData(form),body=Object.fromEntries(fd.entries());if(!/^https?:\\/\\//i.test(body.url)){status.textContent='Please enter a valid HTTP(S) URL.';return;}try{const r=await fetch('${WORKER}/api/submit-tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Submission failed');form.reset();status.textContent='Thanks — your submission is now pending review.';}catch(err){status.textContent=err.message||'Could not submit right now.';}});
</script></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
