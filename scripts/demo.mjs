import { build } from 'esbuild';
import { createServer } from 'node:http';

const prUrl = 'https://github.com/acme/example/pull/12/files';
const files = [
  { path: 'README.md', additions: 2, deletions: 0 },
  { path: 'docs/review-guide.mdx', additions: 6, deletions: 1 },
  { path: 'backend/src/api/v1/commission/sync.ts', additions: 40, deletions: 12 },
  { path: 'backend/src/api/v1/commission/router.ts', additions: 18, deletions: 4 },
  { path: 'backend/src/api/v1/reservation/service.ts', additions: 25, deletions: 7 },
  { path: 'backend/src/db/schemas/reservation.ts', additions: 10, deletions: 3 },
  { path: 'frontend/src/app/dashboard/reservations/page.tsx', additions: 56, deletions: 20 },
  { path: 'frontend/src/app/dashboard/reservations/components/Table.tsx', additions: 24, deletions: 6 },
  { path: 'frontend/src/app/dashboard/reservations/hooks/useReservations.ts', additions: 12, deletions: 2 },
  { path: 'frontend/src/app/dashboard/reports/page.tsx', additions: 19, deletions: 8 },
  { path: 'frontend/src/app/dashboard/settings/page.tsx', additions: 11, deletions: 4 },
  { path: 'frontend/src/components/dashboard/Chart.tsx', additions: 21, deletions: 3 },
  { path: 'frontend/src/hooks/useFilters.ts', additions: 8, deletions: 1 },
  { path: 'frontend/src/fetchers/reservations.ts', additions: 13, deletions: 5 },
  { path: 'frontend/src/types/reservation.ts', additions: 9, deletions: 2 },
  { path: 'scripts/demo-data.ts', additions: 5, deletions: 0 },
  { path: 'tests/reservation.test.ts', additions: 14, deletions: 2 },
  { path: 'backend/src/db/migrations/001_example.sql', additions: 7, deletions: 0 },
  { path: 'packages/mira-api/src/routes/reservations.ts', additions: 31, deletions: 9 },
  { path: 'packages/mira-api/src/routes/reports.ts', additions: 17, deletions: 5 },
  { path: 'packages/mira-widgets/src/components/Button.tsx', additions: 320, deletions: 90 },
  { path: 'packages/mira-widgets/src/state.ts', additions: 25, deletions: 5 },
  { path: 'packages/mira-editor/src/App.tsx', additions: 560, deletions: 130 },
  { path: 'packages/mira-editor/src/components/Toolbar.tsx', additions: 120, deletions: 45 },
];
const anchor = index => `diff-${String(index + 1).padStart(64, '0')}`;
const escapeHTML = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const sampleCode = path => path.endsWith('.sql') ? ['ALTER TABLE reservations ADD COLUMN currency text;', 'ALTER TABLE reservations ADD COLUMN currency text NOT NULL DEFAULT \'USD\';'] :
  path.endsWith('.tsx') ? ['export const title = "Reservations";', 'export function ReservationCard() { return <button type="button">Reserve</button>; }'] :
  /\.mdx?$/.test(path) ? ['Review the reservation service.', 'Review currency validation, duplicate requests, and cancellation behavior.'] :
  path.includes('.test.') ? ['assert.equal(reservations.length, 0);', 'assert.equal(reservations.length, 1);'] :
  ['export const currency = input.currency;', 'export const currency = input.currency ?? "USD";'];
