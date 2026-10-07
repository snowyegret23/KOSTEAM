import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const samples = JSON.parse(await readFile('tests/fixtures/store-samples.json', 'utf8')).results;
const script = await readFile('dist/chrome/content.js', 'utf8');
const styles = await readFile('dist/chrome/styles.css', 'utf8');
const scenarios = [];
for (const sample of samples) {
    for (const [layout, width] of [['desktop', 1440], ['desktop', 412], ['gamepad', 1280], ['gamepad', 1920]]) {
        for (const language of ['koreana', 'english']) scenarios.push({ sample, layout, width, language });
    }
}
for (const sample of samples.filter(sample => sample.info?.source_site_urls?.quasarplay).slice(0, 5)) {
    scenarios.push({ sample, layout: 'gamepad', width: 1280, language: 'koreana', navigation: true });
}
const json = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const root = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>KOSTEAM browser regression</title>
<style>body{font:16px system-ui;margin:24px}iframe{position:absolute;left:0;top:140px;border:0;height:760px}pre{white-space:pre-wrap}</style>
<h1>KOSTEAM Chromium 렌더링 검증</h1><p>실제 브라우저의 DOM/CSS를 사용합니다. 확장 API와 Steam 초기 포커스 이벤트는 모의 응답입니다.</p>
<output id="status">실행 중</output><pre id="summary"></pre><script>
const scenarios=${json(scenarios.map(({ sample, ...scenario }) => ({ ...scenario, appId: sample.appId, expected: sample.expected })))};
const results=[];
(async()=>{
 for(let index=0;index<scenarios.length;index++){
  const scenario=scenarios[index],frame=document.createElement('iframe');
  frame.width=scenario.width;
  frame.src='/app/'+scenario.appId+'/?scenario='+index+(scenario.navigation?'&curator_clanid=42788178':'');
  document.body.append(frame);
  const result=await new Promise(resolve=>{
   const timer=setTimeout(()=>{window.removeEventListener('message',receive);resolve({pass:false,error:'Page timeout'});},10000);
   function receive(event){if(event.source!==frame.contentWindow||event.data?.scenario!==index)return;clearTimeout(timer);window.removeEventListener('message',receive);resolve(event.data);}
   window.addEventListener('message',receive);
  });
  results.push({...scenario,...result});frame.remove();
  document.querySelector('#status').textContent=(index+1)+' / '+scenarios.length;
 }
 const failed=results.filter(result=>!result.pass);
 document.title=failed.length?'FAIL - KOSTEAM browser regression':'PASS - KOSTEAM browser regression';
 document.querySelector('#summary').textContent=JSON.stringify({tests:results.length,pass:results.length-failed.length,fail:failed.length,failures:failed},null,2);
 await fetch('/results',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({browser:navigator.userAgent,generatedAt:new Date().toISOString(),results})});
})();</script></html>`;

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/results' && request.method === 'POST') {
            let raw = '';
            for await (const chunk of request) {
                raw += chunk;
                if (raw.length > 2_000_000) throw new Error('Report too large');
            }
            const report = JSON.parse(raw);
            if (!Array.isArray(report.results) || report.results.length !== scenarios.length) throw new Error('Incomplete browser report');
            await mkdir('test-results', { recursive: true });
            await writeFile('test-results/browser.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
            const failures = report.results.filter(result => !result.pass);
            console.log(JSON.stringify({ tests: report.results.length, pass: report.results.length - failures.length, failures }));
            response.end('Saved');
            process.exitCode = failures.length ? 1 : 0;
            server.close();
            return;
        }
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/') { response.end(root); return; }
        const index = Number(url.searchParams.get('scenario'));
        const scenario = scenarios[index];
        if (!scenario || url.pathname !== `/app/${scenario.sample.appId}/`) { response.writeHead(404); response.end(); return; }
        const { sample, layout, language, navigation } = scenario;
        const page = sample.pages.find(value => value.layout === layout && value.language === language);
        const setup = `Object.defineProperty(navigator,'userAgent',{value:${json(layout === 'gamepad' ? 'Mozilla/5.0 Valve Steam Gamepad' : 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36')}});
        window.chrome={runtime:{sendMessage:(message,callback)=>callback({success:true,info:${json(sample.info)}})},storage:{local:{get:(keys,callback)=>callback({})},onChanged:{addListener(){}}}};`;
        const check = `window.addEventListener('load',async()=>{
            const scenario=${index};
            const verify=(value,message)=>{if(!value)throw new Error(message)};
            try{
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                ${navigation ? `document.querySelector('#startup-focus').focus();document.querySelector('#startup-focus').dispatchEvent(new CustomEvent('vgp_onfocus',{bubbles:true,detail:{source:4}}));
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));` : ''}
                const banner=document.querySelector('.kr-patch-banner');verify(banner,'Banner missing');
                verify(document.querySelectorAll('.kr-patch-banner').length===1,'Duplicate banner');
                verify(banner.querySelector('.kr-patch-type-label').classList.contains(${json(sample.expected)}),'Wrong label');
                const rect=banner.getBoundingClientRect();verify(rect.width>0&&rect.height>0,'Banner hidden');
                verify(rect.left>=23&&rect.right<=innerWidth-23,'Banner outside content gutter: '+rect.left+' / '+rect.right);
                verify(banner.scrollWidth<=banner.clientWidth+1,'Banner content overflow');
                ${navigation ? `const review=document.querySelector('[data-featuretarget="referring-curator-review"]');
                verify(review.contains(document.activeElement),'Controller focus left review');
                verify(review.getBoundingClientRect().top>=0&&review.getBoundingClientRect().top<innerHeight,'Review left viewport');` : ''}
                parent.postMessage({scenario,pass:true,left:rect.left,right:rect.right,height:rect.height},location.origin);
            }catch(error){parent.postMessage({scenario,pass:false,error:error.message},location.origin);}
        });`;
        response.end(`<!doctype html><html lang="${page.lang}"><meta charset="utf-8"><style>${styles}
        *{box-sizing:border-box}body{margin:0;background:#1b2838;color:white;font:14px Arial}main{padding:24px;--horizontal-bleed-space:24px}
        .full_width_carousel_container{width:calc(100% + 48px);margin-left:-24px;margin-right:-24px}
        ${layout === 'gamepad' ? '#game_area_purchase{display:none}' : ''}
        aside{display:none}#gamepadPurchaseOptions{min-height:160px}#startup-focus{position:absolute;top:0}
        </style><body>${navigation ? '<button id="startup-focus">Trailer</button>' : ''}${page.html}
        ${navigation ? '<div style="height:1100px"></div><section data-featuretarget="referring-curator-review" style="padding:24px"><a href="#" tabindex="0">Curator</a><p>Review</p></section><div style="height:900px"></div>' : ''}
        <script>${setup}</script><script>${script}</script><script>${check}</script></body></html>`);
    } catch (error) { response.writeHead(500); response.end(error.message); }
});
server.listen(0, '127.0.0.1', () => console.log(`Open http://127.0.0.1:${server.address().port}/ to run ${scenarios.length} automatic rendering/navigation cases.`));
