import fetch from 'node-fetch';
import fs from 'fs/promises';

const url = 'https://quasarplay.com/bbs/qp_korean?page=1';

async function test() {
    console.log('Fetching:', url);
    
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0'
        }
    });
    
    console.log('Status:', response.status);
    console.log('Headers:', Object.fromEntries(response.headers));
    
    if (response.ok) {
        const html = await response.text();
        console.log('HTML Length:', html.length);
        await fs.writeFile('quasarplay_test.html', html, 'utf-8');
        console.log('Saved to quasarplay_test.html');
        console.log('\n--- First 2000 chars ---');
        console.log(html.substring(0, 2000));
    } else {
        const text = await response.text();
        console.log('Error response:', text.substring(0, 500));
    }
}

test().catch(console.error);