const metadata = { payload: { pullRequestsChangesRoute: {
  pullRequestUrl: prUrl,
  diffSummaries: files.map(({ path, additions, deletions }, index) => ({
    path, pathDigest: anchor(index).slice(5), changeType: 'MODIFIED',
    linesAdded: additions, linesDeleted: deletions,
  })),
} } };
const { outputFiles } = await build({ entryPoints:['src/content.tsx'], bundle:true, write:false, format:'iife', target:'chrome120', loader:{'.css':'text'}, define:{'process.env.NODE_ENV':'"production"', 'location.href':JSON.stringify(prUrl)} });
const shim = `
Object.defineProperty(document,'URL',{configurable:true,get:()=>${JSON.stringify(prUrl)}});
const listeners=new Set();
const read=()=>JSON.parse(localStorage.getItem('pr-reviewer-demo')||'{}');
let nonce=0,sampleAI=false;
const cancelled=new Set();
const notify=(key,value={})=>listeners.forEach(f=>f({[key]:{newValue:{...value,nonce:String(++nonce)}}},'session'));
const preferences=repository=>{const key='pr-reviewer:repo:'+repository.toLowerCase(),data=read(),overrides={},implementationOverrides={};for(const [name,value]of Object.entries(data)){if(name.startsWith(key+':file:'))overrides[name.slice((key+':file:').length)]=value;if(name.startsWith(key+':implementation:'))implementationOverrides[name.slice((key+':implementation:').length)]=value;}return{overrides,implementationOverrides,rules:data[key]?.rules||[]};};
document.querySelector('#demo-theme').addEventListener('click',()=>{document.documentElement.dataset.colorMode=document.documentElement.dataset.colorMode==='dark'?'light':'dark';});
document.querySelector('#demo-ai').addEventListener('click',()=>{sampleAI=!sampleAI;const button=document.querySelector('#demo-ai');button.textContent=sampleAI?'Disable sample AI':'Enable sample AI';button.setAttribute('aria-pressed',String(sampleAI));document.querySelector('#demo-ai-status').textContent=sampleAI?'Simulated AI enabled. No API key or OpenAI requests.':'Sample AI is off. No API key or OpenAI requests.';notify('pr-reviewer:ai-status-change');});
window.chrome={runtime:{sendMessage:async message=>{
  if(message.type==='ai-status')return{ok:true,status:{configured:sampleAI,enabled:sampleAI,model:'Simulated sample · no network',language:'en'}};
  if(message.type==='ai-open-settings'){document.querySelector('#demo-ai-status').textContent='Sample AI demo only. Use the sample AI toggle; no API key is accepted.';document.querySelector('#demo-ai').focus();return{ok:true};}
  if(message.type==='ai-cancel'){cancelled.add(message.requestId);return{ok:true};}
  if(message.type==='ai-review'){if(!sampleAI)return{ok:false,error:'Enable sample AI in the demo toolbar. No API key is used.'};await new Promise(resolve=>setTimeout(resolve,300));if(cancelled.delete(message.requestId))return{ok:false,error:'Sample review cancelled.'};const newLine={side:'right',line:1},oldLines=message.context.diff.includes('[old line 2]')?[{side:'left',line:2}]:[];return{ok:true,review:{summary:'Simulated review of the loaded sample diff. No request was sent to OpenAI.',highlights:[{text:'Simulated: the added line changes the default value or reservation interface.',lines:[newLine]}],focus:[{text:'Simulated: compare the previous behavior and verify existing callers.',lines:[...oldLines,newLine]},{text:'Simulated: add a regression for empty or missing input.',lines:[newLine]}]}};}
  if(message.type==='preferences-category'||message.type==='preferences-implementation'){const data=read(),key='pr-reviewer:repo:'+message.repository.toLowerCase()+':'+(message.type==='preferences-category'?'file':'implementation')+':'+message.path,value=message.type==='preferences-category'?message.category:message.group;if(value)data[key]=value;else delete data[key];localStorage.setItem('pr-reviewer-demo',JSON.stringify(data));notify('pr-reviewer:preferences-change',{repository:message.repository.toLowerCase()});return{ok:true,preferences:preferences(message.repository)};}
  if(message.type==='preferences-load')return{ok:true,preferences:preferences(message.repository)};
  return{ok:false,error:'Unsupported demo message.'};
}},storage:{local:{get:async()=>{throw new Error('Protected extension storage is unavailable in the demo page.');}},onChanged:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)}}};
`;
const html = `<!doctype html><html lang="en" data-color-mode="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local demo · PR Reviewer</title><style>
tr.deleted td{background:#ffebe9}tr.deleted td:first-child{background:#ffd7d5}
body{margin:0;background:#f6f8fa;color:#1f2328;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}header{background:#fff;border-bottom:1px solid #d8dee4;padding:24px 36px}header small{color:#636c76;font-size:12px}h1{font-size:23px;letter-spacing:-.4px;font-weight:600;margin:10px 0}nav{display:flex;gap:25px;margin-top:20px;font-size:13px}a{color:#0969da;text-decoration:none}nav a{color:#1f2328}.tabnav-tab{font-weight:600}#files_tab_counter{background:#eef1f4;padding:2px 6px;border-radius:10px;margin-left:5px}.demo{background:#ddf4ff;border-bottom:1px solid #b6e3ff;padding:10px 36px;color:#0969da;font-size:12px}main{padding:28px 36px;max-width:1100px}.js-file{background:#fff;border:1px solid #d8dee4;border-radius:8px;overflow:hidden;margin-bottom:22px;scroll-margin-top:24px}.file-header{display:flex;justify-content:space-between;padding:14px 18px;background:#f6f8fa;border-bottom:1px solid #d8dee4;font-size:12px}.file-header a{color:#1f2328;font-family:ui-monospace,monospace}.file-header label{color:#636c76}table{border-collapse:collapse;width:100%;font:12px/1.8 ui-monospace,monospace}td{padding:5px 15px;background:#dafbe1;white-space:pre-wrap}td:first-child{width:50px;color:#636c76;text-align:right;background:#ccffd8}.review{border-top:1px solid #d8dee4;padding:14px 18px}textarea{font:12px sans-serif;background:#f6f8fa;border:1px solid #d8dee4;padding:10px;border-radius:6px;width:100%;resize:vertical;min-height:65px}label{cursor:pointer}.hint{font-size:11px;color:#636c76;margin-bottom:8px;display:block}
</style><header><small>acme / <b>example</b> · Pull request</small><h1>Organize changes by area and module <span style="color:#636c76">#12</span></h1><small>${files.length} sample files · Backend, frontend, scripts, types, documentation, tests, and migrations</small><nav><span>Conversation</span><span>Commits</span><span>Checks</span><a class="tabnav-tab" href="${prUrl}">Files changed <span id="files_tab_counter" title="${files.length}">${files.length}</span></a></nav></header><div class="demo">Local demo with sample data · Counts and diffs are fictional examples. You can write a draft and mark files as Viewed. <button id="demo-theme" type="button">Switch theme</button> <button id="demo-ai" type="button" aria-pressed="false">Enable sample AI</button> <span id="demo-ai-status" role="status">Sample AI is off. No API key or OpenAI requests.</span></div><react-app app-name="repo" initial-path="/acme/example/pull/12/files"><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(metadata)}</script></react-app><main>${files.map(({path, additions, deletions},index)=>{const [before,after]=sampleCode(path);return`<section class="js-file" id="${anchor(index)}" data-tagsearch-path="${path}"><div class="file-header" data-path="${path}" data-anchor="${anchor(index)}"><a title="${path}" href="#${anchor(index)}">${path}</a><label><input type="checkbox" aria-label="Viewed: ${path}"> Viewed · +${additions} / −${deletions}</label></div><table aria-label="Diff for ${path}">${index === 0 ? `<thead><tr><th>Original file line number</th><th>Diff line number</th><th>Diff line change</th></tr></thead><tbody><tr><td></td><td>1</td><td><span class="diff-text-inner">${escapeHTML(after)}</span></td></tr></tbody>` : `<tr><td class="blob-num" data-line-number="1" id="${anchor(index)}R1">1</td><td class="blob-code blob-code-addition"><span class="blob-code-inner" data-code-marker="+">${escapeHTML(after)}</span></td></tr>`}${deletions ? `<tr class="deleted"><td class="blob-num" data-line-number="2" id="${anchor(index)}L2">2</td><td class="blob-code blob-code-deletion"><span class="blob-code-inner" data-code-marker="-">${escapeHTML(before)}</span></td></tr>` : ''}</table><div class="review"><label class="hint" for="draft-${index}">Local review draft</label><textarea id="draft-${index}" placeholder="Write a sample comment…"></textarea></div></section>`;}).join('')}</main><script src="/shim.js"></script><script src="/content.js"></script></html>`;
const server = createServer((request,response)=>{
  const path = new URL(request.url,'http://127.0.0.1').pathname;
  const content = path === '/' ? html : path === '/shim.js' ? shim : path === '/content.js' ? outputFiles[0].text : null;
  response.writeHead(content === null ? 404 : 200, {'Content-Type':path.endsWith('.js') ? 'text/javascript;charset=utf-8' : 'text/html;charset=utf-8','Cache-Control':'no-store'});
  response.end(content ?? 'Not found');
});
server.listen(4173,'127.0.0.1',()=>console.log('Local demo: http://127.0.0.1:4173'));
