import fetch from 'node-fetch';
import fs from 'fs/promises';

async function findAPI() {
    const apiUrl = 'https://api.onstove.com/indie/v3.1/product/games';
    
    const params = new URLSearchParams({
        page: '1',
        size: '20',
        direction: 'LATEST',
        features: '99',
        lang: 'ko'
    });
    
    console.log('Testing API:', `${apiUrl}?${params}`);
    
    const response = await fetch(`${apiUrl}?${params}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'ko-KR,ko;q=0.9',
            'Origin': 'https://store.onstove.com',
            'Referer': 'https://store.onstove.com/'
        }
    });
    
    console.log('Status:', response.status);
    
    if (response.ok) {
        const data = await response.json();
        console.log('Response:', JSON.stringify(data, null, 2).substring(0, 3000));
        await fs.writeFile('stove_api_test.json', JSON.stringify(data, null, 2), 'utf-8');
    } else {
        console.log('Failed:', await response.text());
    }
}

findAPI().catch(console.error);
