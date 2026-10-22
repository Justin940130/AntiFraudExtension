console.log("Anti-Fraud Extension Loaded.");

const processedMessages = new Set();
const hostname = window.location.hostname;
let messageSelector = "";

// 暖機開關：前 3 秒載入的當作「歷史訊息」，不送 API 避免 429 錯誤
let isReadyToAnalyze = false;
setTimeout(() => {
    isReadyToAnalyze = true;
    console.log("暖機完畢！開始針對新訊息進行分析。");
}, 3000); // 3000 毫秒 = 3 秒

// 根據不同網域設定對應的 CSS 選擇器
if (hostname.includes("messenger.com")) {
    messageSelector = 'div[role="presentation"] span[dir="auto"] > div[dir="auto"]'; 
} else if (hostname.includes("web.line.me")) {
    messageSelector = ".text-content"; 
} else if (hostname.includes("web.whatsapp.com")) {
    messageSelector = "span.selectable-text"; 
}

if (messageSelector !== "") {
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const elements = node.querySelectorAll(messageSelector); 
                    
                    elements.forEach((el) => {
                        const text = el.innerText ? el.innerText.trim() : "";
                        
                        if (text.length > 0 && text.length < 1000 && !processedMessages.has(text)) {
                            // 只要出現在畫面上，就加入已處理清單
                            processedMessages.add(text);
                            
                            // 如果是剛開網頁瞬間塞進來的歷史訊息，就直接跳過不送 API
                            if (!isReadyToAnalyze) {
                                return; 
                            }

                            console.log(`【${hostname} 攔截新訊息】:`, text);

                            fetch('http://127.0.0.1:5000/analyze', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    id: Date.now().toString(),
                                    text: text
                                })
                            })
                            .then(response => response.json())
                            .then(data => {
                                // 將 AI 回傳的風險等級轉小寫並去空白，確保比對準確
                                if (String(data.risk_level).toLowerCase().trim() === "high") {
                                    // 1. 更改原始訊息容器的視覺樣式
                                    el.style.backgroundColor = "#ffe6e6";
                                    el.style.border = "2px solid red";
                                    el.style.borderRadius = "8px";
                                    el.style.padding = "5px";

                                    // 2. 建立警告文字區塊
                                    const warningMsg = document.createElement("div");
                                    warningMsg.style.color = "red";
                                    warningMsg.style.fontSize = "12px";
                                    warningMsg.style.fontWeight = "bold";
                                    warningMsg.style.marginTop = "5px";
                                    
                                    // 擷取前 10 個字作為提示，幫助對照是哪一句話被標記
                                    const previewText = text.length > 10 ? text.substring(0, 10) + "..." : text;
                                    warningMsg.innerText = `⚠️ [${data.category}] 系統偵測到可疑內容：「${previewText}」`;

                                    // 3. 將警告插入到訊息下方
                                    el.appendChild(warningMsg);
                                }
                            })
                            .catch(error => console.error("【與後端連線失敗】:", error));
                        }
                    });
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log(`已啟動 ${hostname} 的訊息監聽，選擇器為: ${messageSelector}`);
} else {
    console.log("未知的通訊平台，不啟動監聽。");
}