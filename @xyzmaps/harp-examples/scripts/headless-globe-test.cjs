/**
 * Headless smoke test for rendering_globe-atmosphere.html
 * Run: NODE_PATH=/path/to/node_modules node scripts/headless-globe-test.cjs
 */
const puppeteer = require("puppeteer-core");

const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const baseUrl =
    process.env.BASE_URL || "http://127.0.0.1:8765/rendering_globe-atmosphere.html";

const criticalPatterns = [
    /already running.*CreateService/i,
    /Failed to connect to datasource.*terrain/i,
    /Failed to connect to datasource anonymous-datasource#1/i,
    /Multiple instances of Three\.js/i
];

async function main() {
    const collected = [];
    let fatal = false;

    function note(type, text) {
        collected.push({ type, text });
        for (const re of criticalPatterns) {
            if (re.test(text)) {
                fatal = true;
            }
        }
    }

    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            // Software GL so headless/CI can create a WebGL context when GPU is unavailable
            "--use-gl=angle",
            "--use-angle=swiftshader"
        ]
    });

    try {
        const page = await browser.newPage();
        page.on("console", msg => {
            const text = msg.text();
            const type = msg.type();
            if (type === "error" || type === "warning") {
                note(`console.${type}`, text);
            }
            if (type === "debug" && /Failed|already running|WorkerChannel/i.test(text)) {
                note("console.debug", text);
            }
        });
        page.on("pageerror", err => note("pageerror", err.message));

        const notFound = [];
        page.on("response", res => {
            if (res.status() === 404) {
                notFound.push(res.url());
            }
        });

        await page.goto(baseUrl, {
            waitUntil: "networkidle2",
            timeout: 120000
        });

        await new Promise(r => setTimeout(r, 10000));

        const filtered = collected.filter(
            c =>
                c.type.startsWith("console") ||
                c.type === "pageerror" ||
                criticalPatterns.some(re => re.test(c.text))
        );

        console.log("--- captured messages (subset) ---");
        for (const c of filtered.slice(0, 40)) {
            console.log(`[${c.type}] ${c.text.slice(0, 200)}`);
        }
        if (filtered.length > 40) {
            console.log(`... and ${filtered.length - 40} more`);
        }

        if (notFound.length) {
            console.log("--- HTTP 404 ---");
            notFound.forEach(u => console.log(u));
        }

        if (fatal) {
            console.error("\nFAIL: critical terrain/worker error pattern matched.");
            process.exitCode = 1;
        } else {
            console.log(
                "\nOK: no terrain worker connect errors, no duplicate Three.js warning, no fatal patterns."
            );
        }
    } finally {
        await browser.close();
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
