
console.log("Anti-Fraud Extension Loaded.");

const hostname = window.location.hostname;
const API_URL = "http://127.0.0.1:5000/analyze";

let messageSelector = "";

if (hostname.includes("messenger.com")) {
    messageSelector =
        'div[role="presentation"] span[dir="auto"] > div[dir="auto"]';
} else if (hostname.includes("instagram.com")) {
    messageSelector = 'div[aria-roledescription="message"] span[dir="auto"] > div[dir="auto"]'; 
} else if (hostname.includes("web.whatsapp.com")) {
    messageSelector = "span.selectable-text";
}

// 每個 DOM 元素分別記錄
const processedElements = new WeakMap();

// 同一段文字的分析結果可以重複使用
const resultCache = new Map();

// 避免相同內容在短時間內重複呼叫 API
const pendingRequests = new Map();

let isReady = false;
let scanTimer = null;


const visibilityObserver = new IntersectionObserver((entries) => {
    if (!isReady) return;

    entries.forEach(entry => {
        if (entry.isIntersecting) {
            console.log("訊息進入可視範圍");

            handleMessage(entry.target);
        }
    });
}, {
    threshold: 0.1
});


// 使用 CSS 標示，讓警告不會混入訊息文字
const style = document.createElement("style");
style.textContent = `
[data-antifraud-risk="high"] {
    background-color: #ffe6e6 !important;
    color: #222 !important;
    border: 2px solid red !important;
    border-radius: 8px !important;
    padding: 5px !important;
}

[data-antifraud-risk="high"]::after {
    content: attr(data-antifraud-warning);
    display: block;
    color: red;
    font-size: 12px;
    font-weight: bold;
    margin-top: 5px;
    white-space: normal;
}
`;
(document.head || document.documentElement).appendChild(style);

function markMessage(el, result) {
    if (!el.isConnected) return;

    if (String(result.risk_level).toLowerCase().trim() !== "high") {
        return;
    }

    const category = String(result.category || "可疑訊息");

    el.setAttribute("data-antifraud-risk", "high");
    el.setAttribute(
        "data-antifraud-warning",
        `⚠️ [${category}] 系統偵測到高風險內容`
    );

    console.log("已標示高風險訊息：", category);
}

async function analyzeText(text) {
    // 已有結果，直接使用
    if (resultCache.has(text)) {
        return resultCache.get(text);
    }

    // 同一段文字正在分析，不重複送出
    if (pendingRequests.has(text)) {
        return pendingRequests.get(text);
    }

    const requestPromise = (async () => {
        const start = performance.now();

        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                id: Date.now().toString(),
                text: text
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();

        const seconds = (
            (performance.now() - start) / 1000
        ).toFixed(2);

        console.log(`分析完成，耗時 ${seconds} 秒：`, result);

        if (
            ["high", "medium", "low"].includes(
                String(result.risk_level).toLowerCase()
            ) &&
            result.category !== "錯誤"
        ) {
            resultCache.set(text, result);
        }

        return result;
    })();

    pendingRequests.set(text, requestPromise);

    try {
        return await requestPromise;
    } finally {
        pendingRequests.delete(text);
    }
}

function handleMessage(el) {
    const text = (el.innerText || "").trim();

    if (!text || text.length >= 1000) return;

    // 如果這個元素的文字沒有改變，不需要重複處理
    if (processedElements.get(el) === text) return;

    processedElements.set(el, text);

    // 已知結果立即套用，包括重新渲染的元素
    if (resultCache.has(text)) {
        markMessage(el, resultCache.get(text));
        return;
    }

    if (!isReady) return;

    console.log("偵測到訊息：", text);

    analyzeText(text)
        .then(result => {
            // 原本元素仍存在且文字未改變才直接標示
            if (
                el.isConnected &&
                processedElements.get(el) === text
            ) {
                markMessage(el, result);
            }

            // AI 回來時原本元素可能已被替換
            // 再掃描一次，為新元素套用快取結果
            scheduleScan();
        })
        .catch(error => {
            console.error("分析失敗：", error);
        });
}


function scanMessages() {
    if (!messageSelector) return;

    const elements = document.querySelectorAll(messageSelector);

    elements.forEach(el => {
        // 讓 IntersectionObserver 追蹤訊息元素
        visibilityObserver.observe(el);
    });
}

// 合併短時間內大量 DOM 變動，避免反覆掃描
function scheduleScan() {
    if (scanTimer !== null) return;

    scanTimer = setTimeout(() => {
        scanTimer = null;
        scanMessages();
    }, 100);
}


if (messageSelector) {

    const observer = new MutationObserver(() => {
        if (isReady) {
            scheduleScan();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    setTimeout(() => {
        isReady = true;

        console.log("暖機完成，開始分析可見訊息");

        // 暖機完成後才開始觀察目前訊息
        scanMessages();

    }, 3000);

    console.log("訊息監聽已啟動：", messageSelector);
}

