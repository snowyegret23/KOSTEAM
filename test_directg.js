import fetch from 'node-fetch';
import fs from 'fs/promises';

const url = 'https://www.directg.net/game/game_search_thumb.html?page=1&sort=release&exclusive_korean=Y';

async function test() {
    console.log('Fetching:', url);
    
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://www.directg.net/'
        }
    });
    
    console.log('Status:', response.status);
    console.log('Headers:', Object.fromEntries(response.headers));
    
    const html = await response.text();
    console.log('HTML Length:', html.length);
    
    await fs.writeFile('directg_test.html', html, 'utf-8');
    console.log('Saved to directg_test.html');
    
    console.log('\n--- First 3000 chars ---');
    console.log(html.substring(0, 3000));
}

test().catch(console.error);
