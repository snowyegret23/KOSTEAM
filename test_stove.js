import fetch from 'node-fetch';
import fs from 'fs/promises';

const url = 'https://store.onstove.com/ko/store/search?direction=LATEST&features=99&page=1';

async function test() {
    console.log('Fetching:', url);
    
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9'
        }
    });
    
    console.log('Status:', response.status);
    
    if (response.ok) {
        const html = await response.text();
        console.log('HTML Length:', html.length);
        await fs.writeFile('stove_test.html', html, 'utf-8');
        console.log('Saved to stove_test.html');
        
        const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*(\(function\([^)]*\)\{return\s*\{[\s\S]*?\}\}\([^)]*\))/);
        if (nuxtMatch) {
            console.log('\n--- Found __NUXT__ data ---');
            console.log(nuxtMatch[1].substring(0, 2000));
        } else {
            console.log('\n--- No __NUXT__ found, checking for other patterns ---');
            
            const scriptMatches = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi);
            console.log('Found', scriptMatches ? scriptMatches.length : 0, 'script tags');
            
            if (html.includes('__NUXT__')) {
                const idx = html.indexOf('__NUXT__');
                console.log('__NUXT__ found at index:', idx);
                console.log('Context:', html.substring(idx - 50, idx + 500));
            }
        }
        
        console.log('\n--- First 3000 chars ---');
        console.log(html.substring(0, 3000));
    }
}

test().catch(console.error);
